import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ReplicaChangeRecord } from "@harness-anything/application";
import {
  assertNoPortablePathCollisions,
  normalizeRelativeDocumentPath
} from "@harness-anything/kernel";
import { BrokerCasStore } from "./cas-store.ts";
import {
  BrokerReplicaIntegrityError,
  BrokerSubmitPreflightError
} from "./broker-errors.ts";
import { LocalConflictStore, type ConflictReason } from "./conflict-store.ts";
import { BrokerDurableStateStore } from "./durable-state-store.ts";
import {
  fingerprintBytes,
  fingerprintDigest,
  fingerprintPath,
  sameFingerprint,
  tombstoneFingerprint
} from "./fingerprint.ts";
import { CrashSafeNativeApplier } from "./native-applier.ts";
import { RemoteReplicaResyncRequiredError } from "./remote-read-down-session.ts";
import {
  hasPathStatus,
  isSubmittableDraft,
  localTombstone,
  mapConflictReason,
  maxRemoteResyncTransitionsPerSynchronization,
  sameResyncTarget,
  sameVersion,
  versionFor,
  versionOperationIds
} from "./replica-broker-state.ts";
import type {
  BrokerBarrierRequest,
  BrokerBarrierResult,
  BrokerDurableState,
  BrokerOptions,
  BrokerPathState,
  BrokerResyncTarget,
  BrokerVersion,
  CanonicalSnapshot,
  ManagedFingerprint,
  MaterializationWitness,
  PendingMaterialization
} from "./types.ts";

export class ReplicaBroker {
  readonly conflicts: LocalConflictStore;
  private readonly options: BrokerOptions;
  private readonly store: BrokerDurableStateStore;
  private readonly cas: BrokerCasStore;
  private readonly applier: CrashSafeNativeApplier;
  private state: BrokerDurableState | undefined;
  private synchronizationTask: Promise<BrokerDurableState> | undefined;

  constructor(options: BrokerOptions) {
    this.options = options;
    this.store = new BrokerDurableStateStore(options.stateRoot);
    this.cas = new BrokerCasStore(options.stateRoot);
    this.conflicts = new LocalConflictStore(options.stateRoot);
    this.applier = new CrashSafeNativeApplier({
      viewRoot: options.viewRoot,
      stateRoot: options.stateRoot,
      cas: this.cas,
      ...(options.crashInjector ? { crashInjector: options.crashInjector } : {})
    });
  }

  async initialize(): Promise<BrokerDurableState> {
    this.state = await this.store.initialize(this.options.workspaceId);
    await this.materializePending();
    return this.snapshotState();
  }

  synchronize(): Promise<BrokerDurableState> {
    if (this.synchronizationTask) return this.synchronizationTask;
    const task = this.synchronizeExclusive();
    this.synchronizationTask = task;
    void task.then(
      () => {
        if (this.synchronizationTask === task) this.synchronizationTask = undefined;
      },
      () => {
        if (this.synchronizationTask === task) this.synchronizationTask = undefined;
      }
    );
    return task;
  }
  private async synchronizeExclusive(): Promise<BrokerDurableState> {
    await this.ensureInitialized();
    let remoteResyncTransitions = 0;
    for (;;) {
      try {
        if (this.current().mode === "RESYNC_REQUIRED") {
          if (!this.current().resyncTarget) return this.snapshotState();
          await this.bootstrapResync();
        }
        while (this.current().resolvedCursor < this.current().receivedCursor) {
          await this.resolveChange(await this.store.readInbox(this.current().resolvedCursor + 1));
        }
        const changes = await this.options.replicaChangeLog.changesAfter(
          this.options.workspaceId,
          this.current().receivedCursor
        );
        for (const change of changes) {
          await this.receiveChange(change);
          await this.resolveChange(change);
        }
        return this.snapshotState();
      } catch (error) {
        if (!(error instanceof RemoteReplicaResyncRequiredError)) throw error;
        remoteResyncTransitions += 1;
        const advanced = await this.enterRemoteResync(error);
        if (!advanced || remoteResyncTransitions >= maxRemoteResyncTransitionsPerSynchronization) {
          throw error;
        }
      }
    }
  }

  async onNotification(change: ReplicaChangeRecord): Promise<BrokerDurableState> {
    await this.ensureInitialized();
    if (change.workspaceId !== this.options.workspaceId) throw new Error("replica notification belongs to another workspace");
    // Notifications are lossy hints. The durable ReplicaChangeLog query in
    // synchronize(), not the notification body, is the authoritative stream.
    return this.synchronize();
  }

