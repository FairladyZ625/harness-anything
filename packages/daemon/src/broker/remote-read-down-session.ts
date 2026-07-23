import type { ReplicaChangeRecord } from "@harness-anything/application";
import { manifestDigest } from "../authority/replication-content-store.ts";
import type {
  AuthoritySnapshotManifestEntry,
  AuthoritySnapshotReservation
} from "../authority/protocol.ts";
import { AuthorityTransportDisconnectedError } from "../transport/persistent-ssh-authority-client.ts";
import { RemoteBlobReader } from "./remote-blob-reader.ts";
import { BrokerCasStore } from "./cas-store.ts";
import {
  assertBackoff,
  assertChangeCache,
  defaultBackoff,
  defaultChangeCache,
  RemoteReplicaResyncRequiredError,
  type ActiveSnapshot,
  type RemoteReadDownBackoff,
  type RemoteReadDownChangeCacheLimits,
  type RemoteReadDownSessionOptions,
  type ResumeCursor
} from "./remote-read-down-contract.ts";
import {
  applyChange,
  assertChangeManifest,
  assertCutChange,
  assertManifest,
  compareManifestPaths,
  isIntegrityError,
  isResyncError,
  mapInBatches,
  pruneChanges,
  sameChangeIdentity,
  storeCachedChange,
  validateChanges
} from "./remote-read-down-content.ts";
import type { CanonicalSnapshot } from "./types.ts";

export {
  RemoteReplicaResyncRequiredError,
  type RemoteReadDownBackoff,
  type RemoteReadDownChangeCacheLimits,
  type RemoteReadDownSessionOptions
} from "./remote-read-down-contract.ts";

export class RemoteReadDownSession {
  private readonly options: RemoteReadDownSessionOptions;
  private readonly cas: BrokerCasStore;
  private readonly blobReader: RemoteBlobReader;
  private readonly backoff: RemoteReadDownBackoff;
  private readonly changeCache: RemoteReadDownChangeCacheLimits;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly listeners = new Set<(change: ReplicaChangeRecord) => void>();
  private active: ActiveSnapshot | undefined;
  private recovery: { readonly generation: number; readonly promise: Promise<ActiveSnapshot> } | undefined;
  private renewalTask: { readonly dispose: () => void } | undefined;
  private renewalOperation: Promise<void> | undefined;
  private stopped = false;
  private closeTask: Promise<void> | undefined;
  private lifecycleGeneration = 0;
  private resumeCursor: ResumeCursor | undefined;
  private terminalError: Error | undefined;
  private notificationPump: Promise<void> | undefined;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly changeEpochs = new WeakMap<ReplicaChangeRecord, string>();
  private readonly stoppedSignal: Promise<void>;
  private resolveStopped!: () => void;
  private readonly removeNotificationListener: () => void;
  private readonly removeDisconnectListener: () => void;

  constructor(options: RemoteReadDownSessionOptions) {
    this.options = options;
    this.cas = new BrokerCasStore(options.stateRoot);
    this.blobReader = new RemoteBlobReader(this.cas, options.client, () => this.assertOpen());
    this.backoff = { ...defaultBackoff, ...options.backoff };
    this.changeCache = { ...defaultChangeCache, ...options.changeCache };
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.stoppedSignal = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
    assertBackoff(this.backoff);
    assertChangeCache(this.changeCache);
    this.removeNotificationListener = options.client.onNotification((change) => this.receiveNotification(change));
    this.removeDisconnectListener = options.client.onDisconnect(() => this.handleDisconnect());
  }

  get workspaceId(): string {
    return this.options.workspaceId;
  }

  subscribe(listener: (change: ReplicaChangeRecord) => void): () => void {
    this.listeners.add(listener);
    this.queueRecovery("remote read-down start failed");
    return () => this.listeners.delete(listener);
  }

  latest(): Promise<ReplicaChangeRecord | undefined> {
    return this.runOperation(() => this.readLatest());
  }

  private async readLatest(): Promise<ReplicaChangeRecord | undefined> {
    const active = await this.ready();
    await this.fetchAfter(active, highestKnownRevision(active));
    return active.changes.get(active.highestRevision) ?? active.cutChange ?? undefined;
  }

  getByOperation(opId: string): Promise<ReplicaChangeRecord | undefined> {
    return this.runOperation(() => this.readByOperation(opId));
  }

