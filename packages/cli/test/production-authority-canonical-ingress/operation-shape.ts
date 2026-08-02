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

/**
 * Compares the durable authority proof carried by semantically different
 * operations without pretending their write payloads or provenance are equal.
 */
export function authorityOperationProofShape(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return authorityOperationShape(value);
  const {
    canonicalOperation,
    ...record
  } = value as Record<string, unknown>;
  const operation = canonicalOperation && typeof canonicalOperation === "object" && !Array.isArray(canonicalOperation)
    ? canonicalOperation as Record<string, unknown>
    : undefined;
  return authorityOperationShape({
    ...record,
    canonicalOperation: operation === undefined
      ? undefined
      : {
        opId: operation.opId,
        entityId: operation.entityId,
        kind: operation.kind,
        authorityIntegrity: operation.authorityIntegrity
      }
  });
}
