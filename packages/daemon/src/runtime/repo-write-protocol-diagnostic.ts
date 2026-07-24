const defaultMaxDiagnosticBytes = 2 * 1024;

export function boundedRepoWriteDiagnostic(
  error: unknown,
  maxBytes = defaultMaxDiagnosticBytes
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  const source = error instanceof Error
    ? `${error.name || "Error"}: ${error.message || "writer failure"}`
    : "Unknown writer failure";
  const sanitized = source
    .slice(0, maxBytes * 4 + 1)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim();
  return truncateUtf8(sanitized || "writer failure", maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}
