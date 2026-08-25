export type EntityJsonSchemaNode = (
  | {
      readonly type: "string";
      readonly const?: string;
      readonly enum?: readonly string[];
      readonly pattern?: string;
      readonly minLength?: number;
      readonly description?: string;
    }
  | {
      readonly type: "number";
      readonly integer?: boolean;
      readonly minimum?: number;
      readonly description?: string;
    }
  | {
      readonly type: "array";
      readonly items: EntityJsonSchemaNode;
      readonly uniqueItems?: boolean;
      readonly minItems?: number;
      readonly "x-unique-by"?: string;
      readonly description?: string;
    }
  | EntityJsonObjectSchema
) & { readonly "x-error"?: string };

export const ENTITY_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

export interface EntityJsonObjectSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, EntityJsonSchemaNode>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
  readonly description?: string;
}

export type EntityDocumentJsonSchema<T = unknown> = EntityJsonObjectSchema & {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly $id: string;
  readonly Type?: T;
};

export interface EntitySchemaFieldExplanation {
  readonly name: string;
  readonly type: EntityJsonSchemaNode["type"];
  readonly required: boolean;
  readonly description: string | null;
}

export class EntitySchemaContractError extends Error {
  readonly code = "invalid_entity_contract";
  constructor(message: string) {
    super(message);
    this.name = "EntitySchemaContractError";
  }
}

export function validateEntityJsonSchema(
  schema: EntityDocumentJsonSchema,
  value: unknown,
  label = "entity declaration",
): readonly string[] {
  const errors: string[] = [];
  validateNode(schema, value, label, errors);
  return errors;
}

export function parseEntityJsonSchema<T>(schema: EntityDocumentJsonSchema<T>, value: unknown, label?: string): T {
  const errors = validateEntityJsonSchema(schema, value, label);
  if (errors.length) throw new EntitySchemaContractError(errors.join("; "));
  return value as T;
}

export function serializeEntityJsonSchema<T>(
  schema: EntityDocumentJsonSchema<T>,
  value: unknown,
  label?: string,
): string {
  return `${JSON.stringify(parseEntityJsonSchema(schema, value, label), null, 2)}\n`;
}

export function explainEntityJsonSchema(schema: EntityDocumentJsonSchema): readonly EntitySchemaFieldExplanation[] {
  return Object.entries(schema.properties).map(([name, field]) => ({
    name,
    type: field.type,
    required: schema.required.includes(name),
    description: field.description ?? null,
  }));
}

function validateNode(schema: EntityJsonSchemaNode, value: unknown, path: string, errors: string[]): void {
  const errorStart = errors.length;
  validateNodeValue(schema, value, path, errors);
  if (errors.length > errorStart && schema["x-error"] !== undefined)
    errors.splice(errorStart, errors.length - errorStart, `${path} ${schema["x-error"]}`);
}

function validateNodeValue(schema: EntityJsonSchemaNode, value: unknown, path: string, errors: string[]): void {
  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${path} must be a string.`);
      return;
    }
    if (schema.const !== undefined && value !== schema.const)
      errors.push(`${path} must equal ${JSON.stringify(schema.const)}.`);
    if (schema.enum !== undefined && !schema.enum.includes(value))
      errors.push(`${path} must be one of ${schema.enum.join(", ")}.`);
    if (schema.minLength !== undefined && value.trim().length < schema.minLength)
      errors.push(`${path} must be a non-empty string.`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      errors.push(`${path} does not match its declared pattern.`);
    return;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${path} must be a finite number.`);
      return;
    }
    if (schema.integer && !Number.isSafeInteger(value)) errors.push(`${path} must be an integer.`);
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path} must be at least ${schema.minimum}.`);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array.`);
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path} must contain at least ${schema.minItems} item(s).`);
    value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, errors));
    if (schema.uniqueItems && new Set(value.map(stableJson)).size !== value.length)
      errors.push(`${path} entries must be unique.`);
    const uniqueBy = schema["x-unique-by"];
    if (uniqueBy !== undefined) {
      const keys = value.map((item) => (isRecord(item) ? item[uniqueBy] : undefined));
      if (new Set(keys).size !== keys.length) errors.push(`${path} entries must have unique ${uniqueBy} values.`);
    }
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${path} must be a JSON object.`);
    return;
  }
  for (const field of schema.required)
    if (!Object.hasOwn(value, field) || value[field] === undefined)
      errors.push(`${path} is missing required field ${JSON.stringify(field)}.`);
  for (const field of Object.keys(value))
    if (!Object.hasOwn(schema.properties, field))
      errors.push(`${path} field ${JSON.stringify(field)} is unknown; remove it.`);
  for (const [field, fieldSchema] of Object.entries(schema.properties))
    if (Object.hasOwn(value, field) && value[field] !== undefined)
      validateNode(fieldSchema, value[field], `${path} field ${JSON.stringify(field)}`, errors);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    isRecord(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item,
  );
}
import { isRecord } from "./write-chain.contract.ts";