  async recordLocalChange(pathName: string): Promise<BrokerPathState> {
    await this.ensureInitialized();
    const safePath = normalizeRelativeDocumentPath(pathName);
    const current = this.current();
    const existing = current.paths[safePath];
    const observed = await fingerprintPath(this.visiblePath(safePath));
    const overlayBase = existing?.overlayBase ?? existing?.visibleBase ?? null;
    const hiddenDiffers = Boolean(existing && (!overlayBase
      || !sameVersion(existing.canonicalHidden, overlayBase)));
    const nextPath: BrokerPathState = existing ? {
      ...existing,
      visibleWorkingFingerprint: observed,
      overlayBase,
      status: hiddenDiffers || existing.status === "CONFLICT" ? "CONFLICT" : "DIRTY"
    } : {
      canonicalHidden: localTombstone(current.epoch),
      visibleBase: null,
      visibleWorkingFingerprint: observed,
      status: "LOCAL_ONLY",
      overlayBase: null,
      pendingOpIds: []
    };
    await this.persist({ ...current, paths: { ...current.paths, [safePath]: nextPath } });
    return structuredClone(nextPath);
  }

  async prepareSubmission(pathName: string, opId: string): Promise<{
    readonly path: string;
    readonly content: Buffer;
    readonly contentFingerprint: ManagedFingerprint;
    readonly overlayBase: BrokerVersion | null;
  }> {
    await this.ensureInitialized();
    const safePath = normalizeRelativeDocumentPath(pathName);
    const current = this.current();
    const pathState = current.paths[safePath];
    if (!pathState || !isSubmittableDraft(pathState)) {
      throw new BrokerSubmitPreflightError(safePath, pathState?.status ?? "UNKNOWN", "path is not a submittable local draft");
    }
    if (pathState.pendingOpIds.length > 0) {
      throw new BrokerSubmitPreflightError(safePath, pathState.status, "path already has a pending operation");
    }
    const observed = await fingerprintPath(this.visiblePath(safePath));
    if (observed.objectKind !== "file" || !sameFingerprint(observed, pathState.visibleWorkingFingerprint)) {
      throw new BrokerSubmitPreflightError(safePath, pathState.status, "visible generation changed during submit preflight");
    }
    const content = await readFile(this.visiblePath(safePath));
    await this.cas.put(content);
    await this.persist({
      ...current,
      paths: {
        ...current.paths,
        [safePath]: { ...pathState, status: "SUBMITTING", pendingOpIds: [opId] }
      },
      nextJournalLSN: current.nextJournalLSN + 1
    });
    return { path: safePath, content, contentFingerprint: observed, overlayBase: pathState.overlayBase ?? pathState.visibleBase };
  }

  async markSubmissionUnknown(pathName: string, opId: string): Promise<void> {
    await this.updatePendingStatus(pathName, opId, "PENDING_UNKNOWN");
  }

  async markSubmissionRetryable(pathName: string, opId: string): Promise<void> {
    await this.ensureInitialized();
    const safePath = normalizeRelativeDocumentPath(pathName);
    const current = this.current();
    const state = current.paths[safePath];
    if (!state?.pendingOpIds.includes(opId)) throw new Error(`operation ${opId} is not pending for ${safePath}`);
    await this.persist({
      ...current,
      paths: { ...current.paths, [safePath]: { ...state, status: "DIRTY", pendingOpIds: [] } },
      nextJournalLSN: current.nextJournalLSN + 1
    });
  }

  async returnRejectedSubmission(pathName: string, opId: string, authorityReason: string): Promise<string> {
    await this.ensureInitialized();
    const safePath = normalizeRelativeDocumentPath(pathName);
    const current = this.current();
    const state = current.paths[safePath];
    if (!state || !state.pendingOpIds.includes(opId)) throw new Error(`operation ${opId} is not pending for ${safePath}`);
    const oursFingerprint = await fingerprintPath(this.visiblePath(safePath));
    const [base, ours, theirs] = await Promise.all([
      state.overlayBase?.fingerprint.objectKind === "file" ? this.cas.get(state.overlayBase.fingerprint.blobDigest) : undefined,
      oursFingerprint.objectKind === "file" ? readFile(this.visiblePath(safePath)) : undefined,
      state.canonicalHidden.fingerprint.objectKind === "file" ? this.cas.get(state.canonicalHidden.fingerprint.blobDigest) : undefined
    ]);
    const event = await this.conflicts.create({
      workspaceId: this.options.workspaceId,
      viewId: this.options.viewId,
      path: safePath,
      reason: authorityReason.includes("BLOCKED_DECISION") ? "BLOCKED_DECISION" : "AUTHORITY_REJECTED",
      baseVersion: state.overlayBase ?? state.visibleBase,
      theirsVersion: state.canonicalHidden,
      oursFingerprint,
      authorityReason,
      opId,
      notify: false,
      ...(base ? { base } : {}),
      ...(ours ? { ours } : {}),
      ...(theirs ? { theirs } : {})
    });
    await this.persist({
      ...current,
      paths: {
        ...current.paths,
        [safePath]: {
          ...state,
          status: "CONFLICT",
          pendingOpIds: [],
          conflictId: event.record.conflictId,
          visibleWorkingFingerprint: oursFingerprint
        }
      },
      nextJournalLSN: current.nextJournalLSN + 1
    });
    await this.conflicts.publish(event);
    return event.record.conflictId;
  }

