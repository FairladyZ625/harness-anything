import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
import {
  localLedgerBackupFileSystem,
  localRuntimeStateFileSystem,
} from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { validatePromotableReplica } from "@harness-anything/kernel/internal/domain/replica-promotion.ts";
import {
  computeSwitchoverTargetEpoch,
  evaluateRpoZeroCatchupBarrier,
  evaluateSwitchoverRollbackEligibility,
  verifySwitchoverFenceEpoch,
  type SwitchoverFrozenCut,
  type SwitchoverReplicaCut,
} from "@harness-anything/kernel/internal/domain/center-switchover.ts";
import { readGenerationThreeActivationAtPath } from "./store/generation-three-selection.ts";
import { advancePersistentWriterEpochFloor, openPersistentWriterEpoch } from "./writer-epoch.ts";
import {
  clearCenterMigrating,
  clearCenterSwitchoverFence,
  isSwitchoverAttemptInvalidated,
  readCenterRelocated,
  readCenterSwitchoverFence,
  recordInvalidatedSwitchoverAttempt,
  writeCenterSwitchoverFence,
  type CenterSwitchoverCededProofV1,
  type CenterSwitchoverFenceV1,
} from "./center-relocation-state.ts";
import { sha256File } from "./store/ledger-backup.ts";
import { openSqliteEventStore, sqliteLedgerPath } from "./store/sqlite-event-store.ts";
import { DEFAULT_REPLICA_LOG_WINDOW_COMMITS } from "./store/replica-store.ts";
import { removeFileDurably, syncDirectory, syncFile, writeFileDurably } from "./durable-file.ts";
import type { ReplicationPosition } from "./store/replication-log.ts";
import { openReplicationSlots, type ReplicationAcknowledgement } from "./fleet-replication-slot.ts";
import { EdgeReplicaIntegrityError } from "./center-relocation.ts";

export class CenterSwitchoverStorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CenterSwitchoverStorageError";
    this.code = code;
  }
}

export interface CenterReplicationLogRow {
  readonly sequence: number;
  readonly revision: number;
  readonly outcomeOpId: string | null;
  readonly writerJson: string | null;
}

export interface CenterFrozenCutSnapshot {
  readonly cut: SwitchoverFrozenCut;
  readonly writerEpoch: number;
  readonly replicationLogWindow: readonly CenterReplicationLogRow[];
}

export interface SwitchoverReplicationSlotSnapshot {
  readonly repoId: string;
  readonly nodeId: string;
  readonly history: string;
  readonly ack: ReplicationAcknowledgement | null;
}

export interface CedeCenterForSwitchoverInput {
  readonly userRoot: string;
  readonly stateRoot?: string;
  readonly repoId: string;
  readonly switchoverId: string;
  readonly oldEpoch: number;
  readonly cededEpoch?: number;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly frozenCut: SwitchoverFrozenCut;
  readonly newExternalUrl: string;
  readonly newLoginUrl: string;
  readonly spkiSha256: string;
  readonly cededProof?: CenterSwitchoverCededProofV1;
  readonly targetCaPath?: string;
  readonly targetServername?: string;
  readonly targetRoot?: string;
  readonly targetUserRoot?: string;
  readonly targetStateRoot?: string;
  readonly now?: () => string;
}

export interface PromoteReplicaForSwitchoverInput {
  readonly rootInput: HarnessLayoutInput;
  readonly userRoot: string;
  readonly stateRoot: string;
  readonly repoId: string;
  readonly switchoverId: string;
  readonly replicaDatabasePath: string;
  readonly replicaGeneration: number;
  readonly replicaPosition: ReplicationPosition;
  readonly expectedOldEpoch: number;
  readonly newEpoch: number;
  readonly expectedFrozenCut: SwitchoverFrozenCut;
  readonly holderId?: string;
  readonly sourceReplicationLogWindow?: readonly CenterReplicationLogRow[];
  readonly retentionWindowCommits?: number;
  readonly replicationSlotsSourcePath?: string;
  readonly replicationSlots?: readonly SwitchoverReplicationSlotSnapshot[];
  readonly now?: () => string;
}

export interface PromoteReplicaForSwitchoverResult {
  readonly schema: "center-switchover-activated/v1";
  readonly switchoverId: string;
  readonly repoId: string;
  readonly oldEpoch: number;
  readonly newEpoch: number;
  readonly finalRevision: number;
  readonly tipHash: string;
  readonly replicationHistory: string;
  readonly replicationSequence: number;
  readonly retainedLogMinSequence: number;
  readonly retainedLogRowCount: number;
  readonly displacedGenerationPath: string | null;
  readonly auditPath: string;
  readonly promotedAt: string;
}

