import type { ReplicaChangeRecord } from "@harness-anything/application";
import { manifestDigest } from "../authority/replication-content-store.ts";
import type {
  AuthoritySnapshotManifest,
  AuthoritySnapshotManifestEntry,
  AuthoritySnapshotReservation
} from "../authority/protocol.ts";
import {
  AuthorityReadDownRequestError,
  AuthorityTransportDisconnectedError,
  type PersistentSshAuthorityClient
} from "../transport/persistent-ssh-authority-client.ts";
import { BrokerCasStore } from "./cas-store.ts";
import { isMissing } from "./errno.ts";
import type { CanonicalSnapshot } from "./types.ts";

export interface RemoteReadDownBackoff {
  readonly initialMs: number;
  readonly maximumMs: number;
  readonly multiplier: number;
}

export interface RemoteReadDownSessionOptions {
  readonly client: PersistentSshAuthorityClient;
  readonly workspaceId: string;
  readonly stateRoot: string;
  readonly backoff?: Partial<RemoteReadDownBackoff>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly schedule?: (milliseconds: number, callback: () => void) => { readonly dispose: () => void };
  readonly onDiagnostic?: (text: string) => void;
}

export class RemoteReplicaResyncRequiredError extends Error {
  readonly cutChange: ReplicaChangeRecord | null;
  readonly cutRevision: number;

  constructor(message: string, cutRevision: number, cutChange: ReplicaChangeRecord | null) {
    super(`RESYNC_REQUIRED:${message}`);
    this.name = "RemoteReplicaResyncRequiredError";
    this.cutRevision = cutRevision;
    this.cutChange = cutChange;
  }
}

interface ActiveSnapshot {
  readonly reservation: AuthoritySnapshotReservation;
  readonly cutChange: ReplicaChangeRecord | null;
  readonly baseEntries: ReadonlyMap<string, AuthoritySnapshotManifestEntry>;
  readonly changes: Map<number, ReplicaChangeRecord>;
  adopted: boolean;
  deliveredRevision: number;
}

const defaultBackoff: RemoteReadDownBackoff = {
  initialMs: 100,
  maximumMs: 5_000,
  multiplier: 2
};

export class RemoteReadDownSession {
  private readonly options: RemoteReadDownSessionOptions;
  private readonly cas: BrokerCasStore;
  private readonly backoff: RemoteReadDownBackoff;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly listeners = new Set<(change: ReplicaChangeRecord) => void>();
  private active: ActiveSnapshot | undefined;
  private recovery: Promise<ActiveSnapshot> | undefined;
  private renewalTask: { readonly dispose: () => void } | undefined;
  private stopped = false;
  private notificationPump: Promise<void> | undefined;
  private readonly removeNotificationListener: () => void;
  private readonly removeDisconnectListener: () => void;

  constructor(options: RemoteReadDownSessionOptions) {
    this.options = options;
    this.cas = new BrokerCasStore(options.stateRoot);
    this.backoff = { ...defaultBackoff, ...options.backoff };
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    assertBackoff(this.backoff);
    this.removeNotificationListener = options.client.onNotification((change) => this.receiveNotification(change));
    this.removeDisconnectListener = options.client.onDisconnect(() => this.handleDisconnect());
  }

  get workspaceId(): string {
    return this.options.workspaceId;
  }

  subscribe(listener: (change: ReplicaChangeRecord) => void): () => void {
    this.listeners.add(listener);
    void this.ready().catch((error) => this.options.onDiagnostic?.(`remote read-down start failed: ${readDownError(error).message}`));
    return () => this.listeners.delete(listener);
  }

  async latest(): Promise<ReplicaChangeRecord | undefined> {
    const active = await this.ready();
    await this.fetchAfter(active, highestKnownRevision(active));
    return [...active.changes.values()].sort(compareChanges).at(-1) ?? active.cutChange ?? undefined;
  }

  async getByOperation(opId: string): Promise<ReplicaChangeRecord | undefined> {
    const active = await this.ready();
    await this.fetchAfter(active, highestKnownRevision(active));
    return [active.cutChange, ...active.changes.values()]
      .filter((change): change is ReplicaChangeRecord => change !== null)
      .find((change) => change.operations.some((operation) => operation.opId === opId));
  }

