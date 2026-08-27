// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventStore,
  makeTaskProjection,
  REPLAY_TASK_GRAPH,
  taskLifecycleWritePlan,
  type TaskEventV1,
} from "../../kernel/src/index.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

import { actor, initRepo } from "./task-surface.fixtures.ts";
test("forced cancellation is audited and terminal tasks require supersede instead of reopen", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-terminal-surface-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-terminal-surface"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-terminal-surface",
      now: () => "2026-08-15T02:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    await cell.run(
      {
        kind: "task-create",
        taskId: "task_terminal",
        title: "Terminal",
        profileId: "baseline",
      },
      binding,
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-transition",
            taskId: "task_terminal",
            status: "cancelled",
          },
          binding,
        )
      ).outcome,
      "op_rejected",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-transition",
            taskId: "task_terminal",
            status: "cancelled",
            force: true,
            reason: "Audited cancellation after invalid scope",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    await cell.run(
      {
        kind: "task-archive",
        taskId: "task_terminal",
        reason: "Retain cancellation audit",
      },
      binding,
    );
    const reopen = await cell.run(
      { kind: "task-reopen", taskId: "task_terminal", reason: "More work" },
      binding,
    );
    assert.equal(reopen.outcome, "op_rejected");
    assert.match(String(reopen.nextAction), /supersede/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("aggregate-authored status events rebuild to the exact hot snapshot", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-status-replay-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-status-replay"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-status-replay",
      now: () => "2026-08-15T02:15:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-create",
            taskId: "task_status_replay",
            title: "Status replay",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-transition",
            taskId: "task_status_replay",
            status: "blocked",
            reason: "Waiting for a dependency",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-transition",
            taskId: "task_status_replay",
            status: "active",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-transition",
            taskId: "task_status_replay",
            status: "blocked",
            reason: "Dependency regressed",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-transition",
            taskId: "task_status_replay",
            status: "cancelled",
            force: true,
            reason: "Scope withdrawn",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const hot = (await cell.read("repo.tasks.list")).rows.find(
      (row) => row.taskId === "task_status_replay",
    )?.snapshot;
    assert.ok(hot);
    await cell.close();
    cell = undefined;
    const store = makeTaskEventStore({ repoId: "task-status-replay", rootDir }),
      replay = makeTaskProjection({ rootDir, eventStore: store });
    assert.deepEqual(
      store
        .read()
        .events.filter((event) => event.schema === "task-event/v1")
        .map((event) => event.type),
      [
        "task_transitioned",
        "task_transitioned",
        "task_transitioned",
        "task_transitioned",
      ],
    );
    replay.close();
    rmSync(replay.path, { force: true });
    const rebuilt = replay.rebuild(),
      cold = replay.read("task_status_replay").snapshot;
    assert.equal(rebuilt.watermark, store.readHead()?.revision);
    assert.deepEqual(cold, hot);
    replay.close();
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("batch archive preflights every selected task before publishing any event", async () => {
  const rootDir = mkdtempSync(
    path.join(tmpdir(), "ha-task-archive-preflight-"),
  );
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-archive-preflight"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-archive-preflight",
      now: () => "2026-08-15T02:30:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    await cell.run(
      {
        kind: "task-create",
        taskId: "task_archive_valid",
        title: "Archive valid",
      },
      binding,
    );
    const before = makeTaskEventStore({
      repoId: "task-archive-preflight",
      rootDir,
    }).read().events.length;
    const receipt = await cell.run(
      {
        kind: "task-archive",
        taskIds: ["task_archive_valid", "task_archive_missing"],
        reason: "Batch retirement",
      },
      binding,
    );
    assert.equal(receipt.outcome, "op_rejected");
    assert.equal(
      makeTaskEventStore({ repoId: "task-archive-preflight", rootDir }).read()
        .events.length,
      before,
    );
    assert.match(
      String(
        (
          await cell.run(
            { kind: "task-show", taskId: "task_archive_valid" },
            binding,
          )
        ).evidence,
      ),
      /"packageDisposition":"active"/u,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("contract migration keeps incomplete legacy L1 tasks in the manual queue", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-contract-manual-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    const event: TaskEventV1 = {
      schema: "task-event/v1",
      eventId: "event-legacy",
      workspaceRevision: 1,
      opId: "op-legacy",
      taskId: "task_legacy_l1",
      type: "task_created",
      actor,
      source: "local",
      occurredAt: "2026-08-15T02:45:00.000Z",
      payload: {
        task: {
          schema: "task/v1",
          taskId: "task_legacy_l1",
          title: "Legacy L1",
          taskClass: "standard",
          status: "planned",
          graph: REPLAY_TASK_GRAPH,
          currentNode: "implementation",
          iteration: 0,
          createdBy: actor,
          completionGateIds: [],
          presetSnapshotDigest: null,
        },
      },
    };
    makeTaskEventStore({ repoId: "task-contract-manual", rootDir }).append({
      event,
      plan: taskLifecycleWritePlan(event),
      blobs: [],
    });
    cell = await openRepoCell({
      repoId: workspaceId("task-contract-manual"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-contract-manual",
      now: () => "2026-08-15T02:45:00.000Z",
    });
    const revisionBeforeDryRun = makeTaskEventStore({ repoId: "task-contract-manual", rootDir }).read().revision;
    const receipt = await cell.run(
      {
        kind: "task-contract-migrate",
        mode: "dry-run",
        taskId: "task_legacy_l1",
      },
      { actor, source: "local" },
    );
    assert.equal(receipt.outcome, "pending");
    assert.equal(receipt.proof?.canonicalVisible, false);
    assert.equal(
      makeTaskEventStore({ repoId: "task-contract-manual", rootDir }).read()
        .revision,
      revisionBeforeDryRun,
    );
    assert.match(
      String(receipt.evidence),
      /"status":"manual"[\s\S]*"reason":"contract_metadata_incomplete"/u,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