export interface RollbackCenterSwitchoverInput {
  readonly rootInput: HarnessLayoutInput;
  readonly userRoot: string;
  readonly stateRoot: string;
  readonly repoId: string;
  readonly switchoverId: string;
  readonly targetNeverActivated: boolean;
  readonly targetInvalidated: boolean;
  readonly reason: string;
  readonly holderId?: string;
  readonly now?: () => string;
}

export interface RollbackCenterSwitchoverResult {
  readonly schema: "center-switchover-rolled-back/v1";
  readonly switchoverId: string;
  readonly repoId: string;
  readonly oldEpoch: number;
  readonly cededEpoch: number;
  readonly rollbackEpoch: number;
  readonly reason: string;
  readonly auditPath: string;
  readonly rolledBackAt: string;
}

export function switchoverActivationAuditPath(stateRoot: string, repoId: string): string {
  return path.join(path.resolve(stateRoot), "governance", "center-switchover-activated", `${repoId}.json`);
}

export function switchoverRollbackAuditPath(stateRoot: string, repoId: string, switchoverId: string): string {
  return path.join(
    path.resolve(stateRoot),
    "governance",
    "center-switchover-rollback",
    `${repoId}.${switchoverId}.json`,
  );
}

/** Read a frozen center's canonical cut and bounded replication_log window without mutating the ledger. */
export function readCenterFrozenCut(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId: string;
  readonly maxLogWindowCommits?: number;
}): CenterFrozenCutSnapshot {
  const windowSize = input.maxLogWindowCommits ?? DEFAULT_REPLICA_LOG_WINDOW_COMMITS,
    ledger = openSqliteEventStore({ rootInput: input.rootInput, repoId: input.repoId, readOnly: true });
  try {
    const position = ledger.replicationPosition(),
      finalRevision = ledger.revision(),
      tipHash = canonicalLedgerCut(input.repoId, ledger.eventIdentityAtRevision(finalRevision)).headDigest,
      writerEpoch = ledger.writerFence()?.epoch ?? 0;
    const rawDb = new DatabaseSync(ledger.databasePath, { readOnly: true });
    let replicationLogWindow: CenterReplicationLogRow[];
    try {
      const minSeq = Math.max(0, position.sequence - windowSize);
      replicationLogWindow = (
        rawDb
          .prepare(
            "SELECT sequence, revision, outcome_op_id, writer_json FROM replication_log WHERE sequence >= ? ORDER BY sequence",
          )
          .all(minSeq) as unknown as readonly {
          readonly sequence: unknown;
          readonly revision: unknown;
          readonly outcome_op_id: unknown;
          readonly writer_json: unknown;
        }[]
      ).map((row) => ({
        sequence: Number(row.sequence),
        revision: Number(row.revision),
        outcomeOpId: row.outcome_op_id === null ? null : String(row.outcome_op_id),
        writerJson: row.writer_json === null ? null : String(row.writer_json),
      }));
    } finally {
      rawDb.close();
    }
    return {
      cut: {
        repoId: input.repoId,
        finalRevision,
        tipHash,
        history: position.history,
        sequence: position.sequence,
      },
      writerEpoch,
      replicationLogWindow,
    };
  } finally {
    ledger.close();
  }
}

/**
 * Phase 1 of two-phase Switchover (dec_AAEC26DBB6F23BDF80876ABB2C CH3):
 * durably advance local writer-epoch floor to cededEpoch and fsync the reversible fence BEFORE
 * instructing the target node to activate oldEpoch + 1.
 */