  private async readByOperation(opId: string): Promise<ReplicaChangeRecord | undefined> {
    const active = await this.ready();
    await this.fetchAfter(active, highestKnownRevision(active));
    if (active.cutChange?.operations.some((operation) => operation.opId === opId)) return active.cutChange;
    for (const change of active.changes.values()) {
      if (change.operations.some((operation) => operation.opId === opId)) return change;
    }
    return undefined;
  }

  changesAfter(revision: number): Promise<ReadonlyArray<ReplicaChangeRecord>> {
    return this.runOperation(() => this.readChangesAfter(revision));
  }

  private async readChangesAfter(revision: number): Promise<ReadonlyArray<ReplicaChangeRecord>> {
    const active = await this.ready();
    const cutRevision = active.reservation.cut.revision;
    if (active.resyncReason) {
      if (!active.resyncReported || revision < cutRevision) {
        active.resyncReported = true;
        throw resyncError(active, active.resyncReason);
      }
      active.resyncReason = undefined;
    }
    if (revision < cutRevision) {
      throw resyncError(
        active,
        `CURSOR_PRECEDES_PINNED_CUT:${revision}:${cutRevision}`,
      );
    }
    active.adopted = true;
    active.deliveredRevision = Math.max(active.deliveredRevision, revision);
    active.durableCursor = Math.max(active.durableCursor, revision);
    pruneChanges(active, active.durableCursor);
    const changes = await this.fetchAfter(active, revision);
    this.queueNotificationPump();
    return changes;
  }

  snapshotAt(change: ReplicaChangeRecord): Promise<CanonicalSnapshot> {
    return this.runOperation(() => this.readSnapshotAt(change));
  }

  private async readSnapshotAt(change: ReplicaChangeRecord): Promise<CanonicalSnapshot> {
    const active = await this.ready();
    if (change.workspaceId !== this.options.workspaceId) {
      throw new Error("remote snapshot change belongs to another workspace");
    }
    const observedEpoch = this.changeEpochs.get(change);
    if (observedEpoch && observedEpoch !== active.reservation.cut.epoch) {
      throw resyncError(active, `CHANGE_EPOCH_MISMATCH:${observedEpoch}:${active.reservation.cut.epoch}`);
    }
    const entries = await this.entriesAt(active, change);
    const orderedEntries = [...entries.values()].sort(compareManifestPaths);
    const uniqueDigests = [...new Set(orderedEntries.map((entry) => entry.blobDigest))];
    const blobs = new Map<string, Buffer>();
    await mapInBatches(uniqueDigests, 8, async (blobDigest) => {
      blobs.set(blobDigest, await this.readBlob(active, blobDigest));
    });
    const snapshotEntries = orderedEntries.map((entry) => ({
      path: entry.path,
      content: blobs.get(entry.blobDigest)!,
      logicalMode: Number.parseInt(entry.mode, 8)
    }));
    return {
      workspaceId: change.workspaceId,
      revision: change.revision,
      commitSha: change.commitSha,
      entries: snapshotEntries
    };
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.stopped = true;
    this.lifecycleGeneration += 1;
    this.resolveStopped();
    this.renewalTask?.dispose();
    this.renewalTask = undefined;
    this.removeNotificationListener();
    this.removeDisconnectListener();
    this.closeTask = this.finishClose();
    return this.closeTask;
  }

