// harness-test-tier: contract
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DEFAULT_REPLICA_LOG_WINDOW_COMMITS,
  activateEmptyCanonicalGeneration,
  cedeCenterForSwitchover,
  closeSqliteEventStoresUnder,
  invalidateTargetSwitchoverAttempt,
  isSwitchoverAttemptInvalidated,
  makeTaskEventStore,
  openPersistentWriterEpoch,
  openReplicaStore,
  openReplicationSlots,
  openSqliteEventStore,
  promoteReplicaForSwitchover,
  readCenterFrozenCut,
  readCenterSwitchoverFence,
  retireCenter,
  rollbackCenterSwitchover,
  sqliteLedgerPath,
  switchoverActivationAuditPath,
  switchoverRollbackAuditPath,
} from "../src/index.ts";
import { readExistingWriterEpochHighWatermark } from "../src/center-switchover.ts";
import { bundle, eventAt, initRepo } from "./store/task-event-store.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("planned promoteReplicaForSwitchover enforces RPO=0 barrier, preserves history, retains replication_log window, and enables zero-basebackup resume", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-storage-switchover-")),
    repoId = "sw-repo",
    sourceRoot = path.join(root, "node-a"),
    sourceUser = path.join(root, "user-a"),
    sourceState = path.join(sourceUser, "fleet"),
    targetRoot = path.join(root, "node-b"),
    targetUser = path.join(root, "user-b"),
    targetState = path.join(targetUser, "fleet"),
    replicaDir = path.join(root, "replica-b"),
    replicaDbPath = path.join(replicaDir, "ledger.sqlite");
  try {
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(targetRoot, { recursive: true });
    initRepo(sourceRoot);
    initRepo(targetRoot);
    mkdirSync(replicaDir, { recursive: true });

    const sourceAuthority = openPersistentWriterEpoch({ stateRoot: sourceState, holderId: "center-a" });
    const leaseA = sourceAuthority.acquire(repoId, 0);
    sourceAuthority.close();
    assert.equal(leaseA.epoch, 1);

    const writer = makeTaskEventStore({
      repoId,
      rootDir: sourceRoot,
      activationPreflight: activateEmptyCanonicalGeneration,
      writerFence: () => ({ repoId, holderId: leaseA.holderId, epoch: leaseA.epoch }),
    });
    writer.append(bundle(eventAt(1)));
    writer.append(bundle(eventAt(2)));
    writer.append(bundle(eventAt(3)));
    writer.append(bundle(eventAt(4)));
    await writer.drain();

    // Seed replication slots on source so Switchover transfers them.
    const sourceSlotsPath = path.join(sourceState, "replication-slots.sqlite");
    const slots = openReplicationSlots(sourceSlotsPath);
    const frozenBefore = readCenterFrozenCut({ rootInput: sourceRoot, repoId });
    slots.claim({ repoId, nodeId: "edge-lagging" }, frozenBefore.cut.history);
    slots.close();

    // Backup source ledger into replica-b and open via openReplicaStore with default bounded window (1024).
    const sourceDbPath = sqliteLedgerPath(sourceRoot, 3);
    const rawSource = new DatabaseSync(sourceDbPath, { readOnly: true });
    try {
      await backup(rawSource, replicaDbPath);
    } finally {
      rawSource.close();
    }
    writeFileSync(
      `${replicaDbPath}.activation.json`,
      JSON.stringify(JSON.parse((await import("node:fs")).readFileSync(`${sourceDbPath}.activation.json`, "utf8"))),
    );
    const replicaStore = openReplicaStore({
      databasePath: replicaDbPath,
      repoId,
      generation: 3,
      retentionWindowCommits: DEFAULT_REPLICA_LOG_WINDOW_COMMITS,
    });
    const replicaPosition = replicaStore.position();
    replicaStore.close();

    // Record a lagging edge position (rev 2, seq < finalSequence) on the original history.
    const sourceReader = openSqliteEventStore({ rootInput: sourceRoot, repoId, readOnly: true });
    const laggingSeq = frozenBefore.replicationLogWindow.find((row) => row.revision === 2)!.sequence;
    sourceReader.close();
    assert.ok(laggingSeq < frozenBefore.cut.sequence);

    // Negative control: RPO=0 barrier rejects when frozenCut is 1 revision ahead of replica or tipHash differs.
    await assert.rejects(
      promoteReplicaForSwitchover({
        rootInput: targetRoot,
        userRoot: targetUser,
        stateRoot: targetState,
        repoId,
        switchoverId: "sw_neg_lag",
        replicaDatabasePath: replicaDbPath,
        replicaGeneration: 3,
        replicaPosition,
        expectedOldEpoch: 1,
        newEpoch: 2,
        expectedFrozenCut: { ...frozenBefore.cut, finalRevision: frozenBefore.cut.finalRevision + 1 },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "rpo_zero_barrier_unmet");
        return true;
      },
    );
    await assert.rejects(
      promoteReplicaForSwitchover({
        rootInput: targetRoot,
        userRoot: targetUser,
        stateRoot: targetState,
        repoId,
        switchoverId: "sw_neg_tip",
        replicaDatabasePath: replicaDbPath,
        replicaGeneration: 3,
        replicaPosition,
        expectedOldEpoch: 1,
        newEpoch: 2,
        expectedFrozenCut: { ...frozenBefore.cut, tipHash: `sha256:${"f".repeat(64)}` },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "rpo_zero_barrier_unmet");
        return true;
      },
    );
    assert.equal(existsSync(sqliteLedgerPath(targetRoot, 3)), false);

    // Positive: planned promotion preserves history and replication_log window, advances epoch to 2.
    const promoted = await promoteReplicaForSwitchover({
      rootInput: targetRoot,
      userRoot: targetUser,
      stateRoot: targetState,
      repoId,
      switchoverId: "sw_ok",
      replicaDatabasePath: replicaDbPath,
      replicaGeneration: 3,
      replicaPosition,
      expectedOldEpoch: 1,
      newEpoch: 2,
      expectedFrozenCut: frozenBefore.cut,
      sourceReplicationLogWindow: frozenBefore.replicationLogWindow,
      replicationSlotsSourcePath: sourceSlotsPath,
      holderId: "center-b",
    });
    assert.equal(promoted.oldEpoch, 1);
    assert.equal(promoted.newEpoch, 2);
    assert.equal(promoted.replicationHistory, frozenBefore.cut.history);
    assert.equal(promoted.finalRevision, 4);
    assert.ok(promoted.retainedLogMinSequence <= laggingSeq);
    assert.ok(promoted.retainedLogRowCount >= 4);
    assert.equal(existsSync(switchoverActivationAuditPath(targetState, repoId)), true);
    assert.equal(existsSync(path.join(targetState, "replication-slots.sqlite")), true);

    // Lagging edge at rev 2 can resume incrementally on promoted center B with ZERO basebackup!
    const promotedStore = openSqliteEventStore({ rootInput: targetRoot, repoId, readOnly: true });
    try {
      const page = promotedStore.replicationCommits(
        { history: frozenBefore.cut.history, sequence: laggingSeq, revision: 2 },
        100,
      );
      assert.equal(page.head.history, frozenBefore.cut.history);
      assert.ok(page.commits.length >= 2);
      assert.equal(page.commits.at(-1)!.position.revision, 4);
    } finally {
      promotedStore.close();
    }
  } finally {
    closeSqliteEventStoresUnder(root);
    removeTempRepository(root);
  }
});