export function cedeCenterForSwitchover(input: CedeCenterForSwitchoverInput): CenterSwitchoverFenceV1 {
  if (readCenterRelocated(input.userRoot, input.repoId) !== null)
    throw new CenterSwitchoverStorageError(
      "center_permanently_retired",
      `Repository ${input.repoId} has an irreversible center-relocated tombstone and cannot participate in switchover.`,
    );
  const cededEpoch = input.cededEpoch ?? computeSwitchoverTargetEpoch(input.oldEpoch);
  verifySwitchoverFenceEpoch(input.oldEpoch, cededEpoch);
  const now = input.now ?? (() => new Date().toISOString()),
    stateRoot = path.resolve(input.stateRoot ?? path.join(path.resolve(input.userRoot), "fleet"));
  advancePersistentWriterEpochFloor({
    stateRoot,
    repoId: input.repoId,
    minimumEpoch: cededEpoch,
    now,
  });
  const fence: CenterSwitchoverFenceV1 = {
    schema: "center-switchover-fence/v1",
    switchoverId: input.switchoverId,
    repoId: input.repoId,
    state: "fenced_ceded",
    oldEpoch: input.oldEpoch,
    cededEpoch,
    newEpoch: cededEpoch,
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    finalRevision: input.frozenCut.finalRevision,
    tipHash: input.frozenCut.tipHash,
    newExternalUrl: input.newExternalUrl,
    newLoginUrl: input.newLoginUrl,
    spkiSha256: input.spkiSha256,
    ...(input.cededProof ? { cededProof: input.cededProof } : {}),
    ...(input.targetCaPath ? { targetCaPath: path.resolve(input.targetCaPath) } : {}),
    ...(input.targetServername ? { targetServername: input.targetServername } : {}),
    ...(input.targetRoot ? { targetRoot: path.resolve(input.targetRoot) } : {}),
    ...(input.targetUserRoot ? { targetUserRoot: path.resolve(input.targetUserRoot) } : {}),
    ...(input.targetStateRoot ? { targetStateRoot: path.resolve(input.targetStateRoot) } : {}),
    fencedAt: input.cededProof?.fencedAt ?? now(),
  };
  writeCenterSwitchoverFence(input.userRoot, fence);
  return fence;
}

/**
 * Phase 2 of planned Switchover (dec_AAEC26DBB6F23BDF80876ABB2C CH2/CH3):
 * verify RPO=0 catch-up against frozenCut, preserve replication_state.history and bounded replication_log window,
 * advance writerEpoch to oldEpoch + 1, and publish the promoted generation atomically.
 */