  private async finishClose(): Promise<void> {
    await this.options.client.close();
    for (;;) {
      const pending = [
        ...this.operations,
        ...(this.recovery ? [this.recovery.promise] : []),
        ...(this.notificationPump ? [this.notificationPump] : []),
        ...(this.renewalOperation ? [this.renewalOperation] : []),
        ...this.blobReader.pending()
      ];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private async ready(): Promise<ActiveSnapshot> {
    if (this.stopped) throw new Error("remote read-down session is closed");
    if (this.terminalError) throw this.terminalError;
    if (this.active) return this.active;
    if (this.recovery) return this.recovery.promise;
    const generation = this.lifecycleGeneration;
    const promise = this.recover(generation);
    const recovery = { generation, promise };
    this.recovery = recovery;
    void promise.then(
      () => {
        if (this.recovery === recovery) this.recovery = undefined;
      },
      () => {
        if (this.recovery === recovery) this.recovery = undefined;
      }
    );
    return promise;
  }

  private async recover(generation: number): Promise<ActiveSnapshot> {
    let delay = this.backoff.initialMs;
    let replaceConnection = this.resumeCursor !== undefined;
    for (;;) {
      try {
        if (replaceConnection) {
          await this.options.client.reconnect();
        } else {
          await this.options.client.connect();
        }
        this.assertRecoveryCurrent(generation);
        const active = await this.openSnapshot(this.resumeCursor);
        this.assertRecoveryCurrent(generation);
        if (this.active) return this.active;
        this.active = active;
        this.scheduleRenewal(active);
        this.queueNotificationPump();
        return active;
      } catch (error) {
        if (this.stopped) throw readDownError(error);
        if (generation !== this.lifecycleGeneration) {
          throw new AuthorityTransportDisconnectedError("remote read-down recovery generation changed");
        }
        if (isIntegrityError(error)) {
          this.terminalError = readDownError(error);
          throw this.terminalError;
        }
        this.options.onDiagnostic?.(`remote read-down reconnect failed; retrying in ${delay}ms: ${readDownError(error).message}`);
        await this.interruptibleSleep(delay);
        this.assertRecoveryCurrent(generation);
        delay = Math.min(this.backoff.maximumMs, Math.max(delay + 1, Math.ceil(delay * this.backoff.multiplier)));
        replaceConnection = true;
      }
    }
  }

  private async openSnapshot(resume: ResumeCursor | undefined): Promise<ActiveSnapshot> {
    const reservation = await this.options.client.beginSnapshotAndSubscribe();
    this.assertOpen();
    const manifest = await this.options.client.getSnapshotManifest(
      reservation.stream.streamToken,
      reservation.cut.manifestDigest
    );
    this.assertOpen();
    assertManifest(reservation, manifest, this.options.workspaceId);
    const cutChange = await this.options.client.getCutChange(reservation.stream.streamToken);
    this.assertOpen();
    assertCutChange(reservation, cutChange);
    if (cutChange) this.changeEpochs.set(cutChange, reservation.cut.epoch);
    const baseEntries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    if (baseEntries.size !== manifest.entries.length) throw new Error("authority snapshot manifest contains duplicate paths");
    const uniqueDigests = [...new Set(manifest.entries.map((entry) => entry.blobDigest))];
    await mapInBatches(
      uniqueDigests,
      8,
      (blobDigest) => this.readBlobFromReservation(reservation, blobDigest)
    );
    this.assertOpen();
    const sameEpoch = resume?.epoch === reservation.cut.epoch;
    const canResume = Boolean(resume && sameEpoch && reservation.cut.revision <= resume.deliveredRevision);
    const resyncReason = resume && !sameEpoch
      ? `EPOCH_CHANGED:${resume.epoch}:${reservation.cut.epoch}`
      : resume && !canResume
        ? `CURSOR_PRECEDES_RECONNECTED_CUT:${resume.deliveredRevision}:${reservation.cut.revision}`
        : undefined;
    return {
      reservation,
      cutChange,
      baseEntries,
      changes: new Map(),
      changeSizes: new Map(),
      changeBytes: 0,
      highestRevision: reservation.cut.revision,
      durableCursor: reservation.cut.revision,
      adopted: canResume || (!resume && reservation.cut.revision === 0),
      deliveredRevision: canResume ? resume!.deliveredRevision : reservation.cut.revision,
      ...(resyncReason ? { resyncReason } : {}),
      resyncSignaled: false,
      resyncReported: false
    };
  }

  private async fetchAfter(active: ActiveSnapshot, revision: number): Promise<ReadonlyArray<ReplicaChangeRecord>> {
    try {
      this.assertCurrent(active);
      const result = await this.options.client.changesAfter(active.reservation.stream.streamToken, revision);
      this.assertCurrent(active);
      validateChanges(result.changes, revision, this.options.workspaceId);
      for (const change of result.changes) this.storeChange(active, change, false);
      return result.changes;
    } catch (error) {
      if (this.stopped) throw readDownError(error);
      if (isResyncError(error)) {
        this.invalidateActive(active);
        const next = await this.ready();
        throw resyncError(next, error.message);
      }
      if (error instanceof AuthorityTransportDisconnectedError) {
        this.invalidateActive(active);
        const next = await this.ready();
        if (next.resyncReason) throw resyncError(next, next.resyncReason);
        if (revision < next.reservation.cut.revision) {
          throw resyncError(
            next,
            `CURSOR_PRECEDES_RECONNECTED_CUT:${revision}:${next.reservation.cut.revision}`,
          );
        }
        return this.fetchAfter(next, revision);
      }
      throw error;
    }
  }

  private async entriesAt(
    active: ActiveSnapshot,
    change: ReplicaChangeRecord
  ): Promise<ReadonlyMap<string, AuthoritySnapshotManifestEntry>> {
    const cut = active.reservation.cut;
    if (change.revision < cut.revision) {
      throw resyncError(
        active,
        `SNAPSHOT_PRECEDES_PINNED_CUT:${change.revision}:${cut.revision}`,
      );
    }
    if (change.revision > cut.revision) await this.fetchAfter(active, cut.revision);
    const canonical = change.revision === cut.revision
      ? active.cutChange
      : active.changes.get(change.revision);
    if (!canonical || !sameChangeIdentity(canonical, change)) {
      throw resyncError(active, `CHANGE_IDENTITY_MISMATCH:${change.revision}`);
    }
    const entries = new Map(active.baseEntries);
    for (let revision = cut.revision + 1; revision <= change.revision; revision += 1) {
      const next = active.changes.get(revision);
      if (!next) throw new Error(`remote snapshot change gap at revision ${revision}`);
      applyChange(entries, next);
      assertChangeManifest(cut.epoch, next, entries);
    }
    if (change.revision === cut.revision) {
      const actual = manifestDigest(cut, [...entries.values()]);
      if (actual !== change.manifest.digest) throw new Error(`MANIFEST_DIGEST_MISMATCH:${change.manifest.digest}:${actual}`);
    }
    return entries;
  }

  private async readBlob(active: ActiveSnapshot, digest: AuthoritySnapshotManifestEntry["blobDigest"]): Promise<Buffer> {
    this.assertCurrent(active);
    return this.readBlobFromReservation(active.reservation, digest);
  }

  private async readBlobFromReservation(
    reservation: AuthoritySnapshotReservation,
    digest: AuthoritySnapshotManifestEntry["blobDigest"]
  ): Promise<Buffer> {
    return this.blobReader.read(reservation, digest);
  }

  private receiveNotification(change: ReplicaChangeRecord): void {
    const active = this.active;
    if (!active || change.workspaceId !== this.options.workspaceId) return;
    if (change.revision <= active.reservation.cut.revision) return;
    try {
      this.storeChange(active, change, true);
    } catch (error) {
      this.terminalError = readDownError(error);
      this.invalidateActive(active);
      this.options.onDiagnostic?.(`remote read-down notification rejected: ${this.terminalError.message}`);
      return;
    }
    this.queueNotificationPump();
  }

  private queueNotificationPump(): void {
    if (this.stopped) return;
    void this.pumpNotifications().catch((error) => {
      if (this.stopped) return;
      this.options.onDiagnostic?.(`remote read-down notification pump stopped: ${readDownError(error).message}`);
    });
  }

  private async pumpNotifications(): Promise<void> {
    if (this.notificationPump) return this.notificationPump;
    this.notificationPump = this.flushNotifications().finally(() => {
      this.notificationPump = undefined;
    });
    return this.notificationPump;
  }

  private async flushNotifications(): Promise<void> {
    const active = this.active;
    if (!active || this.listeners.size === 0) return;
    if (active.resyncReason) {
      if (!active.resyncSignaled && active.cutChange) {
        active.resyncSignaled = true;
        this.notifyListeners(active.cutChange);
      }
      return;
    }
    if (!active.adopted) return;
    for (;;) {
      if (this.stopped || this.active !== active) return;
      const expected = active.deliveredRevision + 1;
      let change = active.changes.get(expected);
      if (!change) {
        const fetched = await this.fetchAfter(active, active.deliveredRevision);
        change = fetched[0];
      }
      if (!change || change.revision !== expected) return;
      active.deliveredRevision = change.revision;
      this.resumeCursor = { epoch: active.reservation.cut.epoch, deliveredRevision: active.deliveredRevision };
      this.notifyListeners(change);
      pruneChanges(active, active.deliveredRevision);
    }
  }

  private handleDisconnect(): void {
    if (this.stopped) return;
    const active = this.active;
    if (active) this.invalidateActive(active);
    this.queueRecovery("remote read-down recovery stopped");
  }

  private scheduleRenewal(active: ActiveSnapshot): void {
    this.renewalTask?.dispose();
    const expiresAt = Date.parse(active.reservation.lease.expiresAt);
    const renewableUntil = Date.parse(active.reservation.lease.renewableUntil);
    const remaining = expiresAt - this.now();
    const delay = Math.max(0, Math.min(remaining / 2, renewableUntil - this.now()));
    const schedule = this.options.schedule ?? defaultSchedule;
    this.renewalTask = schedule(delay, () => {
      if (this.stopped) return;
      const operation = this.renew(active);
      this.renewalOperation = operation;
      void operation.then(
        () => {
          if (this.renewalOperation === operation) this.renewalOperation = undefined;
        },
        () => {
          if (this.renewalOperation === operation) this.renewalOperation = undefined;
        }
      );
    });
  }

  private async renew(active: ActiveSnapshot): Promise<void> {
    if (this.active !== active || this.stopped) return;
    try {
      if (this.now() >= Date.parse(active.reservation.lease.renewableUntil)) {
        throw resyncError(
          active,
          "LEASE_RENEWAL_LIMIT_REACHED",
        );
      }
      const lease = await this.options.client.renewLease(active.reservation.stream.streamToken);
      if (this.stopped || this.active !== active) return;
      const renewed: ActiveSnapshot = {
        ...active,
        reservation: { ...active.reservation, lease }
      };
      this.active = renewed;
      this.scheduleRenewal(renewed);
    } catch (error) {
      if (this.stopped || this.active !== active) return;
      this.options.onDiagnostic?.(`remote read-down lease requires resnapshot: ${readDownError(error).message}`);
      this.invalidateActive(active);
      this.queueRecovery("remote read-down lease recovery failed");
    }
  }

  private storeChange(active: ActiveSnapshot, change: ReplicaChangeRecord, lossyHint: boolean): void {
    if (storeCachedChange(active, change, this.changeCache, lossyHint)) {
      this.changeEpochs.set(change, active.reservation.cut.epoch);
    }
  }

  private invalidateActive(active: ActiveSnapshot): boolean {
    if (this.active !== active) return false;
    this.resumeCursor = {
      epoch: active.reservation.cut.epoch,
      deliveredRevision: active.deliveredRevision
    };
    this.active = undefined;
    this.lifecycleGeneration += 1;
    this.recovery = undefined;
    this.renewalTask?.dispose();
    this.renewalTask = undefined;
    return true;
  }

  private notifyListeners(change: ReplicaChangeRecord): void {
    const active = this.active;
    if (active) this.changeEpochs.set(change, active.reservation.cut.epoch);
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.options.onDiagnostic?.(`remote read-down notification listener failed: ${readDownError(error).message}`);
      }
    }
  }