test("Phase 1 ceded fence blocks writer-epoch revival across restarts; oldEpoch+2 rollback invalidates target attempt and rejects delayed activation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-storage-switchover-rollback-")),
    repoId = "rb-repo",
    sourceRoot = path.join(root, "node-a"),
    sourceUser = path.join(root, "user-a"),
    sourceState = path.join(sourceUser, "fleet"),
    targetRoot = path.join(root, "node-b"),
    targetUser = path.join(root, "user-b"),
    targetState = path.join(targetUser, "fleet"),
    replicaDir = path.join(root, "replica-b"),
    replicaDbPath = path.join(replicaDir, "ledger.sqlite");
  try {
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(targetRoot, { recursive: true });
    initRepo(sourceRoot);
    initRepo(targetRoot);
    mkdirSync(replicaDir, { recursive: true });

    const auth1 = openPersistentWriterEpoch({ stateRoot: sourceState, holderId: "center-a" });
    const lease1 = auth1.acquire(repoId, 0);
    auth1.close();
    assert.equal(lease1.epoch, 1);

    const writer = makeTaskEventStore({
      repoId,
      rootDir: sourceRoot,
      activationPreflight: activateEmptyCanonicalGeneration,
      writerFence: () => ({ repoId, holderId: lease1.holderId, epoch: lease1.epoch }),
    });
    writer.append(bundle(eventAt(1)));
    writer.append(bundle(eventAt(2)));
    await writer.drain();

    const frozen = readCenterFrozenCut({ rootInput: sourceRoot, repoId });
    const sourceDbPath = sqliteLedgerPath(sourceRoot, 3);
    const rawSource = new DatabaseSync(sourceDbPath, { readOnly: true });
    try {
      await backup(rawSource, replicaDbPath);
    } finally {
      rawSource.close();
    }
    writeFileSync(
      `${replicaDbPath}.activation.json`,
      (await import("node:fs")).readFileSync(`${sourceDbPath}.activation.json`, "utf8"),
    );

    // Phase 1: old center fsyncs reversible ceded fence (oldEpoch=1 -> cededEpoch=2).
    const fence = cedeCenterForSwitchover({
      userRoot: sourceUser,
      stateRoot: sourceState,
      repoId,
      switchoverId: "sw_abort_1",
      oldEpoch: 1,
      sourceNodeId: "node-a",
      targetNodeId: "node-b",
      frozenCut: frozen.cut,
      newExternalUrl: "https://node-b.example.invalid:9443",
      newLoginUrl: "https://login.example.invalid",
      spkiSha256: `sha256:${"c".repeat(64)}`,
    });
    assert.equal(fence.state, "fenced_ceded");
    assert.equal(fence.cededEpoch, 2);

    // Simulate crash & restart of old center: fresh PersistentWriterEpoch MUST refuse acquire/assert with CENTER_MOVED.
    const restartedAuthority = openPersistentWriterEpoch({ stateRoot: sourceState, holderId: "center-a-restarted" });
    try {
      assert.throws(() => restartedAuthority.acquire(repoId, 1), { code: "CENTER_MOVED" });
      assert.throws(() => restartedAuthority.assert(repoId, 1, lease1.holderId), { code: "CENTER_MOVED" });
      assert.equal(restartedAuthority.highWatermark(repoId), 2);
    } finally {
      restartedAuthority.close();
    }

    // Unverified rollback without target invalidation MUST be rejected.
    assert.throws(
      () =>
        rollbackCenterSwitchover({
          rootInput: sourceRoot,
          userRoot: sourceUser,
          stateRoot: sourceState,
          repoId,
          switchoverId: "sw_abort_1",
          targetNeverActivated: false,
          targetInvalidated: false,
          reason: "unverified attempt",
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "target_activation_not_disproven");
        return true;
      },
    );

    // F3 negative control: an empty or nonexistent target directory MUST NOT be mistaken for an unactivated target
    // and MUST NOT create a new writer-epochs/<repoId>.sqlite or switchover-invalidated/<repoId>.json.
    const emptyTargetDir = path.join(root, "empty-target-state");
    mkdirSync(emptyTargetDir, { recursive: true });
    const emptyInvalidation = invalidateTargetSwitchoverAttempt({
      targetStateRoot: emptyTargetDir,
      repoId,
      switchoverId: "sw_abort_1",
      cededEpoch: 2,
    });
    assert.equal(emptyInvalidation.targetNeverActivated, false);
    assert.equal(emptyInvalidation.targetInvalidated, false);
    assert.equal(existsSync(path.join(emptyTargetDir, "writer-epochs", `${repoId}.sqlite`)), false);
    assert.equal(existsSync(path.join(emptyTargetDir, "switchover-invalidated", `${repoId}.json`)), false);
    const missingInvalidation = invalidateTargetSwitchoverAttempt({
      targetStateRoot: path.join(root, "does-not-exist-state"),
      repoId,
      switchoverId: "sw_abort_1",
      cededEpoch: 2,
    });
    assert.equal(missingInvalidation.targetNeverActivated, false);
    assert.equal(missingInvalidation.targetInvalidated, false);

    // Step 1 of audited rollback: prove initialized target never activated epoch 2 and durably invalidate sw_abort_1.
    mkdirSync(targetState, { recursive: true });
    const invalidated = invalidateTargetSwitchoverAttempt({
      targetStateRoot: targetState,
      targetRootInput: targetRoot,
      targetReplicaDatabasePath: replicaDbPath,
      repoId,
      switchoverId: "sw_abort_1",
      cededEpoch: 2,
    });
    assert.equal(invalidated.targetNeverActivated, true);
    assert.equal(invalidated.targetInvalidated, true);
    assert.equal(isSwitchoverAttemptInvalidated(targetState, repoId, "sw_abort_1"), true);

    // Step 2: commit audited oldEpoch + 2 rollback on old center (epoch jumps 1 -> 3!).
    const rolledBack = rollbackCenterSwitchover({
      rootInput: sourceRoot,
      userRoot: sourceUser,
      stateRoot: sourceState,
      repoId,
      switchoverId: "sw_abort_1",
      targetNeverActivated: invalidated.targetNeverActivated,
      targetInvalidated: invalidated.targetInvalidated,
      reason: "target crashed before Phase 2",
      holderId: "center-a-recovered",
    });
    assert.equal(rolledBack.oldEpoch, 1);
    assert.equal(rolledBack.cededEpoch, 2);
    assert.equal(rolledBack.rollbackEpoch, 3);
    assert.equal(readCenterSwitchoverFence(sourceUser, repoId), null);
    assert.equal(existsSync(switchoverRollbackAuditPath(sourceState, repoId, "sw_abort_1")), true);

    // Verify source ledger is now writable at epoch 3.
    const recoveredStore = openSqliteEventStore({ rootInput: sourceRoot, repoId, readOnly: true });
    try {
      assert.equal(recoveredStore.writerFence()?.epoch, 3);
    } finally {
      recoveredStore.close();
    }

    // Delayed Phase 2 activation for invalidated sw_abort_1 arriving on target MUST be rejected!
    const replicaPos = openSqliteEventStore({ repoId, databasePath: replicaDbPath, readOnly: true });
    const pos = replicaPos.replicationPosition();
    replicaPos.close();
    await assert.rejects(
      promoteReplicaForSwitchover({
        rootInput: targetRoot,
        userRoot: targetUser,
        stateRoot: targetState,
        repoId,
        switchoverId: "sw_abort_1",
        replicaDatabasePath: replicaDbPath,
        replicaGeneration: 3,
        replicaPosition: pos,
        expectedOldEpoch: 1,
        newEpoch: 2,
        expectedFrozenCut: frozen.cut,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "switchover_attempt_invalidated");
        return true;
      },
    );

    // Permanent retire tombstone remains strictly irreversible and blocks cedeCenterForSwitchover.
    retireCenter({
      userRoot: sourceUser,
      repoId,
      oldEpoch: 3,
      finalRevision: 2,
      tipHash: frozen.cut.tipHash,
      newExternalUrl: "https://permanent.example.invalid:9443",
      newLoginUrl: "https://permanent-login.example.invalid",
      spkiSha256: `sha256:${"d".repeat(64)}`,
    });
    assert.throws(
      () =>
        cedeCenterForSwitchover({
          userRoot: sourceUser,
          stateRoot: sourceState,
          repoId,
          switchoverId: "sw_after_retire",
          oldEpoch: 3,
          sourceNodeId: "node-a",
          targetNodeId: "node-b",
          frozenCut: frozen.cut,
          newExternalUrl: "https://node-b.example.invalid:9443",
          newLoginUrl: "https://login.example.invalid",
          spkiSha256: `sha256:${"c".repeat(64)}`,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "center_permanently_retired");
        return true;
      },
    );
  } finally {
    closeSqliteEventStoresUnder(root);
    removeTempRepository(root);
  }
});

