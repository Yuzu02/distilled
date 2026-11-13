/**
 * Canonical Docker CLI metadata shared by code generation and the runtime.
 *
 * One Effect Schema defines the accepted Docker Go/Cobra flag kinds for
 * generation and the published runtime. Unknown upstream types fail at the
 * mirror/codegen boundary rather than silently weakening the SDK.
 */
import * as Schema from "effect/Schema";

export const CliValueType = Schema.Literals([
  "bool",
  "bytes",
  "command",
  "config",
  "credential-spec",
  "decimal",
  "duration",
  "external-ca",
  "filter",
  "float",
  "gpu-request",
  "int",
  "int64",
  "ip",
  "ipNetSlice",
  "ipSlice",
  "list",
  "map",
  "mount",
  "network",
  "node-addr",
  "pem-file",
  "port",
  "pref",
  "secret",
  "string",
  "stringArray",
  "stringSlice",
  "stringToString",
  "uint",
  "uint16",
  "uint32",
  "uint64",
  "ulimit",
  "umask",
]);
export type CliValueType = Schema.Schema.Type<typeof CliValueType>;

export const FlagSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  type: CliValueType,
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
  command: Schema.NonEmptyArray(Schema.String),
  usage: Schema.String.check(Schema.isNonEmpty()),
  flags: Schema.Record(Schema.String, FlagSpecSchema),
  minimumArgs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CommandSpec = Schema.Schema.Type<typeof CommandSpecSchema>;
