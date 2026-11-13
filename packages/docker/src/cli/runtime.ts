/**
 * CLI transport for the Docker SDK.
 *
 * Commands are generated from Docker's published YAML reference. The runtime
 * builds argv vectors (never shell strings) and delegates process ownership,
 * cancellation and cleanup to Effect's ChildProcessSpawner and Scope.
 */
import * as A from "effect/Array";
import * as Bytes from "effect/Bytes";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Yaml from "effect/encoding/Yaml";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as R from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import type { CommandSpec } from "./contract.ts";

/** Contract for the metadata emitted by the official CLI spec generator. */
export { CommandSpecSchema, FlagSpecSchema } from "./contract.ts";
export type { CommandSpec, FlagSpec } from "./contract.ts";

export const CommandInputBaseSchema = Schema.Struct({
  args: Schema.optional(Schema.Array(Schema.String)),
  context: Schema.optional(Schema.String),
});
/** The generated operation supplies its own Schema-validated flag structure. */
export type CommandInput<Flags extends object> = Schema.Schema.Type<
  typeof CommandInputBaseSchema
> & {
  readonly flags?: Flags;
};

export const CommandResultSchema = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Int,
});
export type CommandResult = Schema.Schema.Type<typeof CommandResultSchema>;

export const CommandChunkSchema = Schema.Struct({
  channel: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
});
export type CommandChunk = Schema.Schema.Type<typeof CommandChunkSchema>;

export const BinaryCommandResultSchema = Schema.Struct({
  stdout: Schema.Uint8Array,
  stderr: Schema.String,
  exitCode: Schema.Int,
});
export type BinaryCommandResult = Schema.Schema.Type<typeof BinaryCommandResultSchema>;

export const CommandByteChunkSchema = Schema.Struct({
  channel: Schema.Literals(["stdout", "stderr"]),
  bytes: Schema.Uint8Array,
});
export type CommandByteChunk = Schema.Schema.Type<typeof CommandByteChunkSchema>;

const CliTransportSettingsSchema = Schema.Struct({
  bin: Schema.optional(Schema.String),
  env: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Redacted(Schema.String)])),
  ),
});

/** Serializable CLI invocation settings; process streams remain Effect values. */
export const CommandExecutionOptionsSchema = Schema.Struct({
  ...CliTransportSettingsSchema.fields,
  checkSupport: Schema.optional(Schema.Boolean),
});

export type CommandExecutionOptions = Schema.Schema.Type<typeof CommandExecutionOptionsSchema> & {
  /** Allows docker login --password-stdin, docker secret create, and similar commands. */
  readonly stdin?: Stream.Stream<Uint8Array>;
  /** Preserve caller-defined streaming log/observability behavior. */
  readonly stdoutTap?: (
    stream: Stream.Stream<string, PlatformError.PlatformError>,
  ) => Stream.Stream<string, PlatformError.PlatformError>;
  readonly stderrTap?: (
    stream: Stream.Stream<string, PlatformError.PlatformError>,
  ) => Stream.Stream<string, PlatformError.PlatformError>;
};

/** Override the executable (e.g. podman) or ambient environment per fiber. */
export const CliSettingsSchema = Schema.Struct({
  ...CliTransportSettingsSchema.fields,
  context: Schema.optional(Schema.String),
});
export const CliSettings = Context.Reference<Schema.Schema.Type<typeof CliSettingsSchema>>(
  "distilled/Docker/CliSettings",
  { defaultValue: () => ({}) },
);

/** Testable, fiber-local execution probe; emits no arguments or secret values. */
export const CliExecutionProbe = Context.Reference<() => Effect.Effect<void>>(
  "distilled/Docker/CliExecutionProbe",
  { defaultValue: () => () => Effect.void },
);

export class DockerCliInputError extends Schema.TaggedError<DockerCliInputError>()(
  "DockerCliInputError",
  {
    option: Schema.String,
    message: Schema.String,
  },
) {}

