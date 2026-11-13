#!/usr/bin/env node
/**
 * Mirrors the Docker Engine API and the Docker-maintained CLI reference into
 * ../specs/. These are independent, official machine-readable descriptions.
 *
 * Only the official description files are mirrored, never a repository
 * checkout. Fetch, validation, concurrency, and filesystem access are all
 * managed by Effect; no network or disk work happens during module import.
 *
 * Usage:
 *   node fetch-specs.ts
 *
 * Specs are saved to:
 *   ../specs/swagger.json
 *   ../specs/cli/manifest.json
 *   ../specs/cli/commands/*.json
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as A from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Yaml from "effect/encoding/Yaml";
import * as FileSystem from "effect/FileSystem";
import * as HashSet from "effect/HashSet";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import YAML from "yaml";

/** Upstream repository, as `<owner>/<repo>`. */
const REPO = "moby/moby";
/** Branch (or tag/commit) to mirror. */
const REF = "master";
/** Path within {@link REPO}. */
const SPEC_PATH = "api/swagger.yaml";
const SPECS_DIR = "../specs";
const OUTPUT_PATH = `${SPECS_DIR}/swagger.json`;

class DockerCliMirrorError extends Schema.TaggedError<DockerCliMirrorError>()(
  "DockerCliMirrorError",
  {
    source: Schema.String,
    reason: Schema.Literals([
      "incomplete-tree",
      "invalid-path",
      "invalid-catalog",
      "invalid-yaml",
      "invalid-swagger",
      "invalid-command",
      "invalid-usage",
      "insufficient-commands",
    ]),
  },
) {}

/** A moving branch is resolved to a commit before any CLI document is read. */
const CLI_CATALOGS = [
  {
    repo: "docker/docs",
    branch: "main",
    prefixes: ["data/cli/engine/docker_", "data/cli/buildx/docker_"],
  },
  { repo: "docker/compose", branch: "main", prefixes: ["docs/reference/docker_compose_"] },
] as const;

const Commit = Schema.Struct({
  sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
});
const GitTree = Schema.Struct({
  truncated: Schema.optional(Schema.Boolean),
  tree: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      path: Schema.optional(Schema.String),
    }),
  ),
});
const CliSource = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  owner: Schema.String.check(Schema.isNonEmpty()),
  repo: Schema.String.check(Schema.isNonEmpty()),
  revision: Commit.fields.sha,
  path: Schema.String.check(Schema.isNonEmpty()),
});
type CliSource = Schema.Schema.Type<typeof CliSource>;
const CliReference = Schema.Struct({
  command: Schema.String,
  usage: Schema.optional(Schema.String),
});
const EngineSpec = Schema.Struct({
  swagger: Schema.Literal("2.0"),
  paths: Schema.Record(Schema.String, Schema.Unknown),
});

/** All requests are abortable, use the Effect HttpClient service and reject non-2xx. */
const fetchText = (url: string, accept = "application/yaml, text/yaml, text/plain") =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const retrying = HttpClient.retryTransient(http, {
      retryOn: "errors-and-responses",
      times: 2,
    });
    const response = yield* retrying.execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({
          accept,
          "user-agent": "distilled.cloud-docker-spec-mirror",
        }),
      ),
    );
    const ok = yield* HttpClientResponse.filterStatusOk(response);
    return yield* ok.text;
  }).pipe(Effect.timeout("30 seconds"));

const githubJson = (url: string) =>
  Effect.flatMap(
    fetchText(url, "application/vnd.github+json"),
    Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown)),
  );

const cliSources = Effect.gen(function* () {
  const groups = yield* Effect.forEach(
    CLI_CATALOGS,
    ({ repo, branch, prefixes }) =>
      Effect.gen(function* () {
        const { sha: revision } = yield* Schema.decodeUnknownEffect(Commit)(
          yield* githubJson("https://api.github.com/repos/" + repo + "/commits/" + branch),
        );
        const tree = yield* Schema.decodeUnknownEffect(GitTree)(
          yield* githubJson(
            "https://api.github.com/repos/" + repo + "/git/trees/" + revision + "?recursive=1",
          ),
        );
        if (tree.truncated === true) {
          return yield* new DockerCliMirrorError({ source: repo, reason: "incomplete-tree" });
        }
        const [owner, repository] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.String, Schema.String]),
        )(Str.split(repo, "/"));
        const matches = A.getSomes(
          A.map(tree.tree, (entry) => {
            const path = entry.path;
            if (
              entry.type !== "blob" ||
              path === undefined ||
              !path.endsWith(".yaml") ||
              !A.some(prefixes, (prefix) => path.startsWith(prefix))
            )
              return Option.none();
            return Option.some(path);
          }),
        );
        const invalid = A.findFirst(
          matches,
          (path) => !/^docker_[a-z0-9_-]+\.yaml$/.test(path.slice(path.lastIndexOf("/") + 1)),
        );
        if (Option.isSome(invalid)) {
          return yield* Effect.fail(
            new DockerCliMirrorError({ source: invalid.value, reason: "invalid-path" }),
          );
        }
        return A.map(matches, (path): CliSource => {
          const basename = path.slice(path.lastIndexOf("/") + 1);
          return {
            name: basename.slice("docker_".length, -".yaml".length).replaceAll("_", "-"),
            owner,
            repo: repository,
            revision,
            path,
          };
        });
      }),
    { concurrency: 2 },
  );
  const sources = A.sortWith(A.flatten(groups), (source) => source.name, Order.String);
  if (
    sources.length < 200 ||
    HashSet.size(HashSet.fromIterable(A.map(sources, (source) => source.name))) !== sources.length
  ) {
    return yield* Effect.fail(
      new DockerCliMirrorError({ source: "Docker CLI catalog", reason: "invalid-catalog" }),
    );
  }
  return sources;
});

