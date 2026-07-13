import { createHash } from "node:crypto";

export const authorityBatchIntegrityDomain = "ha/authority-batch-integrity/v1\0";
export const authorityBatchTrailerName = "Harness-Authority-Batch";

export interface AuthorityBatchDigestEntry {
  readonly opId: string;
  readonly semanticMutationSetDigest: string;
}

export interface AuthorityBatchIntegrity {
  readonly entries: ReadonlyArray<AuthorityBatchDigestEntry>;
  readonly vectorBytes: Uint8Array;
  readonly aggregateDigest: string;
  readonly trailerValue: string;
}

/**
 * Canonical v1 batch preimage:
 *   utf8("ha/authority-batch-integrity/v1\\0")
 *   || u32be(entryCount)
 *   || repeated in publication order {
 *        u32be(utf8(opId).length) || utf8(opId) || raw32(semanticMutationSetDigest)
 *      }
 *
 * The Git trailer value is one ASCII token:
 *   v1:<lowercase aggregate hex>:<base64url(vector bytes)>
 *
 * Length prefixes make the ordered opId→digest vector injective; the explicit
 * domain makes its aggregate impossible to confuse with a per-operation digest.
 */
export function buildAuthorityBatchIntegrity(
  entries: ReadonlyArray<AuthorityBatchDigestEntry>
): AuthorityBatchIntegrity {
  if (entries.length === 0) throw new Error("authority batch integrity requires at least one operation");
  const seen = new Set<string>();
  const chunks: Buffer[] = [u32(entries.length)];
  const canonicalEntries = entries.map((entry) => {
    const opId = entry.opId.trim();
    if (!opId || opId !== entry.opId) throw new Error("authority batch opId must be non-empty canonical UTF-8");
    if (seen.has(opId)) throw new Error(`authority batch contains duplicate opId: ${opId}`);
    seen.add(opId);
    const opIdBytes = Buffer.from(opId, "utf8");
    const digest = rawDigest(entry.semanticMutationSetDigest);
    chunks.push(u32(opIdBytes.length), opIdBytes, digest);
    return { opId, semanticMutationSetDigest: digest.toString("hex") };
  });
  const vectorBytes = Buffer.concat(chunks);
  const aggregateDigest = createHash("sha256")
    .update(authorityBatchIntegrityDomain, "utf8")
    .update(vectorBytes)
    .digest("hex");
  return {
    entries: canonicalEntries,
    vectorBytes,
    aggregateDigest,
    trailerValue: `v1:${aggregateDigest}:${vectorBytes.toString("base64url")}`
  };
}

export function parseAuthorityBatchIntegrityTrailer(value: string): AuthorityBatchIntegrity {
  const match = /^v1:([0-9a-f]{64}):([A-Za-z0-9_-]+)$/u.exec(value);
  if (!match) throw new Error("invalid authority batch integrity trailer");
  const vectorBytes = Buffer.from(match[2]!, "base64url");
  let offset = 0;
  const count = readU32(vectorBytes, offset);
  offset += 4;
  const entries: AuthorityBatchDigestEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = readU32(vectorBytes, offset);
    offset += 4;
    if (offset + length + 32 > vectorBytes.length) throw new Error("truncated authority batch integrity vector");
    const opIdBytes = vectorBytes.subarray(offset, offset + length);
    offset += length;
    const opId = new TextDecoder("utf-8", { fatal: true }).decode(opIdBytes);
    const digest = vectorBytes.subarray(offset, offset + 32);
    offset += 32;
    entries.push({ opId, semanticMutationSetDigest: Buffer.from(digest).toString("hex") });
  }
  if (offset !== vectorBytes.length) throw new Error("authority batch integrity vector has trailing bytes");
  const integrity = buildAuthorityBatchIntegrity(entries);
  if (integrity.aggregateDigest !== match[1]
    || !Buffer.from(integrity.vectorBytes).equals(vectorBytes)) {
    throw new Error("authority batch integrity aggregate mismatch");
  }
  return integrity;
}

function rawDigest(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("semantic mutation digest must be lowercase SHA-256 hex");
  return Buffer.from(value, "hex");
}

function u32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error("authority batch length exceeds uint32");
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value, 0);
  return bytes;
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error("truncated authority batch integrity vector");
  return Buffer.from(bytes.buffer, bytes.byteOffset + offset, 4).readUInt32BE(0);
}
