import type { Node } from "@distilled.cloud/core/schema-lite-impl";

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

const acceptsNull = (node: Node): boolean => {
  const shape = resolve(node);
  switch (shape._tag) {
    case "Null":
    case "Unknown":
    case "Any":
      return true;
    case "Union":
      return shape.types?.some(acceptsNull) ?? false;
    default:
      return false;
  }
};

const isOptional = (node: Node): boolean => {
  const shape = resolve(node);
  return (
    shape.context?.isOptional === true ||
    (shape._tag === "Union" &&
      (shape.types?.some((part) => resolve(part)._tag === "Undefined") ?? false))
  );
};

const variantFor = (node: Node, value: unknown): Node => {
  const shape = resolve(node);
  if (shape._tag !== "Union") return shape;
  const tag = Array.isArray(value)
    ? "Arrays"
    : value !== null && typeof value === "object"
      ? "Objects"
      : undefined;
  if (tag === undefined) return shape;
  return shape.types?.map(resolve).find((part) => part._tag === tag) ?? shape;
};

const isStringKeyedRecord = (node: Node): boolean => {
  const shape = variantFor(node, {});
  return (
    shape._tag === "Objects" &&
    (shape.propertySignatures?.length ?? 0) === 0 &&
    (shape.indexSignatures?.some(({ parameter }) => resolve(parameter)._tag === "String") ?? false)
  );
};

/** Normalize Docker's absent-value encodings according to the generated AST. */
export const omitAbsentOptionals = (node: Node, value: unknown): unknown => {
  const shape = variantFor(node, value);
  if (Array.isArray(value) && shape._tag === "Arrays") {
    let changed = false;
    const items = value.map((item, index) => {
      const member = shape.elements?.[index] ?? shape.rest?.[0];
      const next = member === undefined ? item : omitAbsentOptionals(member, item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") return value;
  if (shape._tag !== "Objects") return value;

  const members = new Map(shape.propertySignatures?.map((p) => [p.name, p.type]));
  // Records (such as NetworkSettings.Networks) use an index signature
  // instead of property signatures. Follow their value schema as well.
  const recordValue = shape.indexSignatures?.find(
    ({ parameter }) => resolve(parameter)._tag === "String",
  )?.type;
  let changed = false;
  const object: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const member = members.get(key) ?? recordValue;
    if (member !== undefined && entry === null && !acceptsNull(member)) {
      if (isOptional(member)) {
        changed = true;
        continue;
      }
      if (isStringKeyedRecord(member)) {
        object[key] = {};
        changed = true;
        continue;
      }
    }
    const next = member === undefined ? entry : omitAbsentOptionals(member, entry);
    if (next !== entry) changed = true;
    object[key] = next;
  }
  return changed ? object : value;
};