export class DockerCliExitError extends Schema.TaggedError<DockerCliExitError>()(
  "DockerCliExitError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    /** Docker stderr may contain credentials; never serialize its contents. */
    stderr: Schema.Redacted(Schema.String),
  },
) {}

export class DockerCliDecodeError extends Schema.TaggedError<DockerCliDecodeError>()(
  "DockerCliDecodeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class DockerCliUnsupportedError extends Schema.TaggedError<DockerCliUnsupportedError>()(
  "DockerCliUnsupportedError",
  {
    command: Schema.String,
    reason: Schema.Literals(["command", "flag"]),
    flag: Schema.optional(Schema.String),
  },
) {}

export const DockerCliCapabilitySchema = Schema.Struct({
  command: Schema.String,
  available: Schema.Boolean,
  flags: Schema.Array(Schema.String),
});
export type DockerCliCapability = Schema.Schema.Type<typeof DockerCliCapabilitySchema>;

/**
 * Serialize decoded flag values without treating user input as shell syntax.
 * Docker uses one argument per value, and map values require stable key order
 * for deterministic plans and diagnostics.
 */
const flagArguments = (name: string, value: unknown): ReadonlyArray<string> =>
  Match.value(value).pipe(
    Match.when(
      (value: unknown): value is boolean => typeof value === "boolean",
      (value) => [value ? name : `${name}=false`],
    ),
    Match.when(A.isArray, (values) => A.flatMap(values, (value) => [name, String(value)])),
    Match.when(
      (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null,
      (record) =>
        A.flatMap(
          A.sortWith(R.toEntries(record), ([key]) => key, Order.String),
          ([key, value]) => [name, `${key}=${String(value)}`],
        ),
    ),
    Match.orElse((value) => [name, String(value)]),
  );

/**
 * Serialize validated flag values. False must be explicit: a bare boolean
 * false otherwise silently turns into "flag absent", which is not equivalent
 * for options such as --ipv4=false.
 */
export const encodeArgs = (
  spec: CommandSpec,
  flags: object,
  args: ReadonlyArray<string> = [],
  context?: string,
): Effect.Effect<ReadonlyArray<string>, DockerCliInputError> =>
  Effect.gen(function* () {
    if (args.length < spec.minimumArgs) {
      return yield* Effect.fail(
        new DockerCliInputError({
          option: "args",
          message: `Docker CLI command requires at least ${spec.minimumArgs} positional argument(s)`,
        }),
      );
    }
    if (context !== undefined && context.trim() === "") {
      return yield* Effect.fail(
        new DockerCliInputError({ option: "context", message: "Context cannot be empty" }),
      );
    }

    const flagGroups = yield* Effect.forEach(R.toEntries(flags), ([field, value]) => {
      if (value === undefined) return Effect.succeed(A.empty<string>());
      const option = spec.flags[field];
      if (option === undefined) {
        return Effect.fail(
          new DockerCliInputError({ option: field, message: "Unknown Docker CLI flag" }),
        );
      }
      return Effect.succeed(flagArguments(`--${option.name}`, value));
    });

    // Explicitly delimit positional arguments, including names beginning
    // with "--", so user input never becomes an unexpected option.
    return [
      ...(context === undefined ? [] : ["--context", context]),
      ...spec.command,
      ...A.flatten(flagGroups),
      ...(args.length === 0 ? [] : ["--", ...args]),
    ];
  });

const spawn = (argv: ReadonlyArray<string>, options?: CommandExecutionOptions) =>
  Effect.gen(function* () {
    const settings = yield* CliSettings;
    const probe = yield* CliExecutionProbe;
    // Explicit invocation > scoped settings > environment > Docker default.
    const fromEnvironment = yield* Config.String("DOCKER_BIN").pipe(
      Effect.orElseSucceed(() => "docker"),
    );
    const bin = options?.bin ?? settings.bin ?? fromEnvironment;
    yield* probe();
    return yield* ChildProcess.make(bin, argv, {
      stdin: options?.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: false,
      env: { ...settings.env, ...options?.env },
      extendEnv: true,
    });
  });

/** Own one process and concurrently drain stdout, stderr and its exit status. */
const collectCommand = <A>(
  argv: ReadonlyArray<string>,
  options: CommandExecutionOptions | undefined,
  stdout: (
    bytes: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  ) => Effect.Effect<A, PlatformError.PlatformError>,
) =>
  Effect.gen(function* () {
    const child = yield* spawn(argv, options);
    return yield* Effect.all(
      {
        exitCode: child.exitCode,
        stdout: stdout(child.stdout),
        stderr: child.stderr.pipe(
          Stream.decodeText,
          options?.stderrTap ?? ((stream) => stream),
          Stream.mkString,
        ),
      },
      { concurrency: 3 },
    );
  }).pipe(Effect.scoped);

/**
 * Raw process result, including nonzero exit codes. A provider can translate
 * the exit status to its own typed errors while sharing this single transport.
 */
export const runRaw = (argv: ReadonlyArray<string>, options?: CommandExecutionOptions) =>
  collectCommand(argv, options, (bytes) =>
    bytes.pipe(Stream.decodeText, options?.stdoutTap ?? ((stream) => stream), Stream.mkString),
  );

/**
 * Safely query capabilities of a particular Docker/Buildx/Compose executable.
 * The published Go/Cobra command reference can differ from an installed
 * release, OS or plugin. This operation never invokes a resource command.
 * Deliberately return names only, not untrusted help output or arguments.
 */
export const probeCommand = (
  spec: CommandSpec,
  options?: CommandExecutionOptions,
  context?: string,
) =>
  Effect.gen(function* () {
    const settings = yield* CliSettings;
    const targetContext = context ?? settings.context;
    const command = `docker ${spec.command.join(" ")}`;
    const result = yield* runRaw(
      [
        ...(targetContext === undefined ? [] : ["--context", targetContext]),
        ...spec.command,
        "--help",
      ],
      {
        bin: options?.bin,
        env: options?.env,
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    const advertised = Option.flatMap(
      Option.fromNullishOr(output.match(/(?:^|\r?\n)\s*Usage:\s*([^\r\n]+)/)?.[1]),
      (usage) => Option.fromNullishOr(usage.trim().match(/^docker(?:\s+[a-z][a-z0-9-]*)*/)?.[0]),
    );
    // A Go/Cobra alias can be delegated to a plugin: `docker build` and
    // `docker builder build` display the canonical `docker buildx build` help.
    // A missing command displays only its parent's help; that fails because
    // the last executable subcommand no longer matches the requested one.
    const available =
      result.exitCode === 0 &&
      Option.match(advertised, {
        onNone: () => false,
        onSome: (advertised) =>
          advertised === command ||
          (advertised !== "docker" &&
            Option.getOrUndefined(A.last(Str.split(advertised, " "))) ===
              Option.getOrUndefined(A.last(spec.command))),
      });
    const flags = A.dedupe(
      A.getSomes(
        A.map(
          A.fromIterable(
            output.matchAll(/^\s*(?:-[a-zA-Z0-9],\s*)?--([a-z][a-z0-9-]*)(?=\s|=|$)/gm),
          ),
          (match) => Option.fromNullishOr(match[1]),
        ),
      ),
    );
    return { command, available, flags } satisfies DockerCliCapability;
  });

/** Collect binary stdout without UTF-8 conversion. */
export const runRawBinary = (argv: ReadonlyArray<string>, options?: CommandExecutionOptions) =>
  collectCommand(argv, options, (bytes) => Effect.map(Stream.runCollect(bytes), Bytes.concat));

/** Both text and binary CLI modes share the same typed exit contract. */
const requireSuccess = <A extends { readonly exitCode: number; readonly stderr: string }>(
  result: A,
): Effect.Effect<A, DockerCliExitError> =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(
        new DockerCliExitError({
          // Arguments may contain credentials; never include them in errors.
          command: "docker",
          exitCode: result.exitCode,
          stderr: Redacted.make(result.stderr),
        }),
      );

/** Collects command output in memory; use runStream for long-running operations. */
export const run = (
  argv: ReadonlyArray<string>,
  options?: CommandExecutionOptions,
): Effect.Effect<
  CommandResult,
  DockerCliExitError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> => Effect.flatMap(runRaw(argv, options), requireSuccess);

/** Execute commands that produce archives or other opaque binary output. */
export const runBinary = (argv: ReadonlyArray<string>, options?: CommandExecutionOptions) =>
  Effect.flatMap(runRawBinary(argv, options), requireSuccess);

/**
 * Own the process and stderr tail once for both output modes. Each caller
 * independently decodes stdout and stderr, preserving UTF-8 boundaries while
 * retaining binary output byte-for-byte.
 */
const streamCommand = <A>(
  argv: ReadonlyArray<string>,
  options: CommandExecutionOptions | undefined,
  channels: (
    stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
    stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  ) => Stream.Stream<A, PlatformError.PlatformError>,
) =>
  Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const child = yield* spawn(argv, options);
        const stderrTail = yield* Ref.make(new Uint8Array());
        const stderr = child.stderr.pipe(
          Stream.tap((bytes) =>
            Ref.update(stderrTail, (tail) => Bytes.concat([tail, bytes]).slice(-8192)),
          ),
        );
        const checkExit = Stream.fromEffectDrain(
          Effect.gen(function* () {
            const exitCode = yield* child.exitCode;
            if (exitCode !== 0) {
              const stderrText = yield* Ref.get(stderrTail).pipe(
                Effect.flatMap((bytes) => Stream.mkString(Stream.decodeText(Stream.make(bytes)))),
              );
              return yield* Effect.fail(
                new DockerCliExitError({
                  command: "docker",
                  exitCode,
                  stderr: Redacted.make(stderrText),
                }),
              );
            }
          }),
        );
        return Stream.concat(channels(child.stdout, stderr), checkExit);
      }),
    ),
  );

