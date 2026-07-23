import { normalizeRelativeDocumentPath } from "@harness-anything/kernel";
import {
  fingerprintDigest,
  fingerprintPath,
  sameFingerprint
} from "./fingerprint.ts";
import type {
  BrokerBarrierRequest,
  BrokerBarrierResult,
  BrokerDurableState,
  ManagedFingerprint,
  MaterializationWitness,
  WatcherFence,
  WriterExclusion
} from "./types.ts";

export async function runBrokerBarrier(
  request: BrokerBarrierRequest,
  ports: {
    readonly current: () => BrokerDurableState;
    readonly persist: (state: BrokerDurableState) => Promise<void>;
    readonly visiblePath: (pathName: string) => string;
    readonly writerExclusion: WriterExclusion | undefined;
    readonly watcherFence: WatcherFence | undefined;
  }
): Promise<BrokerBarrierResult> {
  const current = ports.current();
  if (current.mode === "RESYNC_REQUIRED") return { tag: "RESYNC_REQUIRED" };
  if (request.targetRevision !== undefined && current.resolvedCursor < request.targetRevision) {
    return { tag: "TIMEOUT", resolvedCursor: current.resolvedCursor };
  }
  const selected = request.paths
    ? request.paths.map((item) => normalizeRelativeDocumentPath(item)).sort()
    : Object.keys(current.paths).sort();
  const statuses = selected.map((item) => [item, current.paths[item]?.status] as const);
  const conflicts = statuses.filter(([, status]) => status === "CONFLICT").map(([item]) => item);
  if (conflicts.length) return { tag: "LOCAL_CONFLICT", paths: conflicts };
  const blocked = statuses.filter(([, status]) => status === "APPLY_BLOCKED").map(([item]) => item);
  if (blocked.length) return { tag: "APPLY_BLOCKED", paths: blocked };
  const dirty = statuses.filter(([, status]) => status !== "CLEAN").map(([item]) => item);
  if (dirty.length) return { tag: "DIRTY", paths: dirty };
  if (!ports.writerExclusion || !ports.watcherFence) return { tag: "NONQUIESCENT" };
  const lease = await ports.writerExclusion.acquire(selected);
  if (!lease) return { tag: "NONQUIESCENT" };
  try {
    const fingerprints: Record<string, ManagedFingerprint> = {};
    for (const pathName of selected) {
      const observed = await fingerprintPath(ports.visiblePath(pathName));
      const expected = ports.current().paths[pathName]?.canonicalHidden.fingerprint;
      if (!expected || !sameFingerprint(observed, expected)) {
        return { tag: "DIRTY", paths: [pathName] };
      }
      fingerprints[pathName] = observed;
    }
    const watcherFenceVector = await ports.watcherFence.fence(selected);
    if (JSON.stringify(Object.keys(watcherFenceVector).sort()) !== JSON.stringify(selected)) {
      throw new Error("BROKER_WATCHER_FENCE_SET_MISMATCH");
    }
    const state = ports.current();
    const cutId = `cut-${state.epoch}-${state.resolvedCursor}-${state.nextJournalLSN}`;
    const witness: MaterializationWitness = {
      cutId,
      selectedDigest: fingerprintDigest(selected),
      cutKind: "HISTORICAL_EXCLUDED_SET",
      epoch: state.epoch,
      revision: state.resolvedCursor,
      fingerprints,
      watcherFenceVector,
      journalLSN: state.nextJournalLSN
    };
    await ports.persist({
      ...state,
      nextJournalLSN: state.nextJournalLSN + 1,
      witnesses: { ...state.witnesses, [cutId]: witness }
    });
    return { tag: "SATISFIED_EXACT_AT_CUT", witness };
  } finally {
    await lease.release();
  }
}