test("F10: readExistingWriterEpochHighWatermark reads an existing WAL writer-epoch DB with zero file/mtime/directory mutations", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-storage-switchover-f10-")),
    stateRoot = path.join(root, "fleet"),
    repoId = "f10-repo";
  try {
    assert.equal(readExistingWriterEpochHighWatermark(stateRoot, repoId), null);
    assert.equal(existsSync(stateRoot), false, "F10: missing stateRoot must not be mkdir'd");

    const authority = openPersistentWriterEpoch({ stateRoot, holderId: "prior-center" });
    const lease = authority.acquire(repoId, 0);
    authority.close();
    assert.equal(lease.epoch, 1);

    const epochsDir = path.join(stateRoot, "writer-epochs");
    const dbPath = path.join(epochsDir, `${repoId}.sqlite`);
    const pinnedTime = new Date("2025-01-01T00:00:00.000Z");
    utimesSync(dbPath, pinnedTime, pinnedTime);
    utimesSync(epochsDir, pinnedTime, pinnedTime);
    const dirEntriesBefore = readdirSync(epochsDir).sort();
    const dbBytesBefore = readFileSync(dbPath);
    const dbMtimeBefore = statSync(dbPath).mtimeMs;
    const dirMtimeBefore = statSync(epochsDir).mtimeMs;

    const watermark = readExistingWriterEpochHighWatermark(stateRoot, repoId);
    assert.equal(watermark, 1);
    assert.deepEqual(readdirSync(epochsDir).sort(), dirEntriesBefore, "F10: must not create -wal/-shm files");
    assert.equal(Buffer.compare(readFileSync(dbPath), dbBytesBefore), 0, "F10: DB bytes must be unchanged");
    assert.equal(statSync(dbPath).mtimeMs, dbMtimeBefore, "F10: DB mtime must be unchanged");
    assert.equal(statSync(epochsDir).mtimeMs, dirMtimeBefore, "F10: directory mtime must be unchanged");
  } finally {
    removeTempRepository(root);
  }
});