/**
 * Stream stdout/stderr as they arrive without buffering a build's full log.
 * The Effect Scope owns the process, including cancellation and cleanup.
 */
export const runStream = (argv: ReadonlyArray<string>, options?: CommandExecutionOptions) =>
  streamCommand(argv, options, (stdout, stderr) =>
    Stream.merge(
      stdout.pipe(
        Stream.decodeText,
        options?.stdoutTap ?? ((stream) => stream),
        Stream.map((text): CommandChunk => ({ channel: "stdout", text })),
      ),
      stderr.pipe(
        Stream.decodeText,
        options?.stderrTap ?? ((stream) => stream),
        Stream.map((text): CommandChunk => ({ channel: "stderr", text })),
      ),
    ),
  );

/** Stream unmodified byte chunks, preserving binary CLI stdout and stderr. */
export const runBinaryStream = (argv: ReadonlyArray<string>, options?: CommandExecutionOptions) =>
  streamCommand(argv, options, (stdout, stderr) =>
    Stream.merge(
      stdout.pipe(Stream.map((bytes): CommandByteChunk => ({ channel: "stdout", bytes }))),
      stderr.pipe(Stream.map((bytes): CommandByteChunk => ({ channel: "stderr", bytes }))),
    ),
  );

/** Decode arguments using generated Effect Schemas before invoking Docker. */
const commandArgs = <Input extends CommandInput<object>>(
  spec: CommandSpec,
  schema: Schema.Schema<Input>,
  input: Input,
  options?: CommandExecutionOptions,
) =>
  Effect.gen(function* () {
    const settings = yield* CliSettings;
    const decoded = yield* Schema.decodeUnknownEffect(schema, {
      onExcessProperty: "error",
    })(input).pipe(
      // Schema diagnostics may render input values, including secrets. The
      // typed public failure deliberately excludes those values.
      Effect.mapError(
        () =>
          new DockerCliInputError({
            option: "input",
            message: "Docker CLI input does not match the generated command schema",
          }),
      ),
    );
    const argv = yield* encodeArgs(
      spec,
      decoded.flags ?? {},
      decoded.args ?? [],
      decoded.context ?? settings.context,
    );
    if (options?.checkSupport === true) {
      const capability = yield* probeCommand(spec, options, decoded.context ?? settings.context);
      if (!capability.available) {
        return yield* Effect.fail(
          new DockerCliUnsupportedError({
            command: capability.command,
            reason: "command",
          }),
        );
      }
      const unsupported = A.getSomes(
        A.map(R.toEntries(decoded.flags ?? {}), ([property, value]) => {
          const name = spec.flags[property]?.name;
          return value !== undefined && name !== undefined && !capability.flags.includes(name)
            ? Option.some(name)
            : Option.none();
        }),
      );
      const unsupportedFlag = A.head(unsupported);
      if (Option.isSome(unsupportedFlag)) {
        return yield* Effect.fail(
          new DockerCliUnsupportedError({
            command: capability.command,
            reason: "flag",
            flag: unsupportedFlag.value,
          }),
        );
      }
    }
    return argv;
  });