export async function promoteReplicaForSwitchover(
  input: PromoteReplicaForSwitchoverInput,
): Promise<PromoteReplicaForSwitchoverResult> {
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(input.repoId))
    throw new CenterSwitchoverStorageError("invalid_field", "repoId is invalid for switchover promotion");
  if (isSwitchoverAttemptInvalidated(input.stateRoot, input.repoId, input.switchoverId))
    throw new CenterSwitchoverStorageError(
      "switchover_attempt_invalidated",
      `Switchover attempt ${input.switchoverId} for ${input.repoId} was invalidated by an audited rollback and cannot activate.`,
    );
  if (readCenterRelocated(input.userRoot, input.repoId) !== null)
    throw new CenterSwitchoverStorageError(
      "center_permanently_retired",
      `Target host has an irreversible center-relocated tombstone for ${input.repoId}.`,
    );
  const expectedNewEpoch = computeSwitchoverTargetEpoch(input.expectedOldEpoch);
  if (input.newEpoch !== expectedNewEpoch)
    throw new CenterSwitchoverStorageError(
      "writer_epoch_invalid",
      `Planned switchover newEpoch (${String(input.newEpoch)}) must equal expectedOldEpoch + 1 (${String(expectedNewEpoch)}).`,
    );
  const existingFence = readCenterSwitchoverFence(input.userRoot, input.repoId);
  if (existingFence !== null && input.newEpoch <= existingFence.cededEpoch)
    throw new CenterSwitchoverStorageError(
      "writer_epoch_not_advanced",
      `Target host holds a switchover fence at epoch ${String(existingFence.cededEpoch)}; promotion requires epoch > ${String(existingFence.cededEpoch)}.`,
    );

  const now = input.now ?? (() => new Date().toISOString()),
    holderId = input.holderId ?? `switchover-center-${process.pid}`,
    replicaDatabasePath = path.resolve(input.replicaDatabasePath),
    targetDatabasePath = sqliteLedgerPath(input.rootInput, 3),
    targetGenerationDir = path.dirname(targetDatabasePath),
    source = openSqliteEventStore({
      repoId: input.repoId,
      databasePath: replicaDatabasePath,
      generation: input.replicaGeneration,
      readOnly: true,
    });
  let authority: ReturnType<typeof openPersistentWriterEpoch> | undefined;
  let stagingDirectory: string | undefined,
    published = false,
    displacedGenerationPath: string | null = null;
  try {
    if (input.replicaGeneration !== 3)
      throw new CenterSwitchoverStorageError(
        "generation_mismatch",
        `Replica generation ${String(input.replicaGeneration)} is unsupported; generation 3 is required.`,
      );
    const observed = verifyReplicaIntegrityAndBarrier(
        source,
        input.repoId,
        input.replicaPosition,
        input.expectedFrozenCut,
      ),
      activation = readGenerationThreeActivationAtPath(replicaDatabasePath, input.repoId);
    if (activation === null)
      throw new CenterSwitchoverStorageError(
        "edge_replica_integrity_failed",
        "Replica has no valid generation 3 activation certificate.",
      );

    const targetStoreDir = path.dirname(targetGenerationDir),
      cacheRoot = resolveHarnessLayout(input.rootInput).cacheRoot;
    localLedgerBackupFileSystem.mkdir(targetStoreDir, { recursive: true });
    stagingDirectory = path.join(targetStoreDir, `.switchover-promote-${randomUUID()}`);
    localLedgerBackupFileSystem.mkdir(stagingDirectory, { recursive: true });
    const stagedDatabasePath = path.join(stagingDirectory, "ledger.sqlite"),
      sourceDatabase = new DatabaseSync(replicaDatabasePath, { readOnly: true });
    try {
      sourceDatabase.exec(`VACUUM INTO ${sqlString(stagedDatabasePath)}`);
    } finally {
      sourceDatabase.close();
    }
    const sourceObjects = path.join(path.dirname(replicaDatabasePath), "objects"),
      stagedObjects = path.join(stagingDirectory, "objects");
    if (localLedgerBackupFileSystem.exists(sourceObjects))
      localLedgerBackupFileSystem.copy(sourceObjects, stagedObjects, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    localLedgerBackupFileSystem.copy(`${replicaDatabasePath}.activation.json`, `${stagedDatabasePath}.activation.json`);
    syncTree(stagingDirectory);

    const ledger = openSqliteEventStore({
      repoId: input.repoId,
      databasePath: stagedDatabasePath,
      generation: 3,
    });
    let finalPosition: ReplicationPosition;
    try {
      const staged = verifyReplicaIntegrityAndBarrier(
        ledger,
        input.repoId,
        input.replicaPosition,
        input.expectedFrozenCut,
      );
      if (staged.tipHash !== observed.tipHash || staged.revision !== observed.revision)
        throw new CenterSwitchoverStorageError(
          "edge_replica_integrity_failed",
          "Staged replica differs from verified source cut.",
        );
      if (input.sourceReplicationLogWindow && input.sourceReplicationLogWindow.length > 0) {
        ledger.mergeReplicationLogRows(
          input.sourceReplicationLogWindow,
          input.retentionWindowCommits ?? DEFAULT_REPLICA_LOG_WINDOW_COMMITS,
        );
      }
      // Bump epoch floor to newEpoch - 1 before clearing any superseded older fence so crash recovery stays monotonic.
      if (input.newEpoch - 1 >= 1) {
        advancePersistentWriterEpochFloor({
          stateRoot: input.stateRoot,
          repoId: input.repoId,
          minimumEpoch: input.newEpoch - 1,
          now,
        });
      }
      if (existingFence !== null) clearCenterSwitchoverFence(input.userRoot, input.repoId);
      authority = openPersistentWriterEpoch({
        stateRoot: input.stateRoot,
        holderId,
        now,
        initialEpochFloor: input.expectedOldEpoch,
      });
      const lease = authority.acquire(input.repoId, input.expectedOldEpoch);
      if (lease.epoch !== input.newEpoch)
        throw new CenterSwitchoverStorageError(
          "writer_epoch_not_advanced",
          `Expected switchover writer epoch ${String(input.newEpoch)}, acquired ${String(lease.epoch)}.`,
        );
      // Planned Switchover: claim new epoch WITHOUT rotating replication_state.history!
      ledger.claimWriter({ repoId: input.repoId, holder: holderId, epoch: lease.epoch });
      finalPosition = ledger.replicationPosition();
    } finally {
      ledger.close();
    }

    for (const suffix of ["", "-wal", "-shm"]) {
      const cachedProjection = path.join(cacheRoot, `task.sqlite${suffix}`);
      if (localLedgerBackupFileSystem.exists(cachedProjection)) removeFileDurably(cachedProjection);
    }

    try {
      if (localLedgerBackupFileSystem.exists(targetGenerationDir)) {
        const retiredRoot = path.join(path.dirname(targetStoreDir), "retired", "center-switchover");
        localLedgerBackupFileSystem.mkdir(retiredRoot, { recursive: true });
        displacedGenerationPath = path.join(retiredRoot, `generation-3-${randomUUID()}`);
        localRuntimeStateFileSystem.rename(targetGenerationDir, displacedGenerationPath);
        syncDirectory(targetStoreDir);
        syncDirectory(retiredRoot);
      }
      localRuntimeStateFileSystem.rename(stagingDirectory, targetGenerationDir);
      published = true;
      syncDirectory(targetStoreDir);
    } catch (publishError) {
      try {
        if (published && localLedgerBackupFileSystem.exists(targetGenerationDir)) {
          localRuntimeStateFileSystem.rename(targetGenerationDir, stagingDirectory);
          published = false;
        }
        if (
          displacedGenerationPath !== null &&
          localLedgerBackupFileSystem.exists(displacedGenerationPath) &&
          !localLedgerBackupFileSystem.exists(targetGenerationDir)
        ) {
          localRuntimeStateFileSystem.rename(displacedGenerationPath, targetGenerationDir);
          syncDirectory(targetStoreDir);
          displacedGenerationPath = null;
        }
      } catch (restoreError) {
        throw new AggregateError(
          [publishError, restoreError],
          "switchover generation publish failed and prior ledger could not be restored",
        );
      }
      throw publishError;
    }

    if (input.replicationSlotsSourcePath && localLedgerBackupFileSystem.exists(input.replicationSlotsSourcePath)) {
      const slotsDestination = path.join(path.resolve(input.stateRoot), "replication-slots.sqlite");
      if (path.resolve(input.replicationSlotsSourcePath) !== slotsDestination) {
        localLedgerBackupFileSystem.mkdir(path.dirname(slotsDestination), { recursive: true });
        localLedgerBackupFileSystem.copy(input.replicationSlotsSourcePath, slotsDestination, { force: true });
        syncFile(slotsDestination);
      }
    } else if (input.replicationSlots && input.replicationSlots.length > 0) {
      const slotsDestination = path.join(path.resolve(input.stateRoot), "replication-slots.sqlite");
      const {
        claim: seedSlot,
        acknowledge: acknowledgeSlot,
        close: closeSlots,
      } = openReplicationSlots(slotsDestination);
      try {
        for (const row of input.replicationSlots) {
          if (row.repoId !== input.repoId) continue;
          const lease = seedSlot({ repoId: row.repoId, nodeId: row.nodeId }, row.history);
          if (row.ack !== null) {
            acknowledgeSlot(lease, row.ack, row.ack.durable);
          }
        }
      } finally {
        closeSlots();
      }
      syncFile(slotsDestination);
    }

    const promotedLedger = openSqliteEventStore({ rootInput: input.rootInput, repoId: input.repoId, readOnly: true });
    let retainedLogMinSequence: number, retainedLogRowCount: number;
    try {
      const promotedPos = promotedLedger.replicationPosition();
      if (
        promotedPos.history !== input.expectedFrozenCut.history ||
        promotedPos.revision !== input.expectedFrozenCut.finalRevision ||
        promotedPos.sequence !== finalPosition.sequence ||
        promotedLedger.writerFence()?.epoch !== input.newEpoch
      )
        throw new CenterSwitchoverStorageError(
          "edge_replica_integrity_failed",
          "Promoted switchover ledger differs from verified history/epoch cut.",
        );
      const statsDb = new DatabaseSync(promotedLedger.databasePath, { readOnly: true });
      try {
        const stats = statsDb
          .prepare("SELECT MIN(sequence) AS min_seq, COUNT(*) AS row_count FROM replication_log")
          .get() as { readonly min_seq: unknown; readonly row_count: unknown };
        retainedLogMinSequence = Number(stats.min_seq ?? promotedPos.sequence);
        retainedLogRowCount = Number(stats.row_count ?? 0);
      } finally {
        statsDb.close();
      }
    } finally {
      promotedLedger.close();
    }

    const promotedAt = now(),
      auditPath = switchoverActivationAuditPath(input.stateRoot, input.repoId),
      result: PromoteReplicaForSwitchoverResult = {
        schema: "center-switchover-activated/v1",
        switchoverId: input.switchoverId,
        repoId: input.repoId,
        oldEpoch: input.expectedOldEpoch,
        newEpoch: input.newEpoch,
        finalRevision: input.expectedFrozenCut.finalRevision,
        tipHash: input.expectedFrozenCut.tipHash,
        replicationHistory: finalPosition.history,
        replicationSequence: finalPosition.sequence,
        retainedLogMinSequence,
        retainedLogRowCount,
        displacedGenerationPath,
        auditPath,
        promotedAt,
      };
    writeFileDurably(
      auditPath,
      `${JSON.stringify({ ...result, event: "center_switchover_activated" }, null, 2)}\n`,
      0o600,
    );
    return result;
  } finally {
    authority?.close();
    source.close();
    if (stagingDirectory && !published && localLedgerBackupFileSystem.exists(stagingDirectory))
      localLedgerBackupFileSystem.remove(stagingDirectory);
  }
}

