/**
 * CLI transport for the Docker SDK.
 *
 * Commands are generated from Docker's published YAML reference. The runtime
 * builds argv vectors (never shell strings) and delegates process ownership,
 * cancellation and cleanup to Effect's ChildProcessSpawner and Scope.
 */
import * as Bytes from "effect/Bytes";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Yaml from "effect/encoding/Yaml";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** Contract for the metadata emitted by the official CLI spec generator. */
export const FlagSpecSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  shorthand: Schema.optional(Schema.String),
  defaultValue: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  minApiVersion: Schema.optional(Schema.String),
  osType: Schema.optional(Schema.String),
  deprecated: Schema.optional(Schema.Boolean),
  experimental: Schema.optional(Schema.Boolean),
});
export type FlagSpec = Schema.Schema.Type<typeof FlagSpecSchema>;

export const CommandSpecSchema = Schema.Struct({
  command: Schema.Array(Schema.String),
  usage: Schema.String,
  flags: Schema.Record(Schema.String, FlagSpecSchema),
  minimumArgs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CommandSpec = Schema.Schema.Type<typeof CommandSpecSchema>;

export interface CommandInput<Flags extends object> {
  readonly flags?: Flags;
  /** Positional arguments, in the order documented by Docker. */
  readonly args?: ReadonlyArray<string>;
  /** The Docker context, passed as a global CLI flag. */
  readonly context?: string;
}

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

/** Effect-native execution settings for a single Docker CLI invocation. */
export interface CommandExecutionOptions {
  readonly bin?: string;
  /** Preflight command/flag availability against the installed CLI; opt-in to avoid extra processes. */
  readonly checkSupport?: boolean;
  /** Passed directly to ChildProcess, which preserves Effect Redacted values. */
  readonly env?: Readonly<Record<string, string | Redacted.Redacted<string>>>;
  /** Allows docker login --password-stdin, docker secret create, and similar commands. */
  readonly stdin?: Stream.Stream<Uint8Array>;
  /** Preserve caller-defined streaming log/observability behavior. */
  readonly stdoutTap?: (
    stream: Stream.Stream<string, PlatformError.PlatformError>,
  ) => Stream.Stream<string, PlatformError.PlatformError>;
  readonly stderrTap?: (
    stream: Stream.Stream<string, PlatformError.PlatformError>,
  ) => Stream.Stream<string, PlatformError.PlatformError>;
}

/** Override the executable (e.g. podman) or ambient environment per fiber. */
export const CliSettings = Context.Reference<{
  readonly bin?: string;
  readonly context?: string;
  readonly env?: Readonly<Record<string, string | Redacted.Redacted<string>>>;
}>("distilled/Docker/CliSettings", { defaultValue: () => ({}) });

/** Testable, fiber-local execution probe; emits no arguments or secret values. */
export const CliExecutionProbe = Context.Reference<() => Effect.Effect<void>>(
  "distilled/Docker/CliExecutionProbe",
  { defaultValue: () => () => Effect.void },
);

export class DockerCliInputError extends Data.TaggedError("DockerCliInputError")<{
  readonly option: string;
  readonly message: string;
}> {}

export class DockerCliExitError extends Data.TaggedError("DockerCliExitError")<{
  readonly command: string;
  readonly exitCode: number;
  /** Docker's stderr can echo secrets: explicit opt-in is required to inspect it. */
  readonly stderr: Redacted.Redacted<string>;
}> {}

export class DockerCliDecodeError extends Data.TaggedError("DockerCliDecodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DockerCliUnsupportedError extends Data.TaggedError("DockerCliUnsupportedError")<{
  readonly command: string;
  readonly reason: "command" | "flag";
  readonly flag?: string;
}> {}

export const DockerCliCapabilitySchema = Schema.Struct({
  command: Schema.String,
  available: Schema.Boolean,
  flags: Schema.Array(Schema.String),
});
export type DockerCliCapability = Schema.Schema.Type<typeof DockerCliCapabilitySchema>;

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
    const argv: string[] = [];
    if (context !== undefined) {
      if (context.trim() === "") {
        return yield* Effect.fail(
          new DockerCliInputError({ option: "context", message: "Context cannot be empty" }),
        );
      }
      argv.push("--context", context);
    }
    argv.push(...spec.command);

    for (const [field, value] of Object.entries(flags)) {
      if (value === undefined) continue;
      const option = spec.flags[field];
      if (option === undefined) {
        return yield* Effect.fail(
          new DockerCliInputError({ option: field, message: "Unknown Docker CLI flag" }),
        );
      }
      const name = `--${option.name}`;
      if (option.type === "bool") {
        argv.push(value === true ? name : `${name}=false`);
      } else if (Array.isArray(value)) {
        for (const entry of value) argv.push(name, String(entry));
      } else if (typeof value === "object" && value !== null) {
        for (const [key, entry] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
          argv.push(name, `${key}=${String(entry)}`);
        }
      } else {
        argv.push(name, String(value));
      }
    }

    // Explicitly delimit positional arguments, including names beginning
    // with "--", so user input never becomes an unexpected option.
    if (args.length > 0) argv.push("--", ...args);
    return argv;
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

/**
 * Raw process result, including nonzero exit codes. A provider can translate
 * the exit status to its own typed errors while sharing this single transport.
 */
export const runRaw = (argv: ReadonlyArray<string>, options?: CommandExecutionOptions) =>
  Effect.gen(function* () {
    const child = yield* spawn(argv, options);
    return yield* Effect.all(
      {
        exitCode: child.exitCode,
        stdout: child.stdout.pipe(
          Stream.decodeText,
          options?.stdoutTap ?? ((stream) => stream),
          Stream.mkString,
        ),
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
    const usage = output.match(/(?:^|\r?\n)\s*Usage:\s*([^\r\n]+)/)?.[1]?.trim();
    const advertised = usage?.match(/^docker(?:\s+[a-z][a-z0-9-]*)*/)?.[0];
    // A Go/Cobra alias can be delegated to a plugin: `docker build` and
    // `docker builder build` display the canonical `docker buildx build` help.
    // A missing command displays only its parent's help; that fails because
    // the last executable subcommand no longer matches the requested one.
    const available =
      result.exitCode === 0 &&
      advertised !== undefined &&
      (advertised === command ||
        (advertised !== "docker" && advertised.split(" ").at(-1) === spec.command.at(-1)));
    const flags = Array.from(
      new Set(
        Array.from(
          output.matchAll(/^\s*(?:-[a-zA-Z0-9],\s*)?--([a-z][a-z0-9-]*)(?=\s|=|$)/gm),
          (match) => match[1]!,
        ),
      ),
    );
    return { command, available, flags } satisfies DockerCliCapability;
  });

/** Collect binary stdout without UTF-8 conversion. */
export const runRawBinary = (argv: ReadonlyArray<string>, options?: CommandExecutionOptions) =>
  Effect.gen(function* () {
    const child = yield* spawn(argv, options);
    const result = yield* Effect.all(
      {
        exitCode: child.exitCode,
        stdout: Stream.runCollect(child.stdout),
        stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
      },
      { concurrency: 3 },
    );
    return {
      stdout: Bytes.concat(result.stdout),
      stderr: result.stderr,
      exitCode: result.exitCode,
    } satisfies BinaryCommandResult;
  }).pipe(Effect.scoped);

/** Collects command output in memory; use runStream for long-running operations. */
export const run = (
  argv: ReadonlyArray<string>,
  options?: CommandExecutionOptions,
): Effect.Effect<
  CommandResult,
  DockerCliExitError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const result = yield* runRaw(argv, options);
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new DockerCliExitError({
          // Raw argv may include credentials. Do not place any argument into
          // diagnostics; the generated command name is known to invoke().
          command: "docker",
          exitCode: result.exitCode,
          stderr: Redacted.make(result.stderr),
        }),
      );
    }
    return result;
  });