/** Execute a generated CLI operation and return its collected output. */
export const invoke = <Input extends CommandInput<object>>(
  spec: CommandSpec,
  schema: Schema.Schema<Input>,
  input: Input,
  options?: CommandExecutionOptions,
) =>
  Effect.flatMap(commandArgs(spec, schema, input, options), (argv) =>
    run(argv, options).pipe(
      Effect.mapError((error) =>
        error instanceof DockerCliExitError
          ? new DockerCliExitError({
              command: `docker ${spec.command.join(" ")}`,
              exitCode: error.exitCode,
              stderr: error.stderr,
            })
          : error,
      ),
    ),
  );

/** Execute a generated CLI operation as an interruptible event stream. */
export const invokeStream = <Input extends CommandInput<object>>(
  spec: CommandSpec,
  schema: Schema.Schema<Input>,
  input: Input,
  options?: CommandExecutionOptions,
) =>
  Stream.unwrap(
    Effect.map(commandArgs(spec, schema, input, options), (argv) =>
      runStream(argv, options).pipe(
        Stream.mapError((error) =>
          error instanceof DockerCliExitError
            ? new DockerCliExitError({
                command: `docker ${spec.command.join(" ")}`,
                exitCode: error.exitCode,
                stderr: error.stderr,
              })
            : error,
        ),
      ),
    ),
  );

