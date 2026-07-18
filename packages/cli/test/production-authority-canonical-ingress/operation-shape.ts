/**
 * Removes per-invocation identity from persisted authority operations while
 * retaining every semantic field and proof category for parity assertions.
 */
export function authorityOperationShape(value: unknown, key = ""): unknown {
  if (key === "canonicalRequestEnvelope") return "<CANONICAL_REQUEST_ENVELOPE>";
  if (key === "opId") return "<OP_ID>";
  if (key === "commitSha" || key === "previousCommit") return "<COMMIT_SHA>";
  if (key === "revision") return "<REVISION>";
  if (key === "semanticDigest" || key.endsWith("Digest")) return "<DIGEST>";
  if (Array.isArray(value)) return value.map((entry) => authorityOperationShape(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entry]) => [entryKey, authorityOperationShape(entry, entryKey)]));
  }
  if (typeof value !== "string") return value;
  return value
    .replace(/(?:task|exe|rev|cns)_[0-9A-HJKMNP-TV-Z]{26}/gu, "<ENTITY_ID>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/gu, "<TIMESTAMP>");
}
