const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u;

export function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && isoInstant(value);
}

export function normalizePersistedTimestamp(value: unknown): string | null {
  return typeof value === "string" && isoInstant(value) ? new Date(value).toISOString() : null;
}

function isoInstant(value: string): boolean {
  const match = ISO_INSTANT.exec(value),
    instant = new Date(value);
  if (match === null || !Number.isFinite(instant.getTime())) return false;
  const offsetMinutes =
      match[7] === "Z" ? 0 : (match[8] === "-" ? -1 : 1) * (Number(match[9]) * 60 + Number(match[10])),
    local = new Date(instant.getTime() + offsetMinutes * 60_000),
    parts = [
      local.getUTCFullYear(),
      local.getUTCMonth() + 1,
      local.getUTCDate(),
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
    ];
  return Math.abs(offsetMinutes) <= 23 * 60 + 59 && parts.every((part, index) => part === Number(match[index + 1]));
}
