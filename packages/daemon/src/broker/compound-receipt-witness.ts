import {
  createHistoricalExcludedSetWitnessV1,
  type AppliedExactAtCutV2
} from "../../../application/src/index.ts";
import type { MaterializationWitness } from "./types.ts";
import { fingerprintDigest } from "./fingerprint.ts";

export function materializationWitnessToAppliedExactAtCutV2(input: {
  readonly witness: MaterializationWitness;
  readonly viewId: string;
  readonly opId: string;
  /** Supplied only when the exclusion implementation exposes a stable durable identifier. */
  readonly writerExclusionId?: string;
}): AppliedExactAtCutV2 {
  if (input.witness.cutKind !== "HISTORICAL_EXCLUDED_SET") {
    throw new Error("COMPOUND_BROKER_WITNESS_KIND_UNSUPPORTED");
  }
  const fingerprintPaths = Object.keys(input.witness.fingerprints).sort();
  const fencePaths = Object.keys(input.witness.watcherFenceVector).sort();
  if (JSON.stringify(fingerprintPaths) !== JSON.stringify(fencePaths)) {
    throw new Error("COMPOUND_BROKER_WITNESS_FENCE_SET_MISMATCH");
  }
  if (input.witness.selectedDigest !== fingerprintDigest(fingerprintPaths)) {
    throw new Error("COMPOUND_BROKER_WITNESS_SELECTED_SET_MISMATCH");
  }
  const witness = createHistoricalExcludedSetWitnessV1({
    cutId: input.witness.cutId,
    epochToken: input.witness.epoch,
    revision: input.witness.revision,
    selectedPathSetDigest: input.witness.selectedDigest,
    cutJournalLSN: input.witness.journalLSN,
    ...(input.writerExclusionId === undefined ? {} : { writerExclusionId: input.writerExclusionId }),
    fingerprints: fingerprintPaths.map((pathName) => ({
      path: pathName,
      ...input.witness.fingerprints[pathName]!
    })),
    watcherFenceEntries: fencePaths.map((pathName) => ({
      path: pathName,
      fenceToken: input.witness.watcherFenceVector[pathName]!
    }))
  });
  return {
    tag: "APPLIED_EXACT_AT_CUT",
    viewId: input.viewId,
    opId: input.opId,
    version: witness.revision,
    cutId: witness.cutId,
    cutKind: "WRITE_EXCLUDED",
    cutJournalLSN: witness.cutJournalLSN,
    verifiedAffectedDigest: witness.affectedDigest,
    ...(witness.writerExclusionId === undefined ? {} : { writerExclusionId: witness.writerExclusionId }),
    witness,
    witnessDigest: witness.canonicalWitnessDigest
  };
}
