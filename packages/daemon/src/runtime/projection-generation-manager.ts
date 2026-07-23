import path from "node:path";
import {
  type HarnessLayoutOverrides,
  type ProjectionSourceFence,
  type ProjectionSourceFenceReader
} from "@harness-anything/kernel";
import {
  ensureExecutionEvidenceGenerationReady,
  ProjectionGenerationChangedError,
  queryExecutionEvidencePageFromReadyGeneration,
  updateExecutionEvidenceProjectionIncrementally,
  type EnsureExecutionEvidenceGenerationResult,
  type ExecutionEvidencePage,
  type ExecutionEvidencePageQuery,
  type ReadyProjectionGeneration,
  type StableProjectionSourceFence
} from "@harness-anything/kernel/daemon-runtime-support";
import { measureCurrentDaemonRequestPerformancePhase } from "../observability/request-performance.ts";

export type DaemonProjectionGenerationState = "unknown" | "validating" | "ready";

export interface DaemonProjectionGenerationSnapshot {
  readonly state: DaemonProjectionGenerationState;
  readonly validationRuns: number;
  readonly invalidations: number;
  readonly hintedInvalidations: number;
  readonly fenceRuns: number;
  readonly reconciliationRuns: number;
  readonly fenceKind?: ProjectionSourceFence["kind"];
  readonly fenceReason?: Extract<ProjectionSourceFence, { readonly kind: "unknown" }>["reason"];
  readonly activeCanonicalWrites: number;
  readonly pendingTouchedPaths: number;
  readonly sourceHash?: string;
}

export interface DaemonProjectionCanonicalWriteLease {
  readonly settle: () => void;
}

export type DaemonProjectionPreparationMode = "full-readiness" | "incremental" | "rebuild" | "unchanged" | "custom";

export interface DaemonProjectionPreparationRequest {
  readonly touchedPaths: ReadonlyArray<string>;
  readonly previousSourceFingerprint?: string;
}

export interface DaemonProjectionPreparationEvent extends DaemonProjectionPreparationRequest {
  readonly mode: DaemonProjectionPreparationMode;
}

export interface DaemonProjectionGenerationManager {
  readonly queryExecutionEvidencePage: (query: ExecutionEvidencePageQuery) => Promise<ExecutionEvidencePage>;
  readonly beginCanonicalWrite: (touchedPaths: ReadonlyArray<string>) => DaemonProjectionCanonicalWriteLease;
  readonly invalidate: () => void;
  readonly reset: () => void;
  readonly close: () => Promise<void>;
  readonly snapshot: () => DaemonProjectionGenerationSnapshot;
}

export interface DaemonProjectionGenerationManagerOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly prepare?: (
    request: DaemonProjectionPreparationRequest
  ) => EnsureExecutionEvidenceGenerationResult | Promise<EnsureExecutionEvidenceGenerationResult>;
  readonly onPreparation?: (event: DaemonProjectionPreparationEvent) => void;
  readonly sourceFence?: ProjectionSourceFenceReader;
  readonly reconcileIntervalMs?: number | false;
}

