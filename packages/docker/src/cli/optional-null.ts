import type { Node } from "@distilled.cloud/core/schema-lite-impl";
import * as A from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * Docker's inspect CLI emits null for some fields that the Engine OpenAPI
 * model declares non-nullable. Normalize only two absent-value encodings:
 * optional null members are omitted, and required string-keyed records that
 * Docker emits as null become empty records. Both choices follow the
 * generated schema, before decoding through the Engine SDK.
 *
 * Keep nulls in nullable members, required members, array elements and
 * unknown object properties. No shape definitions are duplicated here.
 */

const resolve = (node: Node): Node =>
  node._tag === "Suspend" && node.thunk !== undefined ? resolve(node.thunk()) : node;

/** JSON objects are the only records that may be normalized. */
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const acceptsNull = (node: Node): boolean => {
  const shape = resolve(node);
  return Match.value(shape._tag).pipe(
    Match.whenOr("Null", "Unknown", "Any", () => true),
    Match.when("Union", () => A.some(shape.types ?? [], acceptsNull)),
    Match.orElse(() => false),
  );
};

const isOptional = (node: Node): boolean => {
  const shape = resolve(node);
  return (
    shape.context?.isOptional === true ||
    (shape._tag === "Union" &&
      A.some(shape.types ?? [], (part) => resolve(part)._tag === "Undefined"))
  );
};

const variantFor = (node: Node, value: unknown): Node => {
  const shape = resolve(node);
  if (shape._tag !== "Union") return shape;
  const tag = A.isArray(value)
    ? "Arrays"
    : value !== null && typeof value === "object"
      ? "Objects"
      : undefined;
  if (tag === undefined) return shape;
  return Option.getOrElse(
    A.findFirst(A.map(shape.types ?? [], resolve), (part) => part._tag === tag),
    () => shape,
  );
};

const isStringKeyedRecord = (node: Node): boolean => {
  const shape = variantFor(node, {});
  return (
    shape._tag === "Objects" &&
    (shape.propertySignatures?.length ?? 0) === 0 &&
    A.some(shape.indexSignatures ?? [], ({ parameter }) => resolve(parameter)._tag === "String")
  );
};

/** Normalize Docker's absent-value encodings according to the generated AST. */
export const omitAbsentOptionals = (node: Node, value: unknown): unknown => {
  const shape = variantFor(node, value);
  if (A.isArray(value) && shape._tag === "Arrays") {
    let changed = false;
    const items = A.map(value, (item, index) => {
      const member = shape.elements?.[index] ?? shape.rest?.[0];
      const next = member === undefined ? item : omitAbsentOptionals(member, item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (A.isArray(value) || !isJsonObject(value)) return value;
  if (shape._tag !== "Objects") return value;

  const members = R.fromEntries(
    // JSON object keys are strings even when a schema-lite property is numeric.
    A.map(shape.propertySignatures ?? [], (p) => [String(p.name), p.type] as const),
  );
  // Records (such as NetworkSettings.Networks) use an index signature
  // instead of property signatures. Follow their value schema as well.
  const recordValue = Option.getOrUndefined(
    A.findFirst(
      shape.indexSignatures ?? [],
      ({ parameter }) => resolve(parameter)._tag === "String",
    ),
  )?.type;
  let changed = false;
  const entries = A.filterMap(R.toEntries(value), ([key, entry]) => {
    const member = Option.getOrUndefined(R.get(members, key)) ?? recordValue;
    if (member !== undefined && entry === null && !acceptsNull(member)) {
      if (isOptional(member)) {
        changed = true;
        return Result.failVoid;
      }
      if (isStringKeyedRecord(member)) {
        changed = true;
        return Result.succeed([key, {}] as const);
      }
    }
    const next = member === undefined ? entry : omitAbsentOptionals(member, entry);
    if (next !== entry) changed = true;
    return Result.succeed([key, next] as const);
  });
  return changed ? R.fromEntries(entries) : value;
};