  private queueRecovery(description: string): void {
    if (this.stopped || this.terminalError) return;
    void this.ready().catch((error) => {
      if (this.stopped) return;
      if (error instanceof AuthorityTransportDisconnectedError && !this.active) {
        queueMicrotask(() => this.queueRecovery(description));
        return;
      }
      this.options.onDiagnostic?.(`${description}: ${readDownError(error).message}`);
    });
  }

  private runOperation<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.stopped) return Promise.reject(new Error("remote read-down session is closed"));
    const task = operation();
    this.operations.add(task);
    void task.then(
      () => this.operations.delete(task),
      () => this.operations.delete(task)
    );
    return task;
  }

  private async interruptibleSleep(milliseconds: number): Promise<void> {
    await Promise.race([
      this.sleep(milliseconds),
      this.stoppedSignal.then(() => {
        throw new Error("remote read-down session is closed");
      })
    ]);
  }

  private assertOpen(): void {
    if (this.stopped) throw new Error("remote read-down session is closed");
  }

  private assertRecoveryCurrent(generation: number): void {
    this.assertOpen();
    if (generation !== this.lifecycleGeneration) {
      throw new AuthorityTransportDisconnectedError("remote read-down recovery generation changed");
    }
  }

  private assertCurrent(active: ActiveSnapshot): void {
    this.assertOpen();
    if (this.active !== active) throw new AuthorityTransportDisconnectedError("remote read-down snapshot generation changed");
  }
}

function highestKnownRevision(active: ActiveSnapshot): number {
  return active.highestRevision;
}

function resyncError(active: ActiveSnapshot, message: string): RemoteReplicaResyncRequiredError {
  return new RemoteReplicaResyncRequiredError(message, active.reservation.cut, active.cutChange);
}

function readDownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultSchedule(milliseconds: number, callback: () => void): { readonly dispose: () => void } {
  const timer = setTimeout(callback, milliseconds);
  timer.unref?.();
  return { dispose: () => clearTimeout(timer) };
}