  pathState(pathName: string): BrokerPathState | undefined {
    const safePath = normalizeRelativeDocumentPath(pathName);
    const value = this.current().paths[safePath];
    return value ? structuredClone(value) : undefined;
  }

  snapshotState(): BrokerDurableState {
    return structuredClone(this.current());
  }

  async barrier(request: BrokerBarrierRequest = {}): Promise<BrokerBarrierResult> {
    await this.ensureInitialized();
    const current = this.current();
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
    if (!this.options.writerExclusion || !this.options.watcherFence) return { tag: "NONQUIESCENT" };
    const lease = await this.options.writerExclusion.acquire(selected);
    if (!lease) return { tag: "NONQUIESCENT" };
    try {
      const fingerprints: Record<string, ManagedFingerprint> = {};
      for (const pathName of selected) {
        const observed = await fingerprintPath(this.visiblePath(pathName));
        const expected = this.current().paths[pathName]?.canonicalHidden.fingerprint;
        if (!expected || !sameFingerprint(observed, expected)) return { tag: "DIRTY", paths: [pathName] };
        fingerprints[pathName] = observed;
      }
      const watcherFenceVector = await this.options.watcherFence.fence(selected);
      const fencedPaths = Object.keys(watcherFenceVector).sort();
      if (JSON.stringify(fencedPaths) !== JSON.stringify(selected)) {
        throw new Error("BROKER_WATCHER_FENCE_SET_MISMATCH");
      }
      const state = this.current();
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
      await this.persist({
        ...state,
        nextJournalLSN: state.nextJournalLSN + 1,
        witnesses: { ...state.witnesses, [cutId]: witness }
      });
      return { tag: "SATISFIED_EXACT_AT_CUT", witness };
    } finally {
      await lease.release();
    }
  }

  private async receiveChange(change: ReplicaChangeRecord): Promise<void> {
    const current = this.current();
    if (change.workspaceId !== this.options.workspaceId
      || change.revision !== current.receivedCursor + 1
      || change.previousCommit !== current.receivedCommit) {
      if (this.options.replicaGapPolicy === "TERMINAL") {
        throw new BrokerReplicaIntegrityError(
          `replica change gap or parent mismatch at revision ${change.revision}`
        );
      }
      await this.enterResync();
      throw new Error(`replica change gap or parent mismatch at revision ${change.revision}`);
    }
    await this.store.appendInbox(change);
    await this.persist({
      ...current,
      receivedCursor: change.revision,
      receivedCommit: change.commitSha,
      nextJournalLSN: current.nextJournalLSN + 1
    });
  }

  private async resolveChange(change: ReplicaChangeRecord): Promise<void> {
    const snapshot = await this.options.snapshotSource.snapshotAt(change);
    this.validateSnapshot(snapshot, change.revision, change.commitSha);
    await this.resolveSnapshot(snapshot, change, this.current().epoch, false);
  }