/** Strictly read-only writer-epoch high watermark probe (zero directory creation, zero WAL/SHM creation when clean, F10). */
export function readExistingWriterEpochHighWatermark(stateRoot: string, repoId: string): number | null {
  const epochDbPath = path.join(path.resolve(stateRoot), "writer-epochs", `${repoId}.sqlite`);
  if (!localRuntimeStateFileSystem.exists(epochDbPath)) return null;
  const hasLiveWal = localRuntimeStateFileSystem.exists(`${epochDbPath}-wal`);
  const target = hasLiveWal ? epochDbPath : `${pathToFileURL(epochDbPath).href}?immutable=1`;
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    const currentRow = db.prepare("SELECT epoch FROM writer_epochs WHERE repo_id = ?").get(repoId) as
      | { readonly epoch?: unknown }
      | undefined;
    const historyRow = db
      .prepare("SELECT MAX(epoch) AS floor FROM writer_epoch_history WHERE repo_id = ?")
      .get(repoId) as { readonly floor?: unknown } | undefined;
    return Math.max(Number(currentRow?.epoch ?? 0), Number(historyRow?.floor ?? 0));
  } finally {
    db.close();
  }
}

/**
 * Target-side invalidation check before source-side oldEpoch + 2 rollback:
 * proves target is an existing initialized authority that never activated cededEpoch and durably invalidates
 * switchoverId so delayed Phase 2 activation is rejected. Never creates an epoch DB or invalidation ledger
 * inside an empty/uninitialized directory (F3).
 */