  async changesAfter(revision: number): Promise<ReadonlyArray<ReplicaChangeRecord>> {
    const active = await this.ready();
    const cutRevision = active.reservation.cut.revision;
    if (revision < cutRevision) {
      throw new RemoteReplicaResyncRequiredError(
        `CURSOR_PRECEDES_PINNED_CUT:${revision}:${cutRevision}`,
        cutRevision,
        active.cutChange
      );
    }
    active.adopted = true;
    active.deliveredRevision = Math.max(active.deliveredRevision, revision);
    const changes = await this.fetchAfter(active, revision);
    this.queueNotificationPump();
    return changes;
  }

  async snapshotAt(change: ReplicaChangeRecord): Promise<CanonicalSnapshot> {
    const active = await this.ready();
    if (change.workspaceId !== this.options.workspaceId) {
      throw new Error("remote snapshot change belongs to another workspace");
    }
    const entries = await this.entriesAt(active, change);
    const snapshotEntries = await Promise.all([...entries.values()].sort(compareManifestPaths).map(async (entry) => ({
      path: entry.path,
      content: await this.readBlob(active, entry.blobDigest),
      logicalMode: Number.parseInt(entry.mode, 8)
    })));
    return {
      workspaceId: change.workspaceId,
      revision: change.revision,
      commitSha: change.commitSha,
      entries: snapshotEntries
    };
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.renewalTask?.dispose();
    this.removeNotificationListener();
    this.removeDisconnectListener();
    await this.options.client.close();
  }

  private async ready(): Promise<ActiveSnapshot> {
    if (this.stopped) throw new Error("remote read-down session is closed");
    if (this.active) return this.active;
    if (!this.recovery) {
      this.recovery = this.recover().finally(() => {
        this.recovery = undefined;
      });
    }
    return this.recovery;
  }

  private async recover(): Promise<ActiveSnapshot> {
    let delay = this.backoff.initialMs;
    for (;;) {
      try {
        await this.options.client.connect();
        const active = await this.openSnapshot();
        this.active = active;
        this.scheduleRenewal(active);
        this.queueNotificationPump();
        return active;
      } catch (error) {
        if (this.stopped) throw readDownError(error);
        if (isIntegrityError(error)) throw readDownError(error);
        this.options.onDiagnostic?.(`remote read-down reconnect failed; retrying in ${delay}ms: ${readDownError(error).message}`);
        await this.sleep(delay);
        delay = Math.min(this.backoff.maximumMs, Math.max(delay + 1, Math.ceil(delay * this.backoff.multiplier)));
        await this.options.client.reconnect().catch(() => undefined);
      }
    }
  }

  private async openSnapshot(): Promise<ActiveSnapshot> {
    const reservation = await this.options.client.beginSnapshotAndSubscribe();
    const manifest = await this.options.client.getSnapshotManifest(
      reservation.stream.streamToken,
      reservation.cut.manifestDigest
    );
    assertManifest(reservation, manifest, this.options.workspaceId);
    const cutChange = await this.options.client.getCutChange(reservation.stream.streamToken);
    assertCutChange(reservation, cutChange);
    const baseEntries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    if (baseEntries.size !== manifest.entries.length) throw new Error("authority snapshot manifest contains duplicate paths");
    await mapInBatches(
      manifest.entries,
      8,
      (entry) => this.readBlobFromReservation(reservation, entry.blobDigest)
    );
    return {
      reservation,
      cutChange,
      baseEntries,
      changes: new Map(),
      adopted: reservation.cut.revision === 0,
      deliveredRevision: reservation.cut.revision
    };
  }