  private async resolveSnapshot(
    snapshot: CanonicalSnapshot,
    change: ReplicaChangeRecord | null,
    epoch: string,
    resync: boolean
  ): Promise<void> {
    const entries = new Map<string, { readonly fingerprint: ManagedFingerprint; readonly bytes: Uint8Array }>();
    const normalizedPaths: string[] = [];
    for (const entry of snapshot.entries) {
      const safePath = normalizeRelativeDocumentPath(entry.path);
      normalizedPaths.push(safePath);
      const fingerprint = fingerprintBytes(entry.content, entry.logicalMode ?? 0o644);
      await this.cas.put(entry.content);
      entries.set(safePath, { fingerprint, bytes: entry.content });
    }
    assertNoPortablePathCollisions(normalizedPaths);
    if (entries.size !== normalizedPaths.length) throw new Error("snapshot contains duplicate paths");
    const current = this.current();
    const allPaths = new Set([...Object.keys(current.paths), ...entries.keys()]);
    const paths: Record<string, BrokerPathState> = { ...current.paths };
    const pending: PendingMaterialization[] = [];
    for (const pathName of [...allPaths].sort()) {
      const old = current.paths[pathName];
      const targetFingerprint = entries.get(pathName)?.fingerprint ?? tombstoneFingerprint();
      const changed = !old
        || old.canonicalHidden.epoch !== epoch
        || !sameFingerprint(old.canonicalHidden.fingerprint, targetFingerprint);
      const target = changed
        ? versionFor(change, pathName, targetFingerprint, epoch, snapshot.revision, snapshot.commitSha)
        : old.canonicalHidden;
      if (!old) {
        paths[pathName] = {
          canonicalHidden: target,
          visibleBase: null,
          visibleWorkingFingerprint: tombstoneFingerprint(),
          status: "CLEAN",
          pendingOpIds: []
        };
      } else {
        paths[pathName] = { ...old, canonicalHidden: target };
      }
      if (changed) pending.push({ path: pathName, target });
    }
    await this.persist({
      ...current,
      epoch,
      receivedCursor: resync ? snapshot.revision : current.receivedCursor,
      receivedCommit: resync ? snapshot.commitSha : current.receivedCommit,
      resolvedCursor: snapshot.revision,
      resolvedCommit: snapshot.commitSha,
      nextJournalLSN: current.nextJournalLSN + 1,
      paths,
      pendingMaterializations: [...current.pendingMaterializations, ...pending]
    });
    await this.options.crashInjector?.hit("after_hidden_resolved", "*");
    await this.materializePending();
  }

  private async materializePending(): Promise<void> {
    while (this.current().pendingMaterializations.length > 0) {
      const pending = this.current().pendingMaterializations[0]!;
      const pathState = this.current().paths[pending.path]!;
      const observed = await fingerprintPath(this.visiblePath(pending.path));
      const matchingSubmittedOpId = versionOperationIds(pending.target)
        .find((opId) => pathState.pendingOpIds.includes(opId));
      const matchingSubmittedCandidate = matchingSubmittedOpId !== undefined
        && sameFingerprint(observed, pending.target.fingerprint);
      const expected = matchingSubmittedCandidate
        ? observed
        : pathState.visibleBase?.fingerprint ?? tombstoneFingerprint();
      if (!hasPathStatus(pathState, "CLEAN") && !matchingSubmittedCandidate) {
        await this.createPathConflict(pending.path, pathState, pending.target, observed, "REMOTE_CHANGED_DIRTY_PATH");
        continue;
      }
      const result = await this.applier.apply(pending.path, expected, pending.target);
      if (result.tag === "APPLIED") {
        // Exact path/frontier evidence may advance only after the apply
        // journal itself has a durable RESOLVED record.
        await this.applier.markResolved(result.applyId);
        const current = this.current();
        const existing = current.paths[pending.path]!;
        await this.persist({
          ...current,
          paths: {
            ...current.paths,
            [pending.path]: {
              ...existing,
              visibleBase: pending.target,
              visibleWorkingFingerprint: result.fingerprint,
              status: "CLEAN",
              pendingOpIds: matchingSubmittedCandidate
                ? existing.pendingOpIds.filter((opId) => opId !== matchingSubmittedOpId)
                : existing.pendingOpIds
            }
          },
          pendingMaterializations: current.pendingMaterializations.slice(1),
          nextJournalLSN: current.nextJournalLSN + 1
        });
        continue;
      }
      if (result.tag === "CONFLICT") {
        await this.createPathConflict(pending.path, pathState, pending.target, result.observed, mapConflictReason(result.reason));
        continue;
      }
      const current = this.current();
      await this.persist({
        ...current,
        paths: {
          ...current.paths,
          [pending.path]: { ...pathState, status: "APPLY_BLOCKED", applyBlockedReason: result.reason }
        },
        pendingMaterializations: current.pendingMaterializations.slice(1)
      });
    }
  }

