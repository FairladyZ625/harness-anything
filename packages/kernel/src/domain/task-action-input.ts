import type { EntityActionInputContract, EntityActionInputField } from "./entity-kind-registry.ts";

type FieldType = NonNullable<EntityActionInputField["type"]>;
type FieldValue = NonNullable<EntityActionInputField["value"]>;
type Cli = NonNullable<EntityActionInputField["cli"]>;
type CliExtra = Omit<Cli, "name" | "kind" | "error"> & Pick<EntityActionInputField, "enum" | "regex">;

function value(type: FieldType, enumRef?: readonly string[], regex?: string): FieldValue {
  if (type === "number" || type === "boolean") return { kind: type };
  if (type === "json-object") return { kind: "object", fields: [] };
  if (type.endsWith("-array"))
    return type === "json-object-array"
      ? { kind: "array", items: { kind: "object", fields: [] } }
      : { kind: "array", items: { kind: "string" } };
  return { kind: "string", ...(enumRef ? { enumRef } : {}), ...(regex ? { regex } : {}) };
}

export function field(
  name: string,
  type: FieldType = "string",
  required = false,
  enumRef?: readonly string[],
  regex?: string,
): EntityActionInputField {
  return Object.freeze({
    field: name,
    type,
    required,
    value: value(type, enumRef, regex),
    ...(enumRef ? { enum: enumRef } : {}),
    ...(regex ? { regex } : {}),
  });
}

export function cli(
  name: string,
  type: FieldType,
  required: boolean,
  flag: string,
  kind: Cli["kind"] = "single",
  extra: CliExtra = {},
  errorCode = required ? "missing_field" : "invalid_field",
): EntityActionInputField {
  const { enum: enumRef, regex, ...binding } = extra;
  return Object.freeze({
    ...field(name, type, required, enumRef, regex),
    cli: Object.freeze({ ...binding, name: flag, kind, error: Object.freeze({ code: errorCode }) }),
  });
}

export function objectField(
  name: string,
  fields: readonly EntityActionInputField[],
  required = false,
): EntityActionInputField {
  return Object.freeze({
    field: name,
    type: "json-object",
    required,
    fields,
    value: Object.freeze({ kind: "object", fields }),
  });
}

export function input(
  fields: readonly EntityActionInputField[],
  exactlyOneOf: readonly (readonly string[])[] = [],
): EntityActionInputContract {
  return Object.freeze({
    schema: "entity-action-input/v2",
    fields: Object.freeze(fields),
    exactlyOneOf: Object.freeze(exactlyOneOf.map((group) => Object.freeze(group))),
  });
}
