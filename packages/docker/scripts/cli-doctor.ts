import * as Docker from "@distilled.cloud/docker/cli";
/**
 * Read-only Docker CLI compatibility audit.
 *
 * Compare the official Go/Cobra-derived command catalog with the installed
 * Docker, Buildx and Compose CLI. Only `--help` is executed. An optional
 * `--strict` flag makes the process fail after emitting the complete report.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const FlagDifference = Schema.Struct({
  command: Schema.String,
  missing: Schema.Array(Schema.String),
});

const CompatibilityReport = Schema.Struct({
  checked: Schema.Int,
  available: Schema.Int,
  unavailable: Schema.Array(Schema.String),
  flagDifferences: Schema.Array(FlagDifference),
});

export const audit = Effect.gen(function* () {
  const specEntries = Object.entries(Docker).filter(
    ([name, value]) => name.endsWith("Spec") && typeof value === "object",
  );
  const specs = yield* Effect.forEach(specEntries, ([, value]) =>
    Schema.decodeUnknownEffect(Docker.CommandSpecSchema)(value),
  );
  const observations = yield* Effect.forEach(
    specs,
    (spec) => Effect.map(Docker.probeCommand(spec), (capability) => ({ spec, capability })),
    { concurrency: 4 },
  );
  const unavailable = observations
    .filter(({ capability }) => !capability.available)
    .map(({ capability }) => capability.command);
  const flagDifferences = observations.flatMap(({ spec, capability }) => {
    if (!capability.available) return [];
    // These flags are conditional on runtime OS, API level or development
    // mode. Report only unconditional upstream flags as compatibility drift.
    const missing = Object.values(spec.flags)
      .filter((flag) => !flag.deprecated && !flag.experimental && flag.osType === undefined)
      .map((flag) => flag.name)
      .filter((flag) => !capability.flags.includes(flag));
    return missing.length > 0 ? [{ command: capability.command, missing }] : [];
  });
  return {
    checked: specs.length,
    available: specs.length - unavailable.length,
    unavailable,
    flagDifferences,
  };
});

if (import.meta.main) {
  const strict = process.argv.slice(2).includes("--strict");
  Effect.gen(function* () {
    const report = yield* audit;
    const json = yield* Schema.encodeUnknownEffect(
      Schema.fromJsonString(CompatibilityReport, { space: 2 }),
    )(report);
    yield* Console.log(json);
    if (strict && (report.unavailable.length > 0 || report.flagDifferences.length > 0)) {
      return yield* Effect.fail(
        new Error("Installed Docker CLI differs from the official catalog"),
      );
    }
  }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