  private async createPathConflict(
    pathName: string,
    state: BrokerPathState,
    theirs: BrokerVersion,
    oursFingerprint: ManagedFingerprint,
    reason: ConflictReason
  ): Promise<void> {
    const [base, ours, theirsBytes] = await Promise.all([
      state.visibleBase?.fingerprint.objectKind === "file" ? this.cas.get(state.visibleBase.fingerprint.blobDigest) : undefined,
      oursFingerprint.objectKind === "file" ? readFile(this.visiblePath(pathName)) : undefined,
      theirs.fingerprint.objectKind === "file" ? this.cas.get(theirs.fingerprint.blobDigest) : undefined
    ]);
    const event = await this.conflicts.create({
      workspaceId: this.options.workspaceId,
      viewId: this.options.viewId,
      path: pathName,
      reason,
      baseVersion: state.visibleBase,
      theirsVersion: theirs,
      oursFingerprint,
      notify: false,
      ...(base ? { base } : {}),
      ...(ours ? { ours } : {}),
      ...(theirsBytes ? { theirs: theirsBytes } : {})
    });
    const current = this.current();
    await this.persist({
      ...current,
      paths: {
        ...current.paths,
        [pathName]: {
          ...current.paths[pathName]!,
          visibleWorkingFingerprint: oursFingerprint,
          status: "CONFLICT",
          overlayBase: state.overlayBase ?? state.visibleBase,
          conflictId: event.record.conflictId
        }
      },
      pendingMaterializations: current.pendingMaterializations.slice(1)
    });
    await this.conflicts.publish(event);
  }

  private validateSnapshot(snapshot: CanonicalSnapshot, revision: number, commitSha: string): void {
    if (snapshot.workspaceId !== this.options.workspaceId
      || snapshot.revision !== revision
      || snapshot.commitSha !== commitSha) {
      throw new Error("snapshot identity does not match replica change");
    }
  }

  private async enterResync(): Promise<void> {
    await this.persist({ ...this.current(), mode: "RESYNC_REQUIRED" });
  }

  private async enterRemoteResync(error: RemoteReplicaResyncRequiredError): Promise<boolean> {
    const { cut, cutChange } = error;
    if (cut.workspaceId !== this.options.workspaceId
      || (cutChange !== null && (cutChange.workspaceId !== this.options.workspaceId
        || cutChange.revision !== cut.revision
        || cutChange.commitSha !== cut.commitSha))
      || (cut.revision > 0 && !cutChange)) {
      throw new Error("remote resync cut identity does not match broker workspace");
    }
    const resyncTarget: BrokerResyncTarget = {
      epoch: cut.epoch,
      revision: cut.revision,
      commitSha: cut.commitSha,
      cutChange
    };
    const current = this.current();
    if (sameResyncTarget(current.resyncTarget, resyncTarget)) return false;
    await this.persist({
      ...current,
      mode: "RESYNC_REQUIRED",
      resyncTarget,
      nextJournalLSN: current.nextJournalLSN + 1
    });
    return true;
  }

  private async bootstrapResync(): Promise<void> {
    const target = this.current().resyncTarget;
    if (!target) return;
    const snapshot: CanonicalSnapshot = target.cutChange
      ? await this.options.snapshotSource.snapshotAt(target.cutChange)
      : {
          workspaceId: this.options.workspaceId,
          revision: target.revision,
          commitSha: target.commitSha,
          entries: []
        };
    this.validateSnapshot(snapshot, target.revision, target.commitSha);
    await this.resolveSnapshot(snapshot, target.cutChange, target.epoch, true);
    const current = this.current();
    await this.persist({
      ...current,
      mode: "READY",
      resyncTarget: undefined,
      nextJournalLSN: current.nextJournalLSN + 1
    });
  }

  private async updatePendingStatus(
    pathName: string,
    opId: string,
    status: Extract<BrokerPathState["status"], "PENDING_UNKNOWN">
  ): Promise<void> {
    await this.ensureInitialized();
    const safePath = normalizeRelativeDocumentPath(pathName);
    const current = this.current();
    const state = current.paths[safePath];
    if (!state?.pendingOpIds.includes(opId)) throw new Error(`operation ${opId} is not pending for ${safePath}`);
    await this.persist({
      ...current,
      paths: { ...current.paths, [safePath]: { ...state, status } },
      nextJournalLSN: current.nextJournalLSN + 1
    });
  }

  private async persist(state: BrokerDurableState): Promise<void> {
    await this.store.save(state);
    this.state = state;
  }

  private current(): BrokerDurableState {
    if (!this.state) throw new Error("broker is not initialized");
    return this.state;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.state) await this.initialize();
  }

  private visiblePath(pathName: string): string {
    return path.join(this.options.viewRoot, ...pathName.split("/"));
  }
}