export function createDaemonProjectionGenerationManager(
  options: DaemonProjectionGenerationManagerOptions
): DaemonProjectionGenerationManager {
  let state: DaemonProjectionGenerationState = "unknown";
  let validationRuns = 0;
  let invalidations = 0;
  let hintedInvalidations = 0;
  let fenceRuns = 0;
  let reconciliationRuns = 0;
  let revision = 0;
  let activeCanonicalWrites = 0;
  let ready: ReadyProjectionGeneration | undefined;
  let readyFence: StableProjectionSourceFence | undefined;
  let lastPreparedFence: StableProjectionSourceFence | undefined;
  let lastPreparedSourceFingerprint: string | undefined;
  let lastFenceKind: ProjectionSourceFence["kind"] | undefined;
  let lastFenceReason: Extract<ProjectionSourceFence, { readonly kind: "unknown" }>["reason"] | undefined;
  let inFlight: Promise<ReadyProjectionGeneration> | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let reconcileInFlight: Promise<void> | undefined;
  let canonicalWriteWaiters: Array<() => void> = [];
  const activeReads = new Set<Promise<ExecutionEvidencePage>>();
  const pendingTouchedPaths = new Set<string>();
  const prepare = options.prepare ?? prepareProjectionGeneration;
  const sourceFence = options.sourceFence ?? unknownProjectionSourceFenceReader;
  const unsubscribeFence = sourceFence.subscribe?.(hintInvalidate);
  const reconcileTimer = sourceFence.refresh && options.reconcileIntervalMs !== false
    ? setInterval(reconcileReadyGeneration, options.reconcileIntervalMs ?? 30_000)
    : undefined;
  reconcileTimer?.unref();

  return {
    queryExecutionEvidencePage: trackExecutionEvidencePage,
    beginCanonicalWrite,
    invalidate,
    reset,
    close,
    snapshot
  };

  function trackExecutionEvidencePage(query: ExecutionEvidencePageQuery): Promise<ExecutionEvidencePage> {
    if (closing) {
      return Promise.reject(new ProjectionGenerationChangedError("projection generation manager is closing"));
    }
    const read = measureCurrentDaemonRequestPerformancePhase(
      "projection",
      () => queryManagedExecutionEvidencePage(query)
    );
    activeReads.add(read);
    void read.finally(() => activeReads.delete(read)).catch(() => undefined);
    return read;
  }

  async function queryManagedExecutionEvidencePage(query: ExecutionEvidencePageQuery): Promise<ExecutionEvidencePage> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const requestRevision = revision;
      const current = await acquireReadyGeneration();
      if (revision !== requestRevision) continue;
      try {
        const page = queryExecutionEvidencePageFromReadyGeneration(current, query);
        if (revision === requestRevision) return page;
      } catch (error) {
        if (!(error instanceof ProjectionGenerationChangedError)) throw error;
        invalidate();
        if (query.cursor) throw error;
      }
      if (query.cursor) throw new ProjectionGenerationChangedError("projection generation changed during the evidence request");
    }
    throw new ProjectionGenerationChangedError("projection generation did not remain stable during the evidence request");
  }

  async function acquireReadyGeneration(): Promise<ReadyProjectionGeneration> {
    if (ready && readyFence) {
      const expectedReady = ready;
      const expectedFence = readyFence;
      const requestRevision = revision;
      const requestFence = await captureFence("request");
      if (
        revision === requestRevision &&
        ready === expectedReady &&
        requestFence.kind === "stable" &&
        requestFence.identity === expectedFence.identity
      ) {
        return expectedReady;
      }
      if (revision === requestRevision) invalidate();
    }
    if (inFlight) return inFlight;
    state = "validating";
    const pending = Promise.resolve().then(verifyOrPrepareCurrent);
    inFlight = pending;
    void pending.finally(() => {
      if (inFlight !== pending) return;
      inFlight = undefined;
      if (!ready) state = "unknown";
    }).catch(() => undefined);
    return pending;
  }

  async function verifyOrPrepareCurrent(): Promise<ReadyProjectionGeneration> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitForCanonicalWrites();
      const preparingRevision = revision;
      const before = await captureFence("refresh");
      if (revision !== preparingRevision) continue;
      if (before.kind === "stable" && ready && readyFence?.identity === before.identity) {
        state = "ready";
        return ready;
      }
      const preparation = preparationRequest(before);
      ready = undefined;
      readyFence = undefined;
      validationRuns += 1;
      const result = await prepare(preparation);
      options.onPreparation?.({
        ...preparation,
        mode: preparationMode(result)
      });
      if (revision !== preparingRevision) continue;
      if (before.kind === "unknown") {
        lastPreparedFence = undefined;
        lastPreparedSourceFingerprint = result.ready.sourceHash;
        pendingTouchedPaths.clear();
        state = "unknown";
        return result.ready;
      }
      const after = await captureFence("refresh");
      if (revision !== preparingRevision) continue;
      if (after.kind === "stable" && after.identity === before.identity) {
        ready = result.ready;
        readyFence = after;
        lastPreparedFence = after;
        lastPreparedSourceFingerprint = result.ready.sourceHash;
        pendingTouchedPaths.clear();
        state = "ready";
        return result.ready;
      }
    }
    throw new ProjectionGenerationChangedError("authored projection sources did not stabilize across validation");
  }

  function preparationRequest(before: ProjectionSourceFence): DaemonProjectionPreparationRequest {
    if (
      before.kind === "stable" &&
      lastPreparedFence &&
      lastPreparedSourceFingerprint &&
      before.headOid === lastPreparedFence.headOid
    ) {
      const touchedPaths = sortedResolvedPaths([
        ...pendingTouchedPaths,
        ...lastPreparedFence.changedPaths,
        ...before.changedPaths
      ]);
      if (touchedPaths.length > 0) {
        return {
          touchedPaths,
          previousSourceFingerprint: lastPreparedSourceFingerprint
        };
      }
    }
    return { touchedPaths: [] };
  }

  function prepareProjectionGeneration(
    request: DaemonProjectionPreparationRequest
  ): EnsureExecutionEvidenceGenerationResult & { readonly mode: Exclude<DaemonProjectionPreparationMode, "custom"> } {
    if (request.touchedPaths.length > 0 && request.previousSourceFingerprint) {
      const updated = updateExecutionEvidenceProjectionIncrementally({
        rootDir: options.rootDir,
        ...(options.layoutOverrides ? { layoutOverrides: options.layoutOverrides } : {}),
        touchedPaths: request.touchedPaths,
        previousSourceFingerprint: request.previousSourceFingerprint
      });
      return updated;
    }
    return {
      ...ensureExecutionEvidenceGenerationReady({
        rootDir: options.rootDir,
        ...(options.layoutOverrides ? { layoutOverrides: options.layoutOverrides } : {})
      }),
      mode: "full-readiness"
    };
  }

  async function captureFence(mode: "request" | "refresh"): Promise<ProjectionSourceFence> {
    fenceRuns += 1;
    const captured = await (mode === "refresh" && sourceFence.refresh
      ? sourceFence.refresh()
      : sourceFence.capture());
    lastFenceKind = captured.kind;
    lastFenceReason = captured.kind === "unknown" ? captured.reason : undefined;
    return captured;
  }

  function invalidate(): void {
    revision += 1;
    invalidations += 1;
    ready = undefined;
    readyFence = undefined;
    state = inFlight ? "validating" : "unknown";
  }

  function hintInvalidate(): void {
    if (!ready && state !== "validating") return;
    hintedInvalidations += 1;
    invalidate();
  }

  function reset(): void {
    revision += 1;
    ready = undefined;
    readyFence = undefined;
    lastPreparedFence = undefined;
    lastPreparedSourceFingerprint = undefined;
    pendingTouchedPaths.clear();
    state = inFlight ? "validating" : "unknown";
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    reset();
    if (reconcileTimer) clearInterval(reconcileTimer);
    unsubscribeFence?.();
    closePromise = Promise.allSettled([
      ...activeReads,
      ...(reconcileInFlight ? [reconcileInFlight] : [])
    ]).then(() => {
      sourceFence.close?.();
    });
    return closePromise;
  }

  function beginCanonicalWrite(touchedPaths: ReadonlyArray<string>): DaemonProjectionCanonicalWriteLease {
    const normalizedPaths = touchedPaths.map((touchedPath) => path.resolve(touchedPath));
    for (const touchedPath of normalizedPaths) pendingTouchedPaths.add(touchedPath);
    sourceFence.noteCanonicalPaths?.(normalizedPaths);
    activeCanonicalWrites += 1;
    invalidate();
    let settled = false;
    return {
      settle: () => {
        if (settled) return;
        settled = true;
        activeCanonicalWrites -= 1;
        revision += 1;
        ready = undefined;
        readyFence = undefined;
        state = inFlight ? "validating" : "unknown";
        if (activeCanonicalWrites === 0) {
          const waiters = canonicalWriteWaiters;
          canonicalWriteWaiters = [];
          for (const resolve of waiters) resolve();
        }
      }
    };
  }

  function waitForCanonicalWrites(): Promise<void> {
    if (activeCanonicalWrites === 0) return Promise.resolve();
    return new Promise<void>((resolve) => canonicalWriteWaiters.push(resolve));
  }

  function snapshot(): DaemonProjectionGenerationSnapshot {
    return {
      state,
      validationRuns,
      invalidations,
      hintedInvalidations,
      fenceRuns,
      reconciliationRuns,
      ...(lastFenceKind ? { fenceKind: lastFenceKind } : {}),
      ...(lastFenceReason ? { fenceReason: lastFenceReason } : {}),
      activeCanonicalWrites,
      pendingTouchedPaths: pendingTouchedPaths.size,
      ...(ready ? { sourceHash: ready.sourceHash } : {})
    };
  }

  function reconcileReadyGeneration(): void {
    if (closing || !ready || !readyFence || inFlight || reconcileInFlight || activeCanonicalWrites > 0) return;
    const expectedReady = ready;
    const expectedIdentity = readyFence.identity;
    const expectedRevision = revision;
    reconciliationRuns += 1;
    const pending = captureFence("refresh").then((captured) => {
      if (revision !== expectedRevision || ready !== expectedReady) return;
      if (captured.kind === "stable" && captured.identity === expectedIdentity) return;
      invalidate();
    }).finally(() => {
      if (reconcileInFlight === pending) reconcileInFlight = undefined;
    });
    reconcileInFlight = pending;
    void pending.catch(() => {
      if (revision === expectedRevision && ready === expectedReady) invalidate();
    });
  }
}

const unknownProjectionSourceFenceReader: ProjectionSourceFenceReader = {
  capture: () => ({ kind: "unknown", reason: "git-unavailable" })
};

function preparationMode(result: EnsureExecutionEvidenceGenerationResult): DaemonProjectionPreparationMode {
  if (!("mode" in result)) return "custom";
  const mode = result.mode;
  return mode === "full-readiness" || mode === "incremental" || mode === "rebuild" || mode === "unchanged"
    ? mode
    : "custom";
}

function sortedResolvedPaths(paths: Iterable<string>): ReadonlyArray<string> {
  return [...new Set([...paths].map((inputPath) => path.resolve(inputPath)))]
    .sort((left, right) => left.localeCompare(right));
}
