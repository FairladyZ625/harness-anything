import { encodeCanonicalCbor, domainHash } from "../authority/canonical-cbor.ts";

export const historicalExcludedSetWitnessKind = "HISTORICAL_EXCLUDED_SET" as const;
export const historicalExcludedSetWitnessDigestDomain = "ha/historical-excluded-set-witness/v1\0";
export const historicalAffectedSetDigestDomain = "ha/historical-excluded-set-affected/v1\0";
export const historicalWatcherFenceDigestDomain = "ha/historical-excluded-set-watcher-fence/v1\0";

export interface HistoricalWitnessFingerprintV1 {
  readonly path: string;
  readonly objectKind: "file" | "tombstone";
  readonly logicalMode: number;
  readonly byteSize: number;
  readonly blobDigest: string;
}

export interface HistoricalWatcherFenceEntryV1 {
  readonly path: string;
  readonly fenceToken: string;
}

export interface HistoricalExcludedSetWitnessV1 {
  readonly kind: typeof historicalExcludedSetWitnessKind;
  readonly cutId: string;
  readonly epochToken: string;
  readonly revision: number;
  readonly selectedPathSetDigest: string;
  readonly affectedDigest: string;
  readonly watcherFenceVectorDigest: string;
  readonly cutJournalLSN: number;
  readonly writerExclusionId?: string;
  readonly fingerprints: ReadonlyArray<HistoricalWitnessFingerprintV1>;
  readonly watcherFenceEntries: ReadonlyArray<HistoricalWatcherFenceEntryV1>;
  readonly canonicalWitnessDigest: string;
}

export interface HistoricalExcludedSetWitnessInputV1 {
  readonly cutId: string;
  readonly epochToken: string;
  readonly revision: number;
  readonly selectedPathSetDigest: string;
  readonly cutJournalLSN: number;
  readonly writerExclusionId?: string;
  readonly fingerprints: ReadonlyArray<HistoricalWitnessFingerprintV1>;
  readonly watcherFenceEntries: ReadonlyArray<HistoricalWatcherFenceEntryV1>;
}

export function createHistoricalExcludedSetWitnessV1(
  input: HistoricalExcludedSetWitnessInputV1
): HistoricalExcludedSetWitnessV1 {
  assertWitnessText(input.cutId, "cutId");
  assertWitnessText(input.epochToken, "epochToken");
  assertWitnessText(input.selectedPathSetDigest, "selectedPathSetDigest");
  assertWitnessUint(input.revision, "revision");
  assertWitnessUint(input.cutJournalLSN, "cutJournalLSN");
  if (input.writerExclusionId !== undefined) assertWitnessText(input.writerExclusionId, "writerExclusionId");
  const fingerprints = sortedFingerprints(input.fingerprints);
  const watcherFenceEntries = sortedFenceEntries(input.watcherFenceEntries);
  const fingerprintWire = fingerprints.map((entry) => ({
    path: entry.path,
    objectKind: entry.objectKind,
    logicalMode: entry.logicalMode,
    byteSize: entry.byteSize,
    blobDigest: entry.blobDigest
  }));
  const fenceWire = watcherFenceEntries.map((entry) => ({ path: entry.path, fenceToken: entry.fenceToken }));
  const affectedDigest = digestHex(historicalAffectedSetDigestDomain, encodeCanonicalCbor({ fingerprints: fingerprintWire }));
  const watcherFenceVectorDigest = digestHex(
    historicalWatcherFenceDigestDomain,
    encodeCanonicalCbor({ watcherFenceEntries: fenceWire })
  );
  const core = {
    kind: historicalExcludedSetWitnessKind,
    cutId: input.cutId,
    epochToken: input.epochToken,
    revision: input.revision,
    selectedPathSetDigest: input.selectedPathSetDigest,
    affectedDigest,
    watcherFenceVectorDigest,
    cutJournalLSN: input.cutJournalLSN,
    writerExclusionId: input.writerExclusionId ?? null,
    fingerprints: fingerprintWire,
    watcherFenceEntries: fenceWire
  } as const;
  return {
    kind: core.kind,
    cutId: core.cutId,
    epochToken: core.epochToken,
    revision: core.revision,
    selectedPathSetDigest: core.selectedPathSetDigest,
    affectedDigest: core.affectedDigest,
    watcherFenceVectorDigest: core.watcherFenceVectorDigest,
    cutJournalLSN: core.cutJournalLSN,
    ...(input.writerExclusionId === undefined ? {} : { writerExclusionId: input.writerExclusionId }),
    fingerprints: core.fingerprints,
    watcherFenceEntries: core.watcherFenceEntries,
    canonicalWitnessDigest: digestHex(
      historicalExcludedSetWitnessDigestDomain,
      encodeCanonicalCbor(core)
    )
  };
}

