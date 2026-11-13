/**
 * Pinned Docker CLI reference sources.
 *
 * The existing Docker spec mirror tracks both Docker Engine and CLI sources.
 * The mirrored manifest records the exact upstream commit for every document.
 * Normal generation is offline and uses that versioned mirror, never a live
 * upstream URL or a second package-local snapshot.
 */
import { resolve } from "node:path";
import { resolveSpecPath } from "@distilled.cloud/dev/codegen/spec-path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export const CliSource = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  owner: Schema.String.check(Schema.isNonEmpty()),
  repo: Schema.String.check(Schema.isNonEmpty()),
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  path: Schema.String.check(Schema.isNonEmpty()),
});
export type CliSource = Schema.Schema.Type<typeof CliSource>;

/** Read and validate the pinned mirror manifest through Effect's FileSystem. */
export const cliSources = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Effect.try({
    try: () =>
      resolveSpecPath(
        resolve(import.meta.dirname, ".."),
        "specs/spec-mirror-docker/specs/cli/manifest.json",
      ),
    catch: () => new Error("Cannot locate the pinned Docker CLI manifest in the spec mirror"),
  });
  const json = yield* fs.readFileString(path);
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(CliSource)))(json);
});
