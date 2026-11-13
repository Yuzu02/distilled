/**
 * Validate canonical Docker CLI metadata at the codegen boundary. The mirror
 * already converted Docker's Go/Cobra-generated YAML into JSON. Codegen reads
 * only the pinned Schema-decoded contract, never free-form YAML.
 */
import * as Schema from "effect/Schema";
import { CliValueType as DockerFlagValueType } from "../src/cli/contract.ts";

/** All value types emitted by Docker's official command reference. */
export const CliValueType = DockerFlagValueType;
export type CliValueType = Schema.Schema.Type<typeof CliValueType>;

const CliOption = Schema.Struct({
  option: Schema.String,
  value_type: CliValueType,
  shorthand: Schema.optional(Schema.String),
  default_value: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  details_url: Schema.optional(Schema.String),
  hidden: Schema.optional(Schema.Boolean),
  deprecated: Schema.optional(Schema.Boolean),
  experimental: Schema.optional(Schema.Boolean),
  experimentalcli: Schema.optional(Schema.Boolean),
  kubernetes: Schema.optional(Schema.Boolean),
  swarm: Schema.optional(Schema.Boolean),
  os_type: Schema.optional(Schema.String),
  min_api_version: Schema.optional(Schema.String),
});

export const CliReference = Schema.Struct({
  command: Schema.String,
  // Parent command groups are documented but aren't runnable operations.
  usage: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(CliOption)),
  inherited_options: Schema.optional(Schema.Array(CliOption)),
});

export type CliOption = Schema.Schema.Type<typeof CliOption>;
export type CliReference = Schema.Schema.Type<typeof CliReference>;

export const decodeCliReference = (source: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(CliReference))(source);