export function assertHistoricalExcludedSetWitnessV1(
  witness: HistoricalExcludedSetWitnessV1
): void {
  if (!isWitnessRecord(witness)) throw new Error("HISTORICAL_WITNESS_INVALID");
  exactWitnessKeys(witness, [
    "kind", "cutId", "epochToken", "revision", "selectedPathSetDigest", "affectedDigest",
    "watcherFenceVectorDigest", "cutJournalLSN", "fingerprints", "watcherFenceEntries",
    "canonicalWitnessDigest"
  ], ["writerExclusionId"]);
  if (witness.kind !== historicalExcludedSetWitnessKind) throw new Error("HISTORICAL_WITNESS_KIND_INVALID");
  if (!Array.isArray(witness.fingerprints) || !Array.isArray(witness.watcherFenceEntries)) {
    throw new Error("HISTORICAL_WITNESS_COLLECTION_INVALID");
  }
  for (const entry of witness.fingerprints) {
    if (!isWitnessRecord(entry)) throw new Error("HISTORICAL_WITNESS_FINGERPRINT_INVALID");
    exactWitnessKeys(entry, ["path", "objectKind", "logicalMode", "byteSize", "blobDigest"], []);
  }
  for (const entry of witness.watcherFenceEntries) {
    if (!isWitnessRecord(entry)) throw new Error("HISTORICAL_WITNESS_FENCE_INVALID");
    exactWitnessKeys(entry, ["path", "fenceToken"], []);
  }
  const recomputed = createHistoricalExcludedSetWitnessV1({
    cutId: witness.cutId,
    epochToken: witness.epochToken,
    revision: witness.revision,
    selectedPathSetDigest: witness.selectedPathSetDigest,
    cutJournalLSN: witness.cutJournalLSN,
    ...(witness.writerExclusionId === undefined ? {} : { writerExclusionId: witness.writerExclusionId }),
    fingerprints: witness.fingerprints,
    watcherFenceEntries: witness.watcherFenceEntries
  });
  if (recomputed.cutId !== witness.cutId
    || recomputed.epochToken !== witness.epochToken
    || recomputed.revision !== witness.revision
    || recomputed.selectedPathSetDigest !== witness.selectedPathSetDigest
    || recomputed.affectedDigest !== witness.affectedDigest
    || recomputed.watcherFenceVectorDigest !== witness.watcherFenceVectorDigest
    || recomputed.cutJournalLSN !== witness.cutJournalLSN
    || recomputed.writerExclusionId !== witness.writerExclusionId
    || recomputed.canonicalWitnessDigest !== witness.canonicalWitnessDigest
    || JSON.stringify(recomputed.fingerprints) !== JSON.stringify(witness.fingerprints)
    || JSON.stringify(recomputed.watcherFenceEntries) !== JSON.stringify(witness.watcherFenceEntries)) {
    throw new Error("HISTORICAL_WITNESS_CANONICAL_MISMATCH");
  }
}

function sortedFingerprints(
  values: ReadonlyArray<HistoricalWitnessFingerprintV1>
): ReadonlyArray<HistoricalWitnessFingerprintV1> {
  const sorted = values.map((entry) => {
    assertWitnessText(entry.path, "fingerprint.path");
    if (entry.objectKind !== "file" && entry.objectKind !== "tombstone") {
      throw new Error("HISTORICAL_WITNESS_FINGERPRINT_KIND_INVALID");
    }
    assertWitnessUint(entry.logicalMode, "fingerprint.logicalMode");
    assertWitnessUint(entry.byteSize, "fingerprint.byteSize");
    assertWitnessText(entry.blobDigest, "fingerprint.blobDigest");
    return { ...entry };
  }).sort((left, right) => left.path.localeCompare(right.path));
  assertUniquePaths(sorted.map((entry) => entry.path), "fingerprints");
  return sorted;
}

function sortedFenceEntries(
  values: ReadonlyArray<HistoricalWatcherFenceEntryV1>
): ReadonlyArray<HistoricalWatcherFenceEntryV1> {
  const sorted = values.map((entry) => {
    assertWitnessText(entry.path, "watcherFence.path");
    assertWitnessText(entry.fenceToken, "watcherFence.fenceToken");
    return { ...entry };
  }).sort((left, right) => left.path.localeCompare(right.path));
  assertUniquePaths(sorted.map((entry) => entry.path), "watcherFenceEntries");
  return sorted;
}

function assertUniquePaths(paths: ReadonlyArray<string>, label: string): void {
  if (new Set(paths).size !== paths.length) throw new Error(`HISTORICAL_WITNESS_DUPLICATE_PATH:${label}`);
}

function assertWitnessText(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`HISTORICAL_WITNESS_FIELD_INVALID:${label}`);
}

function assertWitnessUint(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`HISTORICAL_WITNESS_FIELD_INVALID:${label}`);
}

function digestHex(domain: string, bytes: Uint8Array): string {
  return Buffer.from(domainHash(domain, bytes)).toString("hex");
}

function isWitnessRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactWitnessKeys(
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("HISTORICAL_WITNESS_FIELDS_INVALID");
  }
}
