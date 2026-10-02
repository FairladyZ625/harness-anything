// Single shared scanner for credential-shaped keys crossing the GUI boundary: the preload
// uses it to reject outbound payloads (with an audited exemption for newly typed
// create/update apiKey), and renderer read clients reject inbound identity payloads before any
// component renders them. Pure module — no Node or Electron imports, safe for the browser.
export type EntityPayloadRecord = Record<string, unknown>;

export function entityRecord(value: unknown): EntityPayloadRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as EntityPayloadRecord) : {};
}

export function isSecretLikeKey(key: string): boolean {
  return /(?:secret|token|password|passphrase)/iu.test(key) || /^(?:api[-_]?key|credential(?:ref|value))$/iu.test(key);
}

// The exemption is top-level only: newly typed keys may ride create/update payloads,
// but the same key name nested anywhere deeper stays rejected.
export function containsSecretLikeKey(value: unknown, exemptTopLevelApiKey = false): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSecretLikeKey(item));
  const record = entityRecord(value);
  return Object.entries(record).some(
    ([key, nested]) =>
      (isSecretLikeKey(key) && !(exemptTopLevelApiKey && key === "apiKey")) || containsSecretLikeKey(nested),
  );
}
