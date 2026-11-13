/**
 * Docker CLI SDK. Import these contracts and operations from /cli.
 * The package root continues to expose the Docker Engine HTTP SDK.
 */
import { toEffect } from "@distilled.cloud/core/schema-lite";
import * as A from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Commands from "./cli/generated.ts";
import { omitAbsentOptionals } from "./cli/optional-null.ts";
import {
  DockerCliDecodeError,
  DockerCliInputError,
  parseJson,
  type CommandExecutionOptions,
  type CommandResult,
} from "./cli/runtime.ts";
import {
  configInspect as engineConfigInspect,
  containerInspect as engineContainerInspect,
  imageInspect2 as engineImageInspect,
  networkInspect as engineNetworkInspect,
  nodeInspect as engineNodeInspect,
  pluginInspect as enginePluginInspect,
  secretInspect as engineSecretInspect,
  serviceInspect as engineServiceInspect,
  volumeInspect as engineVolumeInspect,
} from "./services/docker.ts";

export * from "./cli/runtime.ts";
export * from "./cli/generated.ts";
export {
  configInspect as configInspectRaw,
  containerInspect as containerInspectRaw,
  imageInspect as imageInspectRaw,
  networkInspect as networkInspectRaw,
  nodeInspect as nodeInspectRaw,
  pluginInspect as pluginInspectRaw,
  secretInspect as secretInspectRaw,
  serviceInspect as serviceInspectRaw,
  volumeInspect as volumeInspectRaw,
} from "./cli/generated.ts";

/**
 * Decode Docker CLI inspect arrays using the matching generated Engine schema.
 * Docker's CLI may emit null for optional non-nullable fields, so normalize
 * those particular members according to the same generated AST first. Custom
 * Go templates and pretty output are not JSON arrays: use *InspectRaw for
 * those options rather than claiming their output matches an Engine schema.
 */
type JsonInspectInput<I extends { readonly flags?: object }> = Omit<I, "flags"> & {
  readonly flags?: Omit<NonNullable<I["flags"]>, "format" | "pretty"> & {
    readonly format?: never;
    readonly pretty?: never;
  };
};

const inspect = <I extends { readonly flags?: object }, O, E, R>(
  cli: (input: I, options?: CommandExecutionOptions) => Effect.Effect<CommandResult, E, R>,
  output: Schema.Schema<O>,
) => {
  const ast = output.ast as Parameters<typeof toEffect>[1];
  const decode = Schema.decodeUnknownEffect(
    Schema.Array(toEffect(Schema, ast) as Schema.Schema<O>),
  );
  return (input: JsonInspectInput<I>, options?: CommandExecutionOptions) => {
    const flags = input.flags as
      | { readonly format?: string; readonly pretty?: boolean }
      | undefined;
    if (flags?.format !== undefined || flags?.pretty !== undefined) {
      return Effect.fail(
        new DockerCliInputError({
          option: "flags",
          message:
            "Typed Docker inspect requires the default JSON array output; use the Raw variant for custom formats",
        }),
      );
    }
    return Effect.flatMap(cli(input as I, options), (result) =>
      Effect.flatMap(parseJson(result), (body) =>
        decode(A.isArray(body) ? A.map(body, (item) => omitAbsentOptionals(ast, item)) : body).pipe(
          Effect.mapError(
            () =>
              new DockerCliDecodeError({
                message: "Docker inspect response does not match its generated Engine schema",
                cause: undefined,
              }),
          ),
        ),
      ),
    );
  };
};

export const configInspect = inspect(Commands.configInspect, engineConfigInspect.output);
export const containerInspect = inspect(Commands.containerInspect, engineContainerInspect.output);
export const imageInspect = inspect(Commands.imageInspect, engineImageInspect.output);
export const networkInspect = inspect(Commands.networkInspect, engineNetworkInspect.output);
export const nodeInspect = inspect(Commands.nodeInspect, engineNodeInspect.output);
export const pluginInspect = inspect(Commands.pluginInspect, enginePluginInspect.output);
export const secretInspect = inspect(Commands.secretInspect, engineSecretInspect.output);
export const serviceInspect = inspect(Commands.serviceInspect, engineServiceInspect.output);
export const volumeInspect = inspect(Commands.volumeInspect, engineVolumeInspect.output);