export const parseJson = (output: CommandResult) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(output.stdout).pipe(
    // Schema's parse diagnostics can quote the input, including credentials.
    Effect.mapError(() => new DockerCliDecodeError({ message: "Invalid Docker CLI JSON" })),
  );

/** Decode a Docker CLI JSON Lines output with the caller's explicit schema. */
export const decodeJsonLines = <A>(output: CommandResult, schema: Schema.Schema<A>) =>
  Effect.forEach(
    A.getSomes(
      A.map(Str.split(output.stdout, /\r?\n/), (line, index) =>
        Str.trim(line) === "" ? Option.none() : Option.some({ line, lineNumber: index + 1 }),
      ),
    ),
    ({ line, lineNumber }) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(line).pipe(
        Effect.mapError(
          () =>
            new DockerCliDecodeError({
              message: `Invalid Docker CLI JSON or schema at line ${lineNumber}`,
            }),
        ),
      ),
  );

/** Decode YAML output (e.g. `docker compose config`) with Effect Schema. */
export const decodeYaml = <A>(output: CommandResult, schema: Schema.Schema<A>) =>
  Effect.flatMap(
    Effect.try({
      try: () => Yaml.parse(output.stdout),
      catch: () => new DockerCliDecodeError({ message: "Invalid Docker CLI YAML" }),
    }),
    (yaml) =>
      Schema.decodeUnknownEffect(schema)(yaml).pipe(
        Effect.mapError(
          () =>
            new DockerCliDecodeError({
              message: "Docker CLI YAML does not match the requested schema",
            }),
        ),
      ),
  );
