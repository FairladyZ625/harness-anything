import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  openPersistentWriterEpoch,
  withWriterEpochFenceDescriptor,
} from "../../../packages/daemon/src/writer-epoch.ts";
import { lifecycleFixture } from "../../../packages/kernel/test/store/task-lifecycle-fixture.ts";
import { taskLifecycleWritePlan } from "../../../packages/kernel/src/domain/task-lifecycle-publication.ts";
import { makeTaskEventStore } from "../../../packages/kernel/src/store/task-event-store.ts";
import { makeTaskProjection } from "../../../packages/kernel/src/projection/rebuildable-task-projection.ts";
import { oracleO5, oracleO6 } from "../core/oracles.mjs";

const writerSource = path.resolve("packages/daemon/src/writer-epoch.ts"),
  writerFixture = path.resolve("packages/daemon/test/stress/recovery/writer-epoch-process.fixture.mjs"),
  regressionFixture = path.resolve("packages/daemon/test/writer-epoch-process.fixture.mjs");

export function runWriterFenceScenario(root) {
  mkdirSync(root, { recursive: true });
  const emptyState = path.join(root, "empty-publish"),
    emptyKilled = spawnSync(
      process.execPath,
      [regressionFixture, writerSource, emptyState, "kill-before-publish"],
      processOptions(),
    ),
    emptyRecovered = spawnSync(
      process.execPath,
      [regressionFixture, writerSource, emptyState, "acquire"],
      processOptions(),
    );
  assert.equal(emptyKilled.signal, "SIGKILL", emptyKilled.stderr);
  assert.match(emptyKilled.stdout, /exclusive-acquired-before-publish/u);
  assert.equal(emptyRecovered.status, 0, emptyRecovered.stderr);
  assert.equal(JSON.parse(emptyRecovered.stdout).epoch, 1);

  const historyState = path.join(root, "history-publish"),
    historyKilled = spawnSync(
      process.execPath,
      [writerFixture, writerSource, historyState, "kill-after-history", "retired-holder"],
      processOptions(),
    ),
    historyRecovered = spawnSync(
      process.execPath,
      [writerFixture, writerSource, historyState, "acquire", "recovery-holder"],
      processOptions(),
    );
  assert.equal(historyKilled.signal, "SIGKILL", historyKilled.stderr);
  assert.match(historyKilled.stdout, /history-inserted-before-state-publish/u);
  assert.equal(historyRecovered.status, 0, historyRecovered.stderr);
  assert.equal(
    JSON.parse(historyRecovered.stdout).epoch,
    1,
    "the killed transaction must roll back its history insert",
  );

  const liveState = path.join(root, "live-takeover"),
    oldAuthority = openPersistentWriterEpoch({ stateRoot: liveState, holderId: "old-holder" }),
    oldLease = oldAuthority.acquire("stress-s3-repo"),
    newAuthority = openPersistentWriterEpoch({ stateRoot: liveState, holderId: "new-holder" }),
    newLease = newAuthority.acquire("stress-s3-repo"),
    writes = [];
  const oldDescriptor = {
    schema: "harness-writer-epoch-fence/v1",
    stateRoot: liveState,
    repoId: oldLease.repoId,
    holderId: oldLease.holderId,
    epoch: oldLease.epoch,
  };
  assert.throws(
    () => withWriterEpochFenceDescriptor(oldDescriptor, () => writes.push("canonical", "objects/refs")),
    (error) => error instanceof Error && "code" in error && error.code === "writer_epoch_stale",
  );
  assert.deepEqual(writes, [], "the stale callback must not reach either write face");
  const identity = {
    writerClaims: [
      { repoId: oldLease.repoId, holder: oldLease.holderId, epoch: oldLease.epoch, sequence: 1 },
      { repoId: newLease.repoId, holder: newLease.holderId, epoch: newLease.epoch, sequence: 2 },
    ],
    writes: [],
    scheduleClaims: [],
    replicas: [],
  };
  const green = oracleO6({ identity }),
    red = oracleO6({
      identity: {
        ...identity,
        writes: [
          {
            repoId: oldLease.repoId,
            opId: "stale-write-red-control",
            holder: oldLease.holderId,
            epoch: oldLease.epoch,
            sequence: 3,
            status: "accepted_durable",
          },
        ],
      },
    });
  oldAuthority.close();
  newAuthority.close();
  assert.equal(green.verdict, "PASS");
  assert.equal(red.verdict, "FAIL");
  return {
    redControl: control("F05/stale-epoch-write", red),
    caseResult: {
      id: "F05/writer-epoch-rollback-and-stale-fence",
      boundaryHits: [
        "BEGIN IMMEDIATE before publication",
        "history insert before current-state upsert",
        "old holder released after new holder acquire",
      ],
      faults: [
        { kind: "SIGKILL", boundary: "transaction acquired before publication" },
        { kind: "SIGKILL", boundary: "history insert before state publish" },
      ],
      observations: {
        emptyLockRecoveryEpoch: 1,
        historyRollbackRecoveryEpoch: 1,
        takeoverEpoch: newLease.epoch,
        staleCanonicalWrites: 0,
        staleObjectRefWrites: 0,
      },
      oracles: { O6: green.verdict },
      verdict: "PASS",
    },
  };
}