  private async fetchAfter(active: ActiveSnapshot, revision: number): Promise<ReadonlyArray<ReplicaChangeRecord>> {
    try {
      this.assertCurrent(active);
      const result = await this.options.client.changesAfter(active.reservation.stream.streamToken, revision);
      validateChanges(result.changes, revision, this.options.workspaceId);
      for (const change of result.changes) active.changes.set(change.revision, change);
      return result.changes;
    } catch (error) {
      if (isResyncError(error)) {
        this.active = undefined;
        const next = await this.ready();
        throw new RemoteReplicaResyncRequiredError(
          error.message,
          next.reservation.cut.revision,
          next.cutChange
        );
      }
      if (error instanceof AuthorityTransportDisconnectedError) {
        this.active = undefined;
        const next = await this.ready();
        if (revision < next.reservation.cut.revision) {
          throw new RemoteReplicaResyncRequiredError(
            `CURSOR_PRECEDES_RECONNECTED_CUT:${revision}:${next.reservation.cut.revision}`,
            next.reservation.cut.revision,
            next.cutChange
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
      throw new RemoteReplicaResyncRequiredError(
        `SNAPSHOT_PRECEDES_PINNED_CUT:${change.revision}:${cut.revision}`,
        cut.revision,
        active.cutChange
      );
    }
    if (change.revision > cut.revision) await this.fetchAfter(active, cut.revision);
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
    try {
      return await this.cas.get(digest);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const bytes = await this.options.client.getBlob(reservation.stream.streamToken, digest);
    const actual = await this.cas.put(bytes);
    if (actual !== digest) throw new Error(`BLOB_DIGEST_MISMATCH:${digest}:${actual}`);
    return Buffer.from(bytes);
  }

  private receiveNotification(change: ReplicaChangeRecord): void {
    const active = this.active;
    if (!active || change.workspaceId !== this.options.workspaceId) return;
    if (change.revision <= active.reservation.cut.revision) return;
    active.changes.set(change.revision, change);
    this.queueNotificationPump();
  }

  private queueNotificationPump(): void {
    void this.pumpNotifications().catch((error) => {
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
    if (!active?.adopted || this.listeners.size === 0) return;
    for (;;) {
      const expected = active.deliveredRevision + 1;
      let change = active.changes.get(expected);
      if (!change) {
        const fetched = await this.fetchAfter(active, active.deliveredRevision);
        change = fetched[0];
      }
      if (!change || change.revision !== expected) return;
      active.deliveredRevision = change.revision;
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch (error) {
          this.options.onDiagnostic?.(`remote read-down notification listener failed: ${readDownError(error).message}`);
        }
      }
    }
  }

  private handleDisconnect(): void {
    if (this.stopped) return;
    this.active = undefined;
    this.renewalTask?.dispose();
    void this.ready().catch((error) => this.options.onDiagnostic?.(`remote read-down recovery stopped: ${readDownError(error).message}`));
  }

  private scheduleRenewal(active: ActiveSnapshot): void {
    this.renewalTask?.dispose();
    const expiresAt = Date.parse(active.reservation.lease.expiresAt);
    const renewableUntil = Date.parse(active.reservation.lease.renewableUntil);
    const remaining = expiresAt - this.now();
    const delay = Math.max(0, Math.min(remaining / 2, renewableUntil - this.now()));
    const schedule = this.options.schedule ?? defaultSchedule;
    this.renewalTask = schedule(delay, () => void this.renew(active));
  }

  private async renew(active: ActiveSnapshot): Promise<void> {
    if (this.active !== active || this.stopped) return;
    try {
      if (this.now() >= Date.parse(active.reservation.lease.renewableUntil)) {
        throw new RemoteReplicaResyncRequiredError(
          "LEASE_RENEWAL_LIMIT_REACHED",
          active.reservation.cut.revision,
          active.cutChange
        );
      }
      const lease = await this.options.client.renewLease(active.reservation.stream.streamToken);
      const renewed: ActiveSnapshot = {
        ...active,
        reservation: { ...active.reservation, lease }
      };
      this.active = renewed;
      this.scheduleRenewal(renewed);
    } catch (error) {
      this.options.onDiagnostic?.(`remote read-down lease requires resnapshot: ${readDownError(error).message}`);
      this.active = undefined;
      await this.options.client.reconnect().catch(() => undefined);
      void this.ready().catch((recoveryError) => {
        this.options.onDiagnostic?.(`remote read-down lease recovery failed: ${readDownError(recoveryError).message}`);
      });
    }
  }

  private assertCurrent(active: ActiveSnapshot): void {
    if (this.active !== active) throw new AuthorityTransportDisconnectedError("remote read-down snapshot generation changed");
  }
}

function assertManifest(
  reservation: AuthoritySnapshotReservation,
  manifest: AuthoritySnapshotManifest,
  workspaceId: string
): void {
  if (manifest.cut.workspaceId !== workspaceId
    || !sameSnapshotCut(manifest.cut, reservation.cut)) {
    throw new Error("authority snapshot manifest cut mismatch");
  }
  const actual = manifestDigest(manifest.cut, manifest.entries);
  if (actual !== reservation.cut.manifestDigest) {
    throw new Error(`MANIFEST_DIGEST_MISMATCH:${reservation.cut.manifestDigest}:${actual}`);
  }
}

function sameSnapshotCut(
  left: AuthoritySnapshotReservation["cut"],
  right: AuthoritySnapshotReservation["cut"]
): boolean {
  return left.workspaceId === right.workspaceId
    && left.epoch === right.epoch
    && left.revision === right.revision
    && left.commitSha === right.commitSha
    && left.manifestDigest === right.manifestDigest
    && left.provenanceDigest === right.provenanceDigest;
}

function assertCutChange(
  reservation: AuthoritySnapshotReservation,
  change: ReplicaChangeRecord | null
): void {
  if (reservation.cut.revision === 0) {
    if (change !== null) throw new Error("authority empty cut unexpectedly has a change");
    return;
  }
  if (!change
    || change.workspaceId !== reservation.cut.workspaceId
    || change.revision !== reservation.cut.revision
    || change.commitSha !== reservation.cut.commitSha
    || change.manifest.digest !== reservation.cut.manifestDigest) {
    throw new Error("authority cut change does not match snapshot reservation");
  }
}

async function mapInBatches<Value>(
  values: ReadonlyArray<Value>,
  batchSize: number,
  operation: (value: Value) => Promise<unknown>
): Promise<void> {
  for (let offset = 0; offset < values.length; offset += batchSize) {
    await Promise.all(values.slice(offset, offset + batchSize).map(operation));
  }
}

function validateChanges(
  changes: ReadonlyArray<ReplicaChangeRecord>,
  sinceRevision: number,
  workspaceId: string
): void {
  let expected = sinceRevision + 1;
  for (const change of changes) {
    if (change.workspaceId !== workspaceId || change.revision !== expected) {
      throw new Error(`remote replica change gap at revision ${change.revision}; expected ${expected}`);
    }
    expected += 1;
  }
}

function applyChange(
  entries: Map<string, AuthoritySnapshotManifestEntry>,
  change: ReplicaChangeRecord
): void {
  for (const item of change.paths) {
    if (item.tombstone) {
      entries.delete(item.path);
    } else {
      if (!item.blobDigest || !item.mode) throw new Error(`remote change lacks blob metadata for ${item.path}`);
      entries.set(item.path, {
        path: item.path,
        blobDigest: item.blobDigest,
        mode: item.mode,
        tombstone: false
      });
    }
  }
}

function assertChangeManifest(
  epoch: string,
  change: ReplicaChangeRecord,
  entries: ReadonlyMap<string, AuthoritySnapshotManifestEntry>
): void {
  const actual = manifestDigest({
    workspaceId: change.workspaceId,
    epoch,
    revision: change.revision,
    commitSha: change.commitSha
  }, [...entries.values()]);
  if (actual !== change.manifest.digest || entries.size !== change.manifest.entryCount) {
    throw new Error(`MANIFEST_DIGEST_MISMATCH:${change.manifest.digest}:${actual}`);
  }
}

function highestKnownRevision(active: ActiveSnapshot): number {
  return Math.max(active.reservation.cut.revision, ...active.changes.keys());
}

function compareChanges(left: ReplicaChangeRecord, right: ReplicaChangeRecord): number {
  return left.revision - right.revision;
}

function compareManifestPaths(
  left: AuthoritySnapshotManifestEntry,
  right: AuthoritySnapshotManifestEntry
): number {
  return left.path.localeCompare(right.path, "en");
}

function assertBackoff(backoff: RemoteReadDownBackoff): void {
  if (!Number.isFinite(backoff.initialMs)
    || !Number.isFinite(backoff.maximumMs)
    || !Number.isFinite(backoff.multiplier)
    || backoff.initialMs < 0
    || backoff.maximumMs < backoff.initialMs
    || backoff.multiplier < 1) {
    throw new Error("remote read-down backoff must be finite, non-negative, and bounded");
  }
}

function isResyncError(error: unknown): error is AuthorityReadDownRequestError {
  return error instanceof AuthorityReadDownRequestError
    && (error.code === "RESYNC_REQUIRED" || error.code === "SNAPSHOT_EXPIRED");
}

function isIntegrityError(error: unknown): boolean {
  const message = readDownError(error).message;
  return /(?:BLOB|MANIFEST)_DIGEST_MISMATCH|manifest (?:cut mismatch|contains duplicate)|cut change does not match|blob response (?:metadata mismatch|is not canonical)/iu.test(message);
}

function readDownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultSchedule(milliseconds: number, callback: () => void): { readonly dispose: () => void } {
  const timer = setTimeout(callback, milliseconds);
  timer.unref?.();
  return { dispose: () => clearTimeout(timer) };
}