export function invalidateTargetSwitchoverAttempt(input: {
  readonly targetStateRoot: string;
  readonly targetRootInput?: HarnessLayoutInput;
  readonly targetReplicaDatabasePath?: string;
  readonly expectedTargetNodeId?: string;
  readonly repoId: string;
  readonly switchoverId: string;
  readonly cededEpoch: number;
  readonly now?: () => string;
}): {
  readonly targetNeverActivated: boolean;
  readonly targetInvalidated: boolean;
  readonly observedTargetEpoch: number;
} {
  const resolvedTargetStateRoot = path.resolve(input.targetStateRoot);
  if (!localRuntimeStateFileSystem.exists(resolvedTargetStateRoot)) {
    return { targetNeverActivated: false, targetInvalidated: false, observedTargetEpoch: 0 };
  }
  const activationAuditFile = switchoverActivationAuditPath(resolvedTargetStateRoot, input.repoId);
  let alreadyActivatedSameSwitchover = false;
  let observedTargetEpoch = 0;
  if (localRuntimeStateFileSystem.exists(activationAuditFile)) {
    const parsed = JSON.parse(localRuntimeStateFileSystem.readText(activationAuditFile)) as {
      readonly switchoverId?: unknown;
      readonly newEpoch?: unknown;
    };
    const auditEpoch = Number(parsed.newEpoch ?? 0);
    if (Number.isSafeInteger(auditEpoch) && auditEpoch > observedTargetEpoch) observedTargetEpoch = auditEpoch;
    if (parsed.switchoverId === input.switchoverId || auditEpoch >= input.cededEpoch) {
      alreadyActivatedSameSwitchover = true;
    }
  }
  const existingEpochWatermark = readExistingWriterEpochHighWatermark(resolvedTargetStateRoot, input.repoId);
  if (existingEpochWatermark !== null) {
    observedTargetEpoch = Math.max(observedTargetEpoch, existingEpochWatermark);
  }
  let hasCanonicalLedger = false;
  if (input.targetRootInput) {
    const ledgerPath = sqliteLedgerPath(input.targetRootInput, 3);
    if (localLedgerBackupFileSystem.exists(ledgerPath)) {
      hasCanonicalLedger = true;
      const ledger = openSqliteEventStore({ rootInput: input.targetRootInput, repoId: input.repoId, readOnly: true });
      try {
        observedTargetEpoch = Math.max(observedTargetEpoch, ledger.writerFence()?.epoch ?? 0);
      } finally {
        ledger.close();
      }
    }
  }
  if (observedTargetEpoch >= input.cededEpoch || alreadyActivatedSameSwitchover) {
    return { targetNeverActivated: false, targetInvalidated: false, observedTargetEpoch };
  }
  let hasMatchingEdgeConfig = false;
  const edgeConfigPath = path.join(resolvedTargetStateRoot, "edge", input.repoId, "fleet-edge.json");
  if (localRuntimeStateFileSystem.exists(edgeConfigPath)) {
    try {
      const parsed = JSON.parse(localRuntimeStateFileSystem.readText(edgeConfigPath)) as {
        readonly schema?: unknown;
        readonly repoId?: unknown;
        readonly nodeId?: unknown;
      };
      if (parsed.schema === "fleet-edge-config/v1" && parsed.repoId === input.repoId) {
        if (input.expectedTargetNodeId !== undefined && parsed.nodeId !== input.expectedTargetNodeId) {
          return { targetNeverActivated: false, targetInvalidated: false, observedTargetEpoch };
        }
        hasMatchingEdgeConfig = true;
      }
    } catch {
      return { targetNeverActivated: false, targetInvalidated: false, observedTargetEpoch };
    }
  }
  const hasReplicaDatabase =
    typeof input.targetReplicaDatabasePath === "string" &&
    input.targetReplicaDatabasePath.length > 0 &&
    localLedgerBackupFileSystem.exists(path.resolve(input.targetReplicaDatabasePath));
  const hasExistingInvalidationLedger = localRuntimeStateFileSystem.exists(
    path.join(resolvedTargetStateRoot, "switchover-invalidated", `${input.repoId}.json`),
  );
  const hasAuthoritativeTargetEvidence =
    existingEpochWatermark !== null ||
    hasCanonicalLedger ||
    hasMatchingEdgeConfig ||
    hasReplicaDatabase ||
    hasExistingInvalidationLedger;
  if (!hasAuthoritativeTargetEvidence) {
    return { targetNeverActivated: false, targetInvalidated: false, observedTargetEpoch: 0 };
  }
  recordInvalidatedSwitchoverAttempt(
    resolvedTargetStateRoot,
    input.repoId,
    input.switchoverId,
    (input.now ?? (() => new Date().toISOString()))(),
  );
  return { targetNeverActivated: true, targetInvalidated: true, observedTargetEpoch };
}