export async function runProjectionOwnerScenario(root) {
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Stress Projection Test");
  git(root, "config", "user.email", "stress-projection@example.invalid");
  git(root, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  const repoId = "stress-s3-owner-collision",
    eventStore = makeTaskEventStore({ repoId, rootDir: root }),
    projection = makeTaskProjection({ rootDir: root, eventStore }),
    ids = { executionId: "shared-execution", reviewId: "shared-review" };
  let revision = 0;
  for (const taskId of ["task-owner-one", "task-owner-two"])
    for (const original of lifecycleFixture({ taskId, ...ids }).events) {
      revision += 1;
      const event = {
        ...original,
        eventId: `${original.eventId}-${taskId}`,
        opId: `${original.opId}-${taskId}`,
        workspaceRevision: revision,
      };
      eventStore.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
      projection.apply(event, taskLifecycleWritePlan(event));
    }
  const hotRows = ownerRows(projection),
    hotLeaseGuards = leaseGuards(projection);
  assert.equal(hotRows.length, 4);
  projection.close();
  rmSync(projection.path, { force: true });
  projection.rebuild();
  const rebuildRows = ownerRows(projection),
    rebuildLeaseGuards = leaseGuards(projection),
    apiRows = ["task-owner-one", "task-owner-two"].flatMap((taskId) => {
      const snapshot = projection.read(taskId).snapshot;
      return [
        ...snapshot.executions.map((value) => ({ kind: "execution", id: value.executionId, ownerId: taskId, value })),
        ...snapshot.reviews.map((value) => ({ kind: "review", id: value.reviewId, ownerId: taskId, value })),
      ];
    }),
    oracleInput = {
      authority: "canonical",
      canonicalProjection: { hotRows, rebuildRows, apiRows, hotLeaseGuards, rebuildLeaseGuards },
    },
    green = oracleO5(oracleInput),
    brokenRows = [...new Map(rebuildRows.map((row) => [`${row.kind}:${row.id}`, row])).values()],
    red = oracleO5({
      authority: "canonical",
      canonicalProjection: {
        hotRows,
        rebuildRows: brokenRows,
        apiRows,
        hotLeaseGuards,
        rebuildLeaseGuards,
      },
    });
  projection.close();
  await eventStore.drain();
  assert.equal(green.verdict, "PASS", JSON.stringify(green));
  assert.equal(red.verdict, "FAIL", JSON.stringify(red));
  return {
    redControl: control("F09/entity-key-without-owner", red),
    caseResult: {
      id: "F09/projection-owner-collision",
      boundaryHits: ["hot apply", "projection cache discard", "strict cold rebuild", "API task-owner reads"],
      faults: [{ kind: "bad-model", boundary: "entity key omits task owner" }],
      observations: {
        hotRows: hotRows.length,
        rebuildRows: rebuildRows.length,
        apiRows: apiRows.length,
        owners: [...new Set(rebuildRows.map(({ ownerId }) => ownerId))].sort(),
      },
      oracles: { O5: green.verdict },
      verdict: "PASS",
    },
  };
}

function ownerRows(projection) {
  return ["execution", "review"].flatMap((kind) =>
    projection
      .listEntities(kind)
      .map(({ workspaceRevision: _revision, freshness: _freshness, currentVersion: _version, ...row }) => row),
  );
}

function leaseGuards(projection) {
  return ["task-owner-one", "task-owner-two"].map((taskId) => ({
    taskId,
    intervals: projection.readLeaseIntervals(taskId),
  }));
}

function processOptions() {
  return { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" };
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function control(id, observed) {
  return { id, observed: observed.verdict, passed: observed.verdict !== "PASS", violations: observed.violations };
}
