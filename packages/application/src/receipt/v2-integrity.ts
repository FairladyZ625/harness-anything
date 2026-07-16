import { createHash, timingSafeEqual } from "node:crypto";
import { encodeCanonicalCbor, domainHash, type CanonicalCborValue } from "../authority/canonical-cbor.ts";
import type { CompoundOperationReceiptV2 } from "./v2-types.ts";

export const compoundResultTokenDigestDomain = "ha/compound-result-token/v1\0";
export const compoundPreparedReceiptDigestDomain = "ha/compound-prepared-receipt/v2\0";

export function resultTokenDigestV2(resultToken: string): string {
  if (typeof resultToken !== "string" || resultToken.length === 0) throw new Error("COMPOUND_RESULT_TOKEN_REQUIRED");
  return createHash("sha256").update(compoundResultTokenDigestDomain, "utf8").update(resultToken, "utf8").digest("hex");
}

export function resultTokenMatchesV2(resultToken: string, expectedDigest: string): boolean {
  const actual = Buffer.from(resultTokenDigestV2(resultToken), "hex");
  const expected = /^[a-f0-9]{64}$/u.test(expectedDigest) ? Buffer.from(expectedDigest, "hex") : Buffer.alloc(0);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function preparedReceiptDigestV2(receipt: CompoundOperationReceiptV2): string {
  if (receipt.delivery !== "RESULT_PREPARED") throw new Error("COMPOUND_RESULT_NOT_PREPARED");
  const canonical = toCompoundCanonicalCbor({
    schema: receipt.schema,
    workspaceId: receipt.workspaceId,
    viewId: receipt.viewId,
    opId: receipt.opId,
    waiterId: receipt.waiterId,
    resultTokenDigest: receipt.resultTokenDigest,
    sequence: receipt.sequence,
    phase: receipt.phase,
    authority: receipt.authority,
    origin: receipt.origin,
    originPin: receipt.originPin,
    delivery: receipt.delivery,
    pinReleaseEligible: receipt.pinReleaseEligible,
    currentLease: receipt.currentLease
  });
  return Buffer.from(domainHash(compoundPreparedReceiptDigestDomain, encodeCanonicalCbor(canonical))).toString("hex");
}

function toCompoundCanonicalCbor(value: unknown): CanonicalCborValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("COMPOUND_CANONICAL_NUMBER_INVALID");
    return value;
  }
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(toCompoundCanonicalCbor);
  if (typeof value !== "object") throw new Error("COMPOUND_CANONICAL_VALUE_INVALID");
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, toCompoundCanonicalCbor(entry)]));
}
