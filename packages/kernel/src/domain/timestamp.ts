export function timestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