/** Execute commands that produce archives or other opaque binary output. */
export const runBinary = (argv: ReadonlyArray<string>, options?: CommandExecutionOptions) =>
  Effect.flatMap(runRawBinary(argv, options), (result) =>
    result.exitCode === 0
      ? Effect.succeed(result)
      : Effect.fail(
          new DockerCliExitError({
            command: "docker",
            exitCode: result.exitCode,
            stderr: Redacted.make(result.stderr),
          }),
        ),
  );

/**
 * Stream stdout/stderr as they arrive without buffering a build's full log.
 * The Effect Scope owns the process, including cancellation and cleanup.
 */
export const runStream = (argv: ReadonlyArray<string>, options?: CommandExecutionOptions) =>
  Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const child = yield* spawn(argv, options);
        const stderrTail = yield* Ref.make("");
        const stdout = child.stdout.pipe(
          Stream.decodeText,
          Stream.map((text): CommandChunk => ({ channel: "stdout", text })),
        );
        const stderr = child.stderr.pipe(
          Stream.decodeText,
          Stream.tap((text) => Ref.update(stderrTail, (tail) => (tail + text).slice(-8192))),
          Stream.map((text): CommandChunk => ({ channel: "stderr", text })),
        );
        const checkExit = Stream.fromEffectDrain(
          Effect.gen(function* () {
            const exitCode = yield* child.exitCode;
            if (exitCode !== 0) {
              return yield* Effect.fail(
                new DockerCliExitError({
                  command: "docker",
                  exitCode,
                  stderr: Redacted.make(yield* Ref.get(stderrTail)),
                }),
              );
            }
          }),
        );
        return Stream.concat(Stream.merge(stdout, stderr), checkExit);
      }),
    ),
  );

