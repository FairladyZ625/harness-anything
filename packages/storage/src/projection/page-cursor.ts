export function checkedPageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500)
    throw new Error("query page limit must be an integer between 1 and 500");
  return value;
}

export function encodePageCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

export function decodePageCursor(value: string, expected: number): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("query cursor is invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expected ||
    parsed.some((part) => typeof part !== "string" || part.length === 0)
  )
    throw new Error("query cursor is invalid");
  return parsed;
}
