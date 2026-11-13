# @distilled.cloud/docker

Effect-native Docker SDK. The package exposes **two transports**:

- `@distilled.cloud/docker` (also `/engine`): the existing generated Docker
  Engine HTTP API, unchanged, including its credentials, protocol and retry layers.
- `@distilled.cloud/docker/cli`: typed Docker CLI contracts and commands,
  executed without a shell through Effect's ChildProcess API.

The package root remains backward-compatible with existing Engine consumers.
Import `/cli` only when Docker CLI flags, schemas or operations are needed.

## Installation

```sh
pnpm add @distilled.cloud/docker effect @effect/platform-node
```

## Docker CLI

```ts
import { NodeServices } from "@effect/platform-node";
import * as Docker from "@distilled.cloud/docker/cli";
import * as Effect from "effect/Effect";

const program = Effect.gen(function* () {
  const listing = yield* Docker.containerLs({ flags: { all: true, quiet: true } });
  return listing.stdout.trim().split("\n").filter(Boolean);
});

await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)));
```

The SDK currently generates **271 runnable commands** from the Docker,
Buildx and Compose references. Each operation has generated **input and flag
schemas**, derived types, command metadata and a streaming variant. The
existing Docker spec mirror (`specs/spec-mirror-docker/specs/cli/`) is the
sole source of truth; its manifest identifies every official upstream path
and exact commit. The mirror refreshes on Distilled's usual schedule.
Docker's official CLI references are generated from Go/Cobra by
`docker/cli-docs-tool`; the mirror converts them to canonical JSON before the
SDK generator validates them with `Effect.Schema`. No Go runtime, hand-written
Go parser, or YAML parser is required in a published SDK or during codegen.
The published CLI exports `dockerCliSourceRevisions`, which records the exact
`docker/docs` and `docker/compose` commit used by the generator.

```ts
import * as Redacted from "effect/Redacted";

const created = yield* Docker.containerCreate({
  args: ["postgres:18"],
  flags: {
    name: "database",
    env: ["POSTGRES_DB"],
    mount: ["type=volume,src=dbdata,dst=/var/lib/postgresql"],
    healthInterval: "5s",
  },
}, {
  env: { POSTGRES_DB: Redacted.make("app") },
});
const containerId = created.stdout.trim();
```

The regular CLI methods return `{ stdout, stderr, exitCode }`, described by
`CommandResultSchema`. The `configInspect`, `containerInspect`,
`imageInspect`, `networkInspect`, `nodeInspect`, `pluginInspect`,
`secretInspect`, `serviceInspect` and `volumeInspect` methods instead
return **typed arrays**, decoded with matching generated Engine API schemas.
Some Docker CLI responses contain `null` for optional, non-nullable members;
the decoder omits only those members according to the same generated schema.
Other values still undergo Schema validation. Use the corresponding
`*InspectRaw` variant for custom Go templates and human-readable output;
typed `inspect` accepts only the default JSON array format. Commands without
a known JSON response stay raw.

All generated commands also have a `Stream` variant
that emits stdout/stderr chunks as they arrive without accumulating the
whole log. For example:

```ts
import * as Stream from "effect/Stream";

const logs = Docker.buildxBuildStream({
  flags: { tag: ["example:latest"], load: true },
  args: ["."],
});

yield* Stream.runForEach(logs, ({ channel, text }) =>
  Effect.logInfo(`${channel}: ${text}`),
);
```

Streams are scoped and interruptible. A nonzero exit produces
`DockerCliExitError`, with the recent stderr tail retained for diagnosis as
`Redacted<string>`. Only reveal it explicitly with `Redacted.value(error.stderr)`
in trusted diagnostic code; serializing the error never exposes stderr or argv.
For commands producing binary data, use `runBinary` or `runBinaryStream`
instead of the UTF-8 text APIs.

For machine-readable CLI output, provide a schema that reflects the requested
format. `decodeJsonLines` validates newline-delimited `--format json` output,
and `decodeYaml` validates YAML such as `docker compose config`. Both use
Effect's Schema and YAML implementation; CLI table text is not silently
treated as an Engine HTTP response.

```ts
import * as Schema from "effect/Schema";

const rows = yield* Docker.decodeJsonLines(
  yield* Docker.containerLs({ flags: { format: "json" } }),
  Schema.Struct({ ID: Schema.String, Names: Schema.String }),
);
```

To choose a Docker context use `context: "my-context"` on an operation, or
set `CliSettings.context` as a scoped default. An explicit command context
wins. To override the executable, use per-operation execution options or
`CliSettings`; those take precedence over `DOCKER_BIN`.
The CLI honors normal Docker contexts, credentials and environment variables.
The process spawner is an Effect requirement, not an implicit global executor.

The published reference can be newer than the installed Docker/Buildx/Compose
binary, or contain OS-specific/experimental flags. To check support before
executing an operation, opt in to the read-only `--help` probe:

```ts
const capabilities = yield* Docker.probeCommand(Docker.containerCreateSpec);
if (!capabilities.available) {
  // The installed Docker CLI does not expose this command.
}
const result = yield* Docker.containerLs(
  { flags: { all: true } },
  { checkSupport: true },
);
```

`checkSupport` produces a typed `DockerCliUnsupportedError` for an unavailable
command or flag. It is deliberately opt-in: a preflight adds a process and a
CLI version/OS check to every call, which is unnecessary for established
deployments. Docker remains authoritative for runtime and cross-flag checks.

For a reproducible capability report against the installed Docker/Buildx/
Compose combination, use the **read-only** command:

```sh
pnpm --filter @distilled.cloud/docker cli:doctor
```

It first builds the SDK, then probes every generated command with `--help`,
compares unconditional flags, and emits a structured JSON report. This does
not create or modify Docker resources. Pass `--strict` to make version and
plugin drift a failing diagnostic; use the normal mode to inspect differences.

Pass credentials as `Redacted` environment values and reference only their
**names** in `--env` flags, as above. Never include secrets in argv. Commands
that read standard input accept an Effect `Stream<Uint8Array>` via their
optional execution options. The process error does not reproduce argv.

Positional arguments belong in `args`. Flags are camelCased from the official
CLI options and are validated with Effect Schema before execution. Repeated
flags use arrays; map-style flags accept object values where supported.
Inputs are passed as argv elements, never interpolated into a shell command.

Docker CLI metadata does not encode every cross-flag conflict, file format or
constraint of special values such as mounts. The Docker executable is still
responsible for those checks. For a large build, prefer the streaming variant
instead of the collecting method. The Docker CLI installed on a host can also
delegate `docker image build` to Buildx, which changes its accepted flags from
the legacy Engine CLI reference; use `buildxBuild` explicitly when relying on
Buildx-specific flags. Text-oriented operations must not be used for binary
stdout; use the byte-preserving transport instead. Interactive TTY sessions
need a dedicated terminal adapter. The SDK supports streamed stdin.

## Docker Engine API

```ts
import * as DockerEngine from "@distilled.cloud/docker";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Effect, Layer } from "effect";

const Live = Layer.mergeAll(
  FetchHttpClient.layer,
  DockerEngine.CredentialsFromEnv,
  DockerEngine.DockerProtocol,
);

const containers = DockerEngine.listContainer({});
const result = await Effect.runPromise(containers.pipe(Effect.provide(Live)));
```

The Engine API still uses the pinned OpenAPI mirror, Swagger-to-Smithy
conversion and `packages/docker/src/services/docker.ts` generated types.

## Development

**Reviewing the CLI PoC branch:** The generated SDK source is committed and
works without checking out any specs. The existing
`distilled-mirror/spec-mirror-docker` gitlink does **not yet** include the new
CLI JSON catalog; that mirror is managed by Distilled's spec-update workflow.
Until its update is published and pinned, regenerate using the repository's
supported, gitignored local mirror instead:

```sh
pnpm specs:local docker  # official mirror workflow, in a gitignored local tree
DISTILLED_SPECS_LOCAL=1 pnpm --filter @distilled.cloud/docker cli:generate
# Optionally regenerate Engine and CLI together:
DISTILLED_SPECS_LOCAL=1 pnpm generate docker
pnpm vitest run packages/docker/test/cli.test.ts
pnpm typecheck:ci
```

The generated `dockerCliSourceRevisions` identifies the exact upstream
Docker Docs and Compose revisions used for this PoC. A fresh local mirror
refresh may select newer upstream revisions; publishing the canonical CLI
descriptors in the official mirror is the remaining release-time integration
step. No locally fetched spec files belong in this repository's commits.

Real mutation tests are **opt-in** and require an independently verified
Docker-in-Docker daemon bound to loopback, with `alpine:3.22` preloaded:

```sh
DISTILLED_DOCKER_E2E=1 \
DISTILLED_DOCKER_E2E_DAEMON=<isolated-daemon-hostname> \
DOCKER_HOST=tcp://127.0.0.1:<isolated-port> \
pnpm vitest run packages/docker/test/cli.integration.test.ts
```

The test verifies the exact daemon identity before writing, creates isolated
network, volume and container resources, decodes their Engine-backed inspect
responses, and uses `Effect.acquireRelease` for reverse-order cleanup.

The generated CLI source is `src/cli/generated.ts`. Do not edit that file or
the Engine service file by hand. To update command coverage, refresh the
official references in the existing Docker mirror with its `fetch-specs.ts`,
review the revision-bearing manifest, then regenerate from that mirror.
CI does not fetch specs. Adding upstream commands requires no handwritten
TypeScript interfaces. Docker CLI metadata documents flags and usage, **not**
complete response schemas or every cross-flag constraint. Unknown response
formats deliberately remain raw.