/**
 * Audited rollback after Phase 1 crash/abort (dec_AAEC26DBB6F23BDF80876ABB2C CH3):
 * only after confirming target never activated and target attempt is invalidated, jumps old center epoch to oldEpoch + 2.
 */
export function rollbackCenterSwitchover(input: RollbackCenterSwitchoverInput): RollbackCenterSwitchoverResult {
  const fence = readCenterSwitchoverFence(input.userRoot, input.repoId);
  if (fence === null)
    throw new CenterSwitchoverStorageError(
      "switchover_fence_missing",
      `No reversible switchover fence exists for ${input.repoId}.`,
    );
  const eligibility = evaluateSwitchoverRollbackEligibility({
    requestedSwitchoverId: input.switchoverId,
    fenceSwitchoverId: fence.switchoverId,
    oldEpoch: fence.oldEpoch,
    cededEpoch: fence.cededEpoch,
    targetNeverActivated: input.targetNeverActivated,
    targetInvalidated: input.targetInvalidated,
  });
  if (!eligibility.ok) throw new CenterSwitchoverStorageError(eligibility.code, eligibility.detail);

  const now = input.now ?? (() => new Date().toISOString()),
    rolledBackAt = now(),
    holderId = input.holderId ?? `switchover-rollback-${process.pid}`,
    auditPath = switchoverRollbackAuditPath(input.stateRoot, input.repoId, input.switchoverId);

  // Advance durable floor to cededEpoch BEFORE clearing fence file so even a mid-rollback crash cannot re-acquire <= cededEpoch.
  advancePersistentWriterEpochFloor({
    stateRoot: input.stateRoot,
    repoId: input.repoId,
    minimumEpoch: fence.cededEpoch,
    now,
  });

  const result: RollbackCenterSwitchoverResult = {
    schema: "center-switchover-rolled-back/v1",
    switchoverId: fence.switchoverId,
    repoId: fence.repoId,
    oldEpoch: fence.oldEpoch,
    cededEpoch: fence.cededEpoch,
    rollbackEpoch: eligibility.rollbackEpoch,
    reason: input.reason,
    auditPath,
    rolledBackAt,
  };
  writeFileDurably(
    auditPath,
    `${JSON.stringify(
      {
        ...result,
        event: "center_switchover_rolled_back",
        targetNeverActivated: true,
        targetInvalidated: true,
      },
      null,
      2,
    )}\n`,
    0o600,
  );

  clearCenterSwitchoverFence(input.userRoot, input.repoId);
  clearCenterMigrating(input.userRoot, input.repoId);

  const authority = openPersistentWriterEpoch({
    stateRoot: input.stateRoot,
    holderId,
    now,
    initialEpochFloor: fence.cededEpoch,
  });
  try {
    const lease = authority.acquire(input.repoId, fence.cededEpoch);
    if (lease.epoch < eligibility.rollbackEpoch)
      throw new CenterSwitchoverStorageError(
        "writer_epoch_not_advanced",
        `Rollback acquired epoch ${String(lease.epoch)}, expected >= ${String(eligibility.rollbackEpoch)}.`,
      );
    const ledger = openSqliteEventStore({ rootInput: input.rootInput, repoId: input.repoId });
    try {
      ledger.claimWriter({ repoId: input.repoId, holder: holderId, epoch: lease.epoch });
    } finally {
      ledger.close();
    }
    return { ...result, rollbackEpoch: lease.epoch };
  } finally {
    authority.close();
  }
}

