export function codePoints(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && [...value].length >= min && [...value].length <= max;
}
export function requiredWithOptional(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  allowUnknownFields: boolean,
): boolean {
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    (allowUnknownFields || Object.keys(value).every((field) => required.includes(field) || optional.includes(field)))
  );
}
