export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return (
    Object.keys(value).every((field) => fields.includes(field)) && fields.every((field) => Object.hasOwn(value, field))
  );
}

export function hasRequiredFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return fields.every((field) => Object.hasOwn(value, field));
}
