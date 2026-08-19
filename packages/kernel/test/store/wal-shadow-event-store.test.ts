// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import { type TaskCreatedEvent } from "../../src/domain/task-lifecycle.contract.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { makeTaskEventStore as makeGitEventStore } from "../../src/store/task-event-store.ts";
import { makeWalShadowEventStore } from "../../src/store/wal-shadow-event-store.ts";
import { openWalEventLog } from "../../src/store/wal-event-log.ts";
import { withTempStoreAsync } from "./helpers.ts";

test("S3 shadows each unchanged Git publication into a local WAL", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-shadow", rootDir });
    const event = taskCreated(1);
    const plan = taskLifecycleWritePlan(event);
    assert.deepEqual(plan.targets.filter((target) => target.kind === "local_wal_file"), [
      { kind: "local_wal_file", path: ".harness/wal/seg-000000.log", operation: "append" },
      { kind: "local_wal_file", path: ".harness/wal/head.json", operation: "replace" },
    ]);
    const receipt = store.append({
      event,
      plan,
      blobs: [],
    });
    const wal = openWalEventLog(rootDir);
    assert.equal(receipt.revision, 1);
    assert.equal(
      existsSync(path.join(rootDir, ".harness", "wal", "seg-000000.log")),
      true,
    );
    assert.deepEqual(wal.readEvent(event.opId), event);
    assert.deepEqual(wal.audit(store.read().events, store.read().revision), {
      status: "equivalent",
      walRevision: 1,
      gitRevision: 1,
      compared: 1,
      divergence: null,
    });
  });
});

test("S3 audits its WAL suffix against an existing Git history", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const gitStore = makeGitEventStore({ repoId: "wal-shadow", rootDir });
    const first = taskCreated(1);
    gitStore.append({ event: first, plan: taskLifecycleWritePlan(first), blobs: [] });
    const store = makeWalShadowEventStore({ repoId: "wal-shadow", rootDir });
    const second = taskCreated(2);
    store.append({ event: second, plan: taskLifecycleWritePlan(second), blobs: [] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const third = taskCreated(3);
    store.append({ event: third, plan: taskLifecycleWritePlan(third), blobs: [] });
    const wal = openWalEventLog(rootDir);
    assert.deepEqual(
      wal.records().map((record) => record.revision),
      [2, 3],
    );
    assert.equal(wal.audit(store.read().events, store.read().revision).status, "equivalent");
  });
});

test("S3 discards a torn WAL tail and keeps the Git-equivalence audit", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeWalShadowEventStore({ repoId: "wal-shadow", rootDir });
    const first = taskCreated(1);
    store.append({ event: first, plan: taskLifecycleWritePlan(first), blobs: [] });
    const segment = path.join(rootDir, ".harness", "wal", "seg-000000.log");
    appendFileSync(segment, '{"torn":');
    const reopened = openWalEventLog(rootDir);
    assert.deepEqual(reopened.records().map((record) => record.revision), [1]);
    assert.equal(readFileSync(segment, "utf8").endsWith("\n"), true);
    assert.equal(reopened.audit(store.read().events, store.read().revision).status, "equivalent");
  });
});

function taskCreated(revision: number): TaskCreatedEvent {
  return {
    schema: "task-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    taskId: `task-${revision}`,
    type: "task_created",
    actor: {
      principal: { personId: "person-1" },
      executor: { kind: "agent", id: "codex" },
    },
    source: "local",
    occurredAt: "2026-08-20T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v1",
        taskId: `task-${revision}`,
        title: `Task ${revision}`,
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: {
          principal: { personId: "person-1" },
          executor: { kind: "agent", id: "codex" },
        },
        completionGateIds: [],
        presetSnapshotDigest: null,
      },
    },
  };
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "WAL Shadow Test");
  git(rootDir, "config", "user.email", "wal-shadow@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
