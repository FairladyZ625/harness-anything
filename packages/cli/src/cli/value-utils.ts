export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePositiveIntegerOr(value: string | undefined, fallback: number, options: { readonly allowZero?: boolean } = {}): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (options.allowZero && parsed === 0) return parsed;
  return parsed > 0 ? parsed : fallback;
}