const parseYaml = (source: string) =>
  Effect.try({
    try: () => Yaml.parse(source),
    catch: () => new DockerCliMirrorError({ source: "CLI reference YAML", reason: "invalid-yaml" }),
  });

// Docker Engine's official Swagger uses compact nested block sequences that
// Effect's current YAML codec explicitly does not support. Keep the existing
// full YAML parser for this boundary, still inside an Effect with typed failure.
const parseSwagger = (source: string) =>
  Effect.try({
    try: () => YAML.parse(source) as unknown,
    catch: () =>
      new DockerCliMirrorError({ source: "Docker Engine Swagger", reason: "invalid-swagger" }),
  });

const fetchCli = Effect.gen(function* () {
  const sources = yield* cliSources;
  // Bounded, interruptible HTTP I/O; Effect.forEach preserves manifest order.
  // Every upstream reference is validated before any filesystem writes.
  const files = yield* Effect.forEach(
    sources,
    (source) =>
      Effect.gen(function* () {
        const url =
          "https://raw.githubusercontent.com/" +
          source.owner +
          "/" +
          source.repo +
          "/" +
          source.revision +
          "/" +
          source.path;
        const content = yield* fetchText(url);
        const document = yield* parseYaml(content);
        const reference = yield* Schema.decodeUnknownEffect(CliReference)(document);
        if (
          reference.command.split(" ").join("_") + ".yaml" !==
          source.path.slice(source.path.lastIndexOf("/") + 1)
        ) {
          return yield* new DockerCliMirrorError({ source: url, reason: "invalid-command" });
        }
        if (reference.usage === undefined) return undefined; // parent group
        if (
          reference.usage !== reference.command &&
          !reference.usage.startsWith(reference.command + " ")
        ) {
          return yield* new DockerCliMirrorError({ source: url, reason: "invalid-usage" });
        }
        // Docker's cli-docs-tool emits YAML from its Go/Cobra command tree.
        // Validate and normalize it to the canonical JSON consumed by the
        // Effect.Schema generator, without copying Docker's Go implementation.
        const canonical = yield* Schema.encodeUnknownEffect(
          Schema.fromJsonString(Schema.Json, { space: 2 }),
        )(document);
        return { source, content: canonical + "\n" };
      }),
    { concurrency: 12 },
  );
  const runnable = A.getSomes(A.map(files, Option.fromNullishOr));
  if (runnable.length < 200) {
    return yield* Effect.fail(
      new DockerCliMirrorError({ source: "Docker CLI catalog", reason: "insufficient-commands" }),
    );
  }
  return runnable;
});

/**
 * The raw URL for a path in the official Engine repository. Preserve path
 * separators while escaping each segment.
 */
const rawUrl = (path: string) =>
  "https://raw.githubusercontent.com/" +
  REPO +
  "/" +
  REF +
  "/" +
  A.map(Str.split(path, "/"), encodeURIComponent).join("/");

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const url = rawUrl(SPEC_PATH);
  yield* Console.log("Fetching " + url + "...");

  const document = yield* parseSwagger(yield* fetchText(url));
  // The original document is written intact. Validation of the known
  // authoritative members must not strip additional Engine API fields.
  const spec = yield* Schema.decodeUnknownEffect(EngineSpec)(document);
  const runnable = yield* fetchCli;
  const swaggerJson = yield* Schema.encodeUnknownEffect(
    Schema.fromJsonString(Schema.Json, { space: 2 }),
  )(document);
  const manifestJson = yield* Schema.encodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(CliSource), { space: 2 }),
  )(A.map(runnable, ({ source }) => source));

  yield* fs.makeDirectory(SPECS_DIR, { recursive: true });
  yield* fs.makeDirectory(SPECS_DIR + "/cli", { recursive: true });
  yield* fs.makeDirectory(SPECS_DIR + "/cli/commands", { recursive: true });
  yield* fs.writeFileString(OUTPUT_PATH, swaggerJson + "\n");
  yield* Effect.forEach(
    runnable,
    ({ source, content }) =>
      fs.writeFileString(SPECS_DIR + "/cli/commands/" + source.name + ".json", content),
    { concurrency: 8, discard: true },
  );
  yield* fs.writeFileString(SPECS_DIR + "/cli/manifest.json", manifestJson + "\n");
  // Keep descriptors separate from the index: `docker manifest` is itself an
  // executable command, so its descriptor must never overwrite manifest.json.
  // Also remove stale descriptors after validating the full upstream catalog.
  const expected = HashSet.fromIterable(A.map(runnable, ({ source }) => `${source.name}.json`));
  const commands = yield* fs.readDirectory(SPECS_DIR + "/cli/commands");
  yield* Effect.forEach(
    A.filter(commands, (name) => name.endsWith(".json") && !HashSet.has(expected, name)),
    (name) => fs.remove(SPECS_DIR + "/cli/commands/" + name),
    { concurrency: 8, discard: true },
  );
  // Remove the superseded flat YAML/JSON snapshots, but retain catalog files
  // other than the exact names owned by this generator.
  const existing = yield* fs.readDirectory(SPECS_DIR + "/cli");
  yield* Effect.forEach(
    A.filter(
      existing,
      (name) => name.endsWith(".yaml") || (name.endsWith(".json") && name !== "manifest.json"),
    ),
    (name) => fs.remove(SPECS_DIR + "/cli/" + name),
    { concurrency: 8, discard: true },
  );
  yield* Console.log(
    "Mirrored " + runnable.length + " runnable Docker CLI references from Docker docs and Compose",
  );
  yield* Console.log("Done! Swagger " + spec.swagger + " — " + R.size(spec.paths) + " paths");
});

program.pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  NodeRuntime.runMain,
);