/** Stream unmodified byte chunks, preserving binary CLI stdout and stderr. */
export const runBinaryStream = (argv: ReadonlyArray<string>, options?: CommandExecutionOptions) =>
  Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const child = yield* spawn(argv, options);
        const stderrTail = yield* Ref.make(new Uint8Array());
        const stdout = child.stdout.pipe(
          Stream.map((bytes): CommandByteChunk => ({ channel: "stdout", bytes })),
        );
        const stderr = child.stderr.pipe(
          Stream.tap((bytes) =>
            Ref.update(stderrTail, (tail) => Bytes.concat([tail, bytes]).slice(-8192)),
          ),
          Stream.map((bytes): CommandByteChunk => ({ channel: "stderr", bytes })),
        );
        const checkExit = Stream.fromEffectDrain(
          Effect.gen(function* () {
            const exitCode = yield* child.exitCode;
            if (exitCode !== 0) {
              return yield* Effect.fail(
                new DockerCliExitError({
                  command: "docker",
                  exitCode,
                  stderr: Redacted.make(new TextDecoder().decode(yield* Ref.get(stderrTail))),
                }),
              );
            }
          }),
        );
        return Stream.concat(Stream.merge(stdout, stderr), checkExit);
      }),
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
      for (const [property, value] of Object.entries(decoded.flags ?? {})) {
        if (value === undefined) continue;
        const name = spec.flags[property]?.name;
        if (name !== undefined && !capability.flags.includes(name)) {
          return yield* Effect.fail(
            new DockerCliUnsupportedError({
              command: capability.command,
              reason: "flag",
              flag: name,
            }),
          );
        }
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
    output.stdout.split(/\r?\n/).filter((line) => line.trim() !== ""),
    (line, index) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(line).pipe(
        Effect.mapError(
          () =>
            new DockerCliDecodeError({
              message: `Invalid Docker CLI JSON or schema at line ${index + 1}`,
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
