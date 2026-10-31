export function isMigrationImportRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function migrationImportError(code: string, detail: string): Error {
  return Object.assign(new Error(detail), { code });
}
