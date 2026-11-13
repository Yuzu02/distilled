import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Lite from "@distilled.cloud/core/schema-lite-impl";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import { minimumArgs } from "../scripts/cli-usage.ts";
import * as Cli from "../src/cli.ts";
import { containerCreateSpec, type ContainerCreateInput } from "../src/cli/generated.ts";
import * as Generated from "../src/cli/generated.ts";
import { omitAbsentOptionals } from "../src/cli/optional-null.ts";
import { encodeArgs } from "../src/cli/runtime.ts";
import * as Engine from "../src/index.ts";

describe("Docker CLI Effect SDK", () => {
  it("preserves Engine on the package root and exposes CLI explicitly", () => {
    expect(typeof Cli.containerCreate).toBe("function");
    expect(typeof Engine.containerInspect).toBe("function");
    expect(typeof Engine.imageInspect2).toBe("function");
  });

  it("generates one schema-first command for each mirrored official reference", () => {
    const specs = Object.entries(Generated).filter(
      ([name, value]) => name.endsWith("Spec") && typeof value === "object",
    );
    const inputs = Object.entries(Generated).filter(
      ([name, value]) => name.endsWith("InputSchema") && typeof value === "function",
    );
    expect(inputs).toHaveLength(specs.length);
    expect(Object.keys(Generated.dockerCliSourceRevisions).sort()).toEqual([
      "docker/compose",
      "docker/docs",
    ]);
    expect(
      Object.values(Generated.dockerCliSourceRevisions).every((sha) => /^[a-f0-9]{40}$/.test(sha)),
    ).toBe(true);
    expect(specs.map(([name]) => name)).toContain("serviceCreateSpec");
    expect(specs.map(([name]) => name)).toContain("buildxBuildSpec");
    expect(specs.length).toBeGreaterThan(200);
    for (const [, spec] of specs) {
      expect(() => Schema.decodeUnknownSync(Cli.CommandSpecSchema)(spec)).not.toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(Cli.FlagSpecSchema)({ name: "future-flag", type: "unrecognized" }),
    ).toThrow();
    expect(typeof Generated.dockerRun).toBe("function");
    expect(typeof Generated.dockerRunStream).toBe("function");
    expect(Generated.containerCreateSpec.usage).toContain("IMAGE");
    // `docker manifest` must not collide with the mirror's manifest.json index.
    expect(Generated.manifestSpec.command).toEqual(["manifest"]);
    expect(Generated.containerCreateSpec.flags.healthRetries.type).toBe("int");
    expect(Generated.containerCreateSpec.flags.rm.defaultValue).toBe("false");
  });

  it("infers required positionals without counting alternatives more than once", () => {
    const arity = (usage: string, command: string) => Effect.runSync(minimumArgs(usage, command));
    expect(
      arity(
        "docker container create [OPTIONS] IMAGE [COMMAND] [ARG...]",
        "docker container create",
      ),
    ).toBe(1);
    expect(
      arity("docker network connect [OPTIONS] NETWORK CONTAINER", "docker network connect"),
    ).toBe(2);
    expect(arity("docker compose up [OPTIONS] [SERVICE...]", "docker compose up")).toBe(0);
    expect(arity("docker buildx build [OPTIONS] PATH | URL | -", "docker buildx build")).toBe(1);
    expect(
      arity("docker image tag SOURCE_IMAGE[:TAG] TARGET_IMAGE[:TAG]", "docker image tag"),
    ).toBe(2);
    expect(
      arity("docker swarm join-token [OPTIONS] (worker|manager)", "docker swarm join-token"),
    ).toBe(1);
    expect(arity("docker buildx policy test <path>", "docker buildx policy test")).toBe(1);
    expect(
      arity(
        "docker compose cp [OPTIONS] SERVICE:SRC_PATH DEST_PATH|-\n\tdocker compose cp [OPTIONS] SRC_PATH|- SERVICE:DEST_PATH",
        "docker compose cp",
      ),
    ).toBe(2);
    expect(
      arity(
        "docker container cp [OPTIONS] CONTAINER:SRC_PATH DEST_PATH|-\n\tdocker cp [OPTIONS] SRC_PATH|- CONTAINER:DEST_PATH",
        "docker container cp",
      ),
    ).toBe(2);
    expect(
      Effect.runSync(
        Effect.flip(minimumArgs("docker create [OPTIONS] NAME", "docker container create")),
      ),
    ).toMatchObject({ _tag: "DockerCliUsageError", reason: "unknown-command" });
    expect(
      Effect.runSync(Effect.flip(minimumArgs("docker compose up [OPTIONS", "docker compose up"))),
    ).toMatchObject({ _tag: "DockerCliUsageError", reason: "unbalanced-brackets" });
  });

  it("rejects fractional, negative unsigned and out-of-range CLI numeric flags", () => {
    const decode = Schema.decodeUnknownSync(Generated.ContainerCreateFlags);
    expect(() => decode({ healthRetries: 1.5 })).toThrow();
    expect(() => decode({ blkioWeight: -1 })).toThrow();
    expect(() => decode({ blkioWeight: 65536 })).toThrow();
    expect(() => decode({ cpus: Number.POSITIVE_INFINITY })).toThrow();
    expect(decode({ healthRetries: 3, blkioWeight: 65535, cpus: 0.5 })).toEqual({
      healthRetries: 3,
      blkioWeight: 65535,
      cpus: 0.5,
    });
  });

  it("decodes JSON Lines and YAML with caller-supplied Effect Schemas", async () => {
    const lineShape = Schema.Struct({ ID: Schema.String, State: Schema.String });
    const rows = await Effect.runPromise(
      Cli.decodeJsonLines(
        {
          stdout: '{"ID":"a","State":"running"}\n{"ID":"b","State":"exited"}\n',
          stderr: "",
          exitCode: 0,
        },
        lineShape,
      ),
    );
    expect(rows).toEqual([
      { ID: "a", State: "running" },
      { ID: "b", State: "exited" },
    ]);

    // Diagnostics refer to the physical line number, including blank lines
    // that the JSONL reader deliberately skips.
    const malformed = await Effect.runPromise(
      Effect.flip(
        Cli.decodeJsonLines(
          {
            stdout: '\n{"ID":"a","State":"running"}\n\n{"ID":23,"State":"exited"}\n',
            stderr: "",
            exitCode: 0,
          },
          lineShape,
        ),
      ),
    );
    expect(malformed).toMatchObject({
      _tag: "DockerCliDecodeError",
      message: "Invalid Docker CLI JSON or schema at line 4",
    });

    const yamlShape = Schema.Struct({ services: Schema.Record(Schema.String, Schema.Unknown) });
    const config = await Effect.runPromise(
      Cli.decodeYaml(
        { stdout: "services:\n  api:\n    image: alpine:3.22\n", stderr: "", exitCode: 0 },
        yamlShape,
      ),
    );
    expect(config).toEqual({ services: { api: { image: "alpine:3.22" } } });
  });

  it("encodes booleans, repeated flags, map flags and positional arguments without shell syntax", () => {
    const argv = Effect.runSync(
      encodeArgs(
        containerCreateSpec,
        {
          rm: false,
          readOnly: true,
          env: ["FOO", "BAZ"],
          label: ["a=one", "z=two"],
          sysctl: { "z.diagnostic": "two", "a.diagnostic": "one" },
          mount: ["type=tmpfs,target=/cache", "type=bind,src=/tmp,dst=/work"],
        },
        ["postgres:18", "--an-argument"],
        "remote",
      ),
    );

    expect(argv).toEqual([
      "--context",
      "remote",
      "container",
      "create",
      "--rm=false",
      "--read-only",
      "--env",
      "FOO",
      "--env",
      "BAZ",
      "--label",
      "a=one",
      "--label",
      "z=two",
      "--sysctl",
      "a.diagnostic=one",
      "--sysctl",
      "z.diagnostic=two",
      "--mount",
      "type=tmpfs,target=/cache",
      "--mount",
      "type=bind,src=/tmp,dst=/work",
      "--",
      "postgres:18",
      "--an-argument",
    ]);
  });

  it("rejects unsupported flags before starting a process", async () => {
    const invalid = {
      args: ["postgres:18"],
      flags: { notAFlag: "bad" },
    } as unknown as ContainerCreateInput;

    const outcome = await Effect.runPromise(Effect.exit(Cli.containerCreate(invalid)));
    expect(Exit.isFailure(outcome)).toBe(true);
  });

  it("decodes generated input schemas without requiring the spec mirror during testing", () => {
    const decode = Schema.decodeUnknownSync(Generated.ContainerCreateInputSchema);
    expect(decode({ args: ["alpine:3.22"], flags: { env: ["KEY"], rm: false } })).toMatchObject({
      args: ["alpine:3.22"],
      flags: { env: ["KEY"], rm: false },
    });
    expect(() => decode({ args: ["alpine:3.22"], flags: { env: { KEY: "value" } } })).toThrow();
    expect(() => decode({ flags: { rm: true } })).toThrow();
  });

  it("rejects missing required args and malformed positional arguments", async () => {
    const missing = await Effect.runPromise(
      Effect.flip(Cli.containerCreate({ args: [] } as unknown as ContainerCreateInput)),
    );
    expect(missing._tag).toBe("DockerCliInputError");

    const malformed = await Effect.runPromise(
      Effect.exit(Cli.containerCreate({ args: [23] } as unknown as ContainerCreateInput)),
    );
    expect(Exit.isFailure(malformed)).toBe(true);
  });

  it("normalizes optional nulls and empty required maps without hiding required scalar errors", () => {
    const shape = Lite.Struct({
      optional: Lite.optional(Lite.Array(Lite.String)),
      nullable: Lite.optional(Lite.NullOr(Lite.Array(Lite.String))),
      required: Lite.String,
      requiredMap: Lite.Record(Lite.String, Lite.String),
      networks: Lite.optional(
        Lite.Record(
          Lite.String,
          Lite.Struct({
            links: Lite.optional(Lite.Array(Lite.String)),
            id: Lite.String,
          }),
        ),
      ),
    });
    const input = {
      optional: null,
      nullable: null,
      required: null,
      requiredMap: null,
      networks: { "default-network": { links: null, id: "ok" } },
      unknown: null,
    };
    expect(omitAbsentOptionals(shape.ast, input)).toEqual({
      nullable: null,
      required: null,
      requiredMap: {},
      networks: { "default-network": { id: "ok" } },
      unknown: null,
    });
    // Invalid nulls on required members must remain detectable by Schema.
    expect(input.required).toBe(null);
  });

  it("executes argv without shell interpolation and collects both streams", async () => {
    const result = await Effect.runPromise(
      Cli.run([
        "-e",
        "process.stdout.write(process.argv[1]); process.stderr.write('diagnostic')",
        "literal;$(echo should-not-run)",
      ]).pipe(
        Effect.provideService(Cli.CliSettings, { bin: process.execPath }),
        Effect.provide(NodeServices.layer),
      ),
    );
    expect(result).toEqual({
      stdout: "literal;$(echo should-not-run)",
      stderr: "diagnostic",
      exitCode: 0,
    });
  });

  it("provides a scoped, observable raw transport with per-call environment and output taps", async () => {
    const tested = await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const chunks = yield* Ref.make<ReadonlyArray<string>>([]);
        const result = yield* Cli.runRaw(
          [
            "-e",
            "process.stdout.write(process.env.DISTILLED_TEST_VALUE); process.stderr.write('warning'); process.exit(23)",
          ],
          {
            bin: process.execPath,
            env: { DISTILLED_TEST_VALUE: "from-environment" },
            stdoutTap: Stream.tap((text) => Ref.update(chunks, (items) => [...items, text])),
            stderrTap: Stream.tap((text) => Ref.update(chunks, (items) => [...items, text])),
          },
        ).pipe(Effect.provideService(Cli.CliExecutionProbe, () => Ref.update(calls, (n) => n + 1)));
        return { result, calls: yield* Ref.get(calls), chunks: yield* Ref.get(chunks) };
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(tested.result).toEqual({
      stdout: "from-environment",
      stderr: "warning",
      exitCode: 23,
    });
    expect(tested.calls).toBe(1);
    expect(tested.chunks).toEqual(expect.arrayContaining(["from-environment", "warning"]));
  });

  it("accepts Effect-native stdin and Redacted process env without putting secrets in argv", async () => {
    const result = await Effect.runPromise(
      Cli.run(
        [
          "-e",
          "process.stdin.setEncoding('utf8');process.stdin.on('data', value => process.stdout.write(String(value === process.env.DISTILLED_TEST_SECRET)))",
        ],
        {
          bin: process.execPath,
          env: { DISTILLED_TEST_SECRET: Redacted.make("secret-from-stdin") },
          stdin: Stream.make(new TextEncoder().encode("secret-from-stdin")),
        },
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(result.stdout).toBe("true");
  });

  it("preserves binary stdout byte-for-byte and streams opaque chunks", async () => {
    const argv = ["-e", "process.stdout.write(Buffer.from([0, 255, 13, 10]))"];
    const options = { bin: process.execPath };
    const result = await Effect.runPromise(
      Cli.runBinary(argv, options).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(Array.from(result.stdout)).toEqual([0, 255, 13, 10]);
    const chunks = await Effect.runPromise(
      Stream.runCollect(Cli.runBinaryStream(argv, options)).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    expect(Array.from(chunks).flatMap(({ bytes }) => [...bytes])).toEqual([0, 255, 13, 10]);

    // The shared collector must drain binary stdout and still expose text
    // stderr to Effect observers without decoding or modifying binary bytes.
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const warnings = yield* Ref.make<ReadonlyArray<string>>([]);
        const collected = yield* Cli.runRawBinary(
          [
            "-e",
            "process.stdout.write(Buffer.from([0,255])); process.stderr.write('binary-warning')",
          ],
          {
            bin: process.execPath,
            stderrTap: Stream.tap((text) =>
              Ref.update(warnings, (messages) => [...messages, text]),
            ),
          },
        );
        return { collected, warnings: yield* Ref.get(warnings) };
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(Array.from(observed.collected.stdout)).toEqual([0, 255]);
    expect(observed.collected.stderr).toBe("binary-warning");
    expect(observed.warnings).toContain("binary-warning");
  });

  it("does not include caller-provided argv values in typed process errors", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Cli.run(["-e", "process.exit(31)", "sensitive-value-in-argv"], {
          bin: process.execPath,
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    );
    expect(error._tag).toBe("DockerCliExitError");
    expect(error.command).toBe("docker");
    expect(JSON.stringify(error)).not.toContain("sensitive-value-in-argv");
  });

  it("keeps CLI diagnostics Redacted, including process stderr containing secrets", async () => {
    const secret = "secret-that-must-not-serialize";
    const failure = await Effect.runPromise(
      Effect.flip(
        Cli.run(["-e", `process.stderr.write(${JSON.stringify(secret)});process.exit(44)`], {
          bin: process.execPath,
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    );
    expect(failure._tag).toBe("DockerCliExitError");
    expect(Redacted.value(failure.stderr)).toBe(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).toContain("<redacted>");
  });

  it("uses safe generated command names and does not echo malformed JSON into decode errors", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Generated.dockerVersion({}, { bin: process.execPath }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      ),
    );
    expect(error._tag).toBe("DockerCliExitError");
    expect(error.command).toBe("docker version");

    const secret = "super-sensitive-value-never-log";
    const decoded = await Effect.runPromise(
      Effect.flip(Cli.parseJson({ stdout: `INVALID ${secret}`, stderr: "", exitCode: 0 })),
    );
    expect(decoded._tag).toBe("DockerCliDecodeError");
    expect(JSON.stringify(decoded)).not.toContain(secret);
  });

  it("uses scoped CLI context and honors explicit executable over the fiber default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "distilled-docker-cli-context-"));
    const executable = join(directory, "docker");
    try {
      await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      const actual = await Effect.runPromise(
        Generated.dockerVersion({}, { bin: executable }).pipe(
          Effect.provideService(Cli.CliSettings, { bin: "does-not-exist", context: "scoped" }),
          Effect.provide(NodeServices.layer),
        ),
      );
      expect(actual.stdout.trim().split("\n")).toEqual(["--context", "scoped", "version"]);
      const explicit = await Effect.runPromise(
        Generated.dockerVersion({ context: "explicit" }, { bin: executable }).pipe(
          Effect.provideService(Cli.CliSettings, { context: "scoped" }),
          Effect.provide(NodeServices.layer),
        ),
      );
      expect(explicit.stdout.trim().split("\n")).toEqual(["--context", "explicit", "version"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("probes the installed CLI without executing resource operations and rejects unsupported flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "distilled-docker-cli-capabilities-"));
    const executable = join(directory, "docker");
    try {
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          'if [ "$1" = "container" ] && [ "$2" = "ls" ] && [ "$3" = "--help" ]; then',
          "  echo 'Usage: docker container ls [OPTIONS]'",
          "  echo 'Options:'",
          "  echo '  -a, --all          Show all containers'",
          "  echo '      --quiet        List IDs only'",
          "  exit 0",
          "fi",
          'if [ "$1" = "build" ] && [ "$2" = "--help" ]; then',
          "  echo 'Usage: docker buildx build [OPTIONS] PATH | URL | -'",
          "  echo '      --tag stringArray    Tag images'",
          "  exit 0",
          "fi",
          'if [ "$1" = "compose" ] && [ "$2" = "convert" ] && [ "$3" = "--help" ]; then',
          "  echo 'Usage: docker compose [OPTIONS] COMMAND'",
          "  exit 1",
          "fi",
          'if [ "$1" = "container" ] && [ "$2" = "ls" ]; then',
          "  echo 'executed'",
          "  exit 0",
          "fi",
          "echo 'unavailable' >&2",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const options = { bin: executable, checkSupport: true };
      const capability = await Effect.runPromise(
        Cli.probeCommand(Generated.containerLsSpec, options).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
      expect(capability).toMatchObject({
        command: "docker container ls",
        available: true,
        flags: ["all", "quiet"],
      });
      const delegated = await Effect.runPromise(
        Cli.probeCommand(Generated.buildSpec, options).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(delegated.available).toBe(true);
      const missingPluginCommand = await Effect.runPromise(
        Cli.probeCommand(Generated.composeConvertSpec, options).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
      expect(missingPluginCommand.available).toBe(false);
      const supported = await Effect.runPromise(
        Generated.containerLs({ flags: { all: true } }, options).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
      expect(supported.stdout.trim()).toBe("executed");
      const unsupportedFlag = await Effect.runPromise(
        Effect.flip(
          Generated.containerLs({ flags: { latest: true } }, options).pipe(
            Effect.provide(NodeServices.layer),
          ),
        ),
      );
      expect(unsupportedFlag).toMatchObject({
        _tag: "DockerCliUnsupportedError",
        reason: "flag",
        flag: "latest",
      });
      const unsupportedCommand = await Effect.runPromise(
        Effect.flip(Generated.networkLs({}, options).pipe(Effect.provide(NodeServices.layer))),
      );
      expect(unsupportedCommand).toMatchObject({
        _tag: "DockerCliUnsupportedError",
        reason: "command",
      });
      expect(Schema.decodeUnknownSync(Cli.DockerCliCapabilitySchema)(capability)).toEqual(
        capability,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports nonzero process exits as typed errors", async () => {
    // The higher-level client maps a nonzero exit to DockerCliExitError.
    const result = await Effect.runPromise(
      Effect.flip(
        Cli.run(["-e", "process.stderr.write('failure'); process.exit(17)"]).pipe(
          Effect.provideService(Cli.CliSettings, { bin: process.execPath }),
          Effect.provide(NodeServices.layer),
        ),
      ),
    );
    expect(result._tag).toBe("DockerCliExitError");
    expect(result.exitCode).toBe(17);
    expect(Redacted.value(result.stderr)).toBe("failure");
  });

  it("streams process output without buffering stdout and stderr into one result", async () => {
    const chunks = await Effect.runPromise(
      Stream.runCollect(
        Cli.runStream([
          "-e",
          "process.stdout.write('stdout-chunk'); process.stderr.write('stderr-chunk')",
        ]),
      ).pipe(
        Effect.provideService(Cli.CliSettings, { bin: process.execPath }),
        Effect.provide(NodeServices.layer),
      ),
    );
    expect(Array.from(chunks)).toEqual(
      expect.arrayContaining([
        { channel: "stdout", text: "stdout-chunk" },
        { channel: "stderr", text: "stderr-chunk" },
      ]),
    );
  });

  it("propagates the exit code and recent stderr from streamed processes", async () => {
    const result = await Effect.runPromise(
      Effect.flip(
        Stream.runDrain(
          Cli.runStream(["-e", "process.stderr.write('stream failure'); process.exit(19)"]),
        ).pipe(
          Effect.provideService(Cli.CliSettings, { bin: process.execPath }),
          Effect.provide(NodeServices.layer),
        ),
      ),
    );
    expect(result._tag).toBe("DockerCliExitError");
    expect(result.exitCode).toBe(19);
    expect(Redacted.value(result.stderr)).toContain("stream failure");

    // Binary and text modes must share the same scoped exit/error contract.
    const binaryFailure = await Effect.runPromise(
      Effect.flip(
        Stream.runDrain(
          Cli.runBinaryStream([
            "-e",
            "process.stdout.write(Buffer.from([0,255])); process.stderr.write('binary failure'); process.exit(29)",
          ]),
        ).pipe(
          Effect.provideService(Cli.CliSettings, { bin: process.execPath }),
          Effect.provide(NodeServices.layer),
        ),
      ),
    );
    expect(binaryFailure).toMatchObject({ _tag: "DockerCliExitError", exitCode: 29 });
    expect(Redacted.value(binaryFailure.stderr)).toContain("binary failure");
  });

  it("keeps Effect Stream taps active in both streamed output channels", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const tapped = yield* Ref.make<ReadonlyArray<string>>([]);
        const chunks = yield* Stream.runCollect(
          Cli.runStream(["-e", "process.stdout.write('stdout'); process.stderr.write('stderr')"], {
            bin: process.execPath,
            stdoutTap: Stream.tap((text) =>
              Ref.update(tapped, (items) => [...items, `out:${text}`]),
            ),
            stderrTap: Stream.tap((text) =>
              Ref.update(tapped, (items) => [...items, `err:${text}`]),
            ),
          }),
        );
        return { chunks: Array.from(chunks), tapped: yield* Ref.get(tapped) };
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(observed.chunks).toEqual(
      expect.arrayContaining([
        { channel: "stdout", text: "stdout" },
        { channel: "stderr", text: "stderr" },
      ]),
    );
    expect(observed.tapped).toEqual(expect.arrayContaining(["out:stdout", "err:stderr"]));
  });

  it("decodes container inspect JSON using the generated Engine schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "distilled-docker-cli-"));
    const executable = join(directory, "docker");
    try {
      await writeFile(
        executable,
        "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([{Id:'test-container',State:{Status:'running'},HostConfig:{DeviceCgroupRules:null},NetworkSettings:{Networks:{internal:{Links:null}}}}]));\n",
        { mode: 0o755 },
      );
      const containers = await Effect.runPromise(
        Cli.containerInspect({ args: ["test-container"] }).pipe(
          Effect.provideService(Cli.CliSettings, { bin: executable }),
          Effect.provide(NodeServices.layer),
        ),
      );
      expect(containers[0]?.Id).toBe("test-container");
      expect(containers[0]?.State?.Status).toBe("running");
      expect(containers[0]?.HostConfig?.DeviceCgroupRules).toBe(undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
