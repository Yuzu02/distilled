/**
 * Canonical Docker CLI metadata shared by code generation and the runtime.
 *
 * These are the public metadata contracts. Source-side flag kinds are
 * exhaustively validated by the separate code-generation project against
 * the official reference. The runtime consumes the resulting literal
 * metadata without importing unpublished generator code.
 */
import * as Schema from "effect/Schema";

export const FlagSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  type: Schema.String.check(Schema.isNonEmpty()),
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
