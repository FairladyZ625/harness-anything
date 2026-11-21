import { createHash } from "node:crypto";

// @canonical-substrate sha256Text sha256Bytes stablePayloadHash stableStringify
// Single canonical implementation authority (ADR-0022 D6); duplicate
// definitions anywhere else in packages/ fail check-integrity-single-source.
export const auditHashAlgorithms = ["sha256", "sm3"] as const;
export type AuditHashAlgorithm = (typeof auditHashAlgorithms)[number];
export type AuditDigest = `${AuditHashAlgorithm}:${string}`;

export function isAuditHashAlgorithm(value: unknown): value is AuditHashAlgorithm {
  return typeof value === "string" && (auditHashAlgorithms as readonly string[]).includes(value);
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestText(algorithm: AuditHashAlgorithm, text: string): string {
  return createHash(algorithm).update(text, "utf8").digest("hex");
}

export function createTextDigestAccumulator(algorithm: AuditHashAlgorithm): {
  readonly feed: (chunk: string) => void;
  readonly digest: () => AuditDigest;
} {
  const hash = createHash(algorithm);
  return {
    feed: (chunk: string) => {
      hash.update(chunk, "utf8");
    },
    digest: () => `${algorithm}:${hash.digest("hex")}`,
  };
}

export function stablePayloadHash(value: unknown): string {
  return sha256Text(stableStringify(value));
}

export function stableDigest(algorithm: AuditHashAlgorithm, value: unknown): AuditDigest {
  return `${algorithm}:${digestText(algorithm, stableStringify(value))}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
