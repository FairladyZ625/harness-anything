import type { EntityActionInputField } from "@harness-anything/kernel";
export type { EntityActionInputField } from "@harness-anything/kernel";

/** The maximum number of rows in a Fleet action array on both edge and center. */
export const FLEET_ACTION_PAGE_ROWS = 128;

/** Preserve the caller's path coordinate across the edge/center transport boundary. */
export const FLEET_PATH_COORDINATE_FIELD: EntityActionInputField = {
  field: "pathCoordinate",
  type: "string",
  required: false,
  wire: { enum: ["workspace", "task-artifact"] },
};

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const patternCache = new Map<string, RegExp>();

function patternMatches(pattern: string, value: string): boolean {
  let compiled = patternCache.get(pattern);
  if (compiled === undefined) {
    compiled = new RegExp(pattern, "u");
    patternCache.set(pattern, compiled);
  }
  return compiled.test(value);
}

function fieldIssue(field: EntityActionInputField, value: unknown, path: string, maximum: number): string | null {
  if (field.wire?.nullable && value === null) return null;
  const type = field.type;
  if (type === "boolean") return typeof value === "boolean" ? null : path;
  if (type === "number")
    return Number.isSafeInteger(value) && Number(value) >= (field.wire?.minimum ?? 0) ? null : path;
  if (type === "json-object") {
    if (!record(value)) return path;
    return field.fields ? payloadIssue(field.fields, value, maximum, path) : null;
  }
  if (type === "string-array" || type === "fact-hold-array" || type === "json-object-array") {
    if (!Array.isArray(value) || value.length > maximum) return path;
    const itemField =
      field.items ??
      ({
        field: field.field,
        type: type === "string-array" ? "string" : "json-object",
        required: true,
        regex: field.regex,
        enum: field.enum,
        wire: field.wire,
        ...(field.fields ? { fields: field.fields } : {}),
      } satisfies EntityActionInputField);
    for (const [index, item] of value.entries()) {
      const issue = fieldIssue(itemField, item, `${path}[${index}]`, maximum);
      if (issue) return issue;
    }
    return null;
  }
  if (typeof value !== "string") return path;
  if (field.wire?.normalization && value !== value.normalize(field.wire.normalization)) return path;
  if (value.length === 0 || value.length > (field.wire?.maxLength ?? 512)) return path;
  const values = field.wire?.enum ?? field.enum;
  if (values && !values.includes(value)) return path;
  const pattern = field.wire?.pattern ?? field.regex;
  if (pattern && !patternMatches(pattern, value)) return path;
  return null;
}

function payloadIssue(
  fields: readonly EntityActionInputField[],
  payload: Readonly<Record<string, unknown>>,
  maximum: number,
  prefix = "action",
): string | null {
  const missing = fields.find(
    (field) => (field.wire?.required ?? field.required) && !Object.hasOwn(payload, field.field),
  );
  if (missing) return `${prefix}.${missing.field}`;
  for (const [name, value] of Object.entries(payload)) {
    const field = fields.find((candidate) => candidate.field === name);
    if (!field) return `${prefix}.${name}`;
    const issue = fieldIssue(field, value, `${prefix}.${name}`, maximum);
    if (issue) return issue;
  }
  return null;
}

/** Validate a complete Fleet action payload using the command declaration supplied by the caller. */
export function fleetActionPayloadIssue(
  fields: readonly EntityActionInputField[],
  payload: Readonly<Record<string, unknown>>,
  maximum = FLEET_ACTION_PAGE_ROWS,
): string | null {
  return payloadIssue(fields, payload, maximum);
}
