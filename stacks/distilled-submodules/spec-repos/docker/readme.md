# spec-mirror-docker

A git mirror of the official Docker Engine and CLI machine-readable
references, reduced to exactly the files
[`@distilled.cloud/docker`](https://github.com/alchemy-run/distilled) generates from:

- `specs/swagger.json` — `api/swagger.yaml` parsed to deterministic JSON
- `specs/cli/manifest.json` — every runnable CLI command, its upstream
  repository, exact commit, and source path
- `specs/cli/commands/*.json` — deterministic, Schema-validated CLI descriptors for
  Engine, Buildx and Compose (non-runnable parent groups are excluded)

The Engine Swagger comes from `moby/moby`; the CLI metadata comes from
`docker/docs` and `docker/compose`. Each upstream branch is resolved to a
full commit SHA before downloading its documents. The mirror retains only the
actual descriptions, never an upstream repository checkout. Docker generates
its published YAML references directly from the Go/Cobra command trees using
`docker/cli-docs-tool`. This updater converts that official output into JSON;
Distilled's SDK generator never needs to parse YAML or compile Go.

The updater uses Effect's `HttpClient` (with transient retries and bounded
timeouts), `Schema`, `FileSystem`, and controlled-concurrency
`Effect.forEach`. Docker's Swagger includes compact nested YAML block
sequences that Effect 4.1.2's YAML parser does not support; the Engine
document therefore uses the full `yaml` parser inside `Effect.try`.
CLI references are parsed through Effect's YAML codec, validated and encoded
as canonical JSON with `Effect.Schema`. Obsolete generated command files are
removed on refresh. SDK generation uses only that normalized JSON mirror.

The mirror is updated every 24 hours by
[`.github/workflows/update-specs.yml`](./.github/workflows/update-specs.yml).

## Usage as a submodule

```sh
git submodule add https://github.com/distilled-mirror/spec-mirror-docker.git
```

## Updating specs

From `.meta/`:

```sh
pnpm install
pnpm run fetch-specs
```

---

This repository is managed by the `distilled-submodules` Alchemy stack in
[alchemy-run/distilled](https://github.com/alchemy-run/distilled) (`stacks/distilled-submodules`).
Its scaffolding is generated — edit it there, not here.