function verifyReplicaIntegrityAndBarrier(
  ledger: ReturnType<typeof openSqliteEventStore>,
  repoId: string,
  expectedPosition: ReplicationPosition,
  expectedFrozenCut: SwitchoverFrozenCut,
): SwitchoverReplicaCut {
  const metadata = ledger.metadata(),
    position = ledger.replicationPosition(),
    revision = ledger.revision();

  let afterRevision = 0,
    done = false,
    eventDigestsValid = true,
    eventSequenceComplete = true;
  while (!done) {
    const page = ledger.eventRowPage(afterRevision, 256);
    for (const row of page.rows) {
      if (row.revision !== afterRevision + 1) eventSequenceComplete = false;
      if (row.digest !== `sha256:${sha256Text(row.eventJson)}`) eventDigestsValid = false;
      afterRevision = row.revision;
    }
    if (!page.done && page.rows.length === 0) {
      eventSequenceComplete = false;
      done = true;
      continue;
    }
    done = page.done;
  }
  let contentDigestsValid = true;
  for (const digest of ledger.contentObjectDigests()) {
    if (!/^[0-9a-f]{64}$/u.test(digest)) {
      contentDigestsValid = false;
      continue;
    }
    const objectPath = path.join(
      path.dirname(ledger.databasePath),
      "objects",
      "sha256",
      digest.slice(0, 2),
      digest.slice(2),
    );
    if (!localLedgerBackupFileSystem.lstat(objectPath, { throwIfNoEntry: false })?.isFile()) {
      contentDigestsValid = false;
      continue;
    }
    if (sha256File(objectPath) !== `sha256:${digest}`) contentDigestsValid = false;
  }
  const integrityIssues = validatePromotableReplica({
    expectedRepoId: repoId,
    actualRepoId: metadata.repoId,
    expectedGeneration: 3,
    actualGeneration: metadata.generation,
    expectedHistory: expectedPosition.history,
    actualHistory: position.history,
    expectedSequence: expectedPosition.sequence,
    actualSequence: position.sequence,
    expectedPositionRevision: expectedPosition.revision,
    actualPositionRevision: position.revision,
    metadataRevision: metadata.revision,
    ledgerRevision: revision,
    lastEventRevision: afterRevision,
    eventSequenceComplete,
    eventDigestsValid,
    contentDigestsValid,
  });
  if (integrityIssues.length > 0) throw new EdgeReplicaIntegrityError(integrityIssues);

  const replicaCut: SwitchoverReplicaCut = {
    repoId,
    revision,
    tipHash: canonicalLedgerCut(repoId, ledger.eventIdentityAtRevision(revision)).headDigest,
    history: position.history,
    sequence: position.sequence,
  };
  const barrier = evaluateRpoZeroCatchupBarrier(expectedFrozenCut, replicaCut);
  if (!barrier.ok) throw new CenterSwitchoverStorageError(barrier.code, barrier.detail);
  return replicaCut;
}

function syncTree(directory: string): void {
  const walk = (current: string): void => {
    for (const name of localLedgerBackupFileSystem.readDirectory(current)) {
      const entry = path.join(current, name);
      if (localLedgerBackupFileSystem.stat(entry).isDirectory()) walk(entry);
      else syncFile(entry);
    }
    syncDirectory(current);
  };
  walk(directory);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
