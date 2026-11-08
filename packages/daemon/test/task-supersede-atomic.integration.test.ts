// harness-test-tier: integration
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";

import { openDispatchStream } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

test("supersede with a new task accepts both events atomically and retries after rollback", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-supersede-atomic-")),
    repoId = workspaceId("task-supersede-atomic"),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
    action = {
      kind: "task-supersede",
      oldTaskId: "task_atomic_old",
      title: "Atomic replacement",
      slug: "atomic-replacement",
      reason: "Replace the original scope atomically",
    } as const;
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    failBeforeOutcome = false;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-supersede-atomic-first",
      now: () => "2026-09-06T00:00:00.000Z",
      killpoint: (point) => {
        if (failBeforeOutcome && point === "after_event_write") {
          failBeforeOutcome = false;
          throw new Error("crash before command outcome");
        }
      },
    });
    const created = await cell.run({ kind: "task-create", taskId: "task_atomic_old", title: "Original task" }, binding);
    assert.equal(created.status, "accepted_durable", JSON.stringify(created));
    const before = makeTaskEventReader({ repoId, rootDir }).read().revision;

    failBeforeOutcome = true;
    const rolledBack = await cell.run(action, binding);
    assert.equal(rolledBack.outcome, "op_rejected", JSON.stringify(rolledBack));
    assert.equal(rolledBack.acceptance, null);
    const afterFailure = makeTaskEventReader({ repoId, rootDir });
    assert.equal(afterFailure.read().revision, before);
    assert.equal(afterFailure.readCommandOutcome(rolledBack.opId), null);
    await afterFailure.drain();
    assert.equal(cell.status().state, "unavailable");
    assert.equal(cell.status().projectionReadable, true);
    const listed = JSON.parse(String((await cell.run({ kind: "task-list" }, binding)).evidence)) as {
      readonly rows: readonly { readonly taskId: string }[];
    };
    assert.deepEqual(
      listed.rows.map(({ taskId }) => taskId),
      ["task_atomic_old"],
    );
    const oldAfterFailure = JSON.parse(
      String((await cell.run({ kind: "task-show", taskId: "task_atomic_old" }, binding)).evidence),
    ) as { readonly task: { readonly packageDisposition?: string; readonly supersededBy?: string | null } };
    assert.equal(oldAfterFailure.task.packageDisposition ?? "active", "active");
    assert.equal(oldAfterFailure.task.supersededBy ?? null, null);

    await cell.close();
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-supersede-atomic-retry",
      now: () => "2026-09-06T00:00:00.000Z",
    });
    const accepted = await cell.run(action, binding);
    assert.equal(accepted.status, "accepted_durable", JSON.stringify(accepted));
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    assert.equal(accepted.acceptance?.revisionFrom, before + 1);
    assert.equal(accepted.acceptance?.revisionTo, before + 2);
    assert.equal(accepted.acceptance?.memberOpIds.length, 2);
    assert.equal(accepted.acceptance?.memberOpIds.at(-1), accepted.opId);
    assert.equal(typeof accepted.replacementTaskId, "string");

    const reader = makeTaskEventReader({ repoId, rootDir }),
      members = accepted.acceptance?.memberOpIds.map((opId) => reader.readEvent(opId));
    assert.deepEqual(
      members?.map((event) => event?.type),
      ["task_bootstrapped", "task_superseded"],
    );
    assert.equal(reader.read().revision, before + 2);
    assert.deepEqual(reader.readCommandOutcome(accepted.opId)?.memberOpIds, accepted.acceptance?.memberOpIds);
    await reader.drain();

    const oldAfterRetry = JSON.parse(
      String((await cell.run({ kind: "task-show", taskId: "task_atomic_old" }, binding)).evidence),
    ) as {
      readonly task: {
        readonly status: string;
        readonly packageDisposition: string;
        readonly supersededBy: string | null;
      };
    };
    assert.equal(oldAfterRetry.task.status, "cancelled");
    assert.equal(oldAfterRetry.task.packageDisposition, "archived");
    assert.equal(oldAfterRetry.task.supersededBy, accepted.replacementTaskId);
    const replacement = await cell.run({ kind: "task-show", taskId: String(accepted.replacementTaskId) }, binding);
    assert.equal(replacement.outcome, "applied", JSON.stringify(replacement));
    const replay = await cell.run(action, binding);
    assert.equal(replay.status, "accepted_durable", JSON.stringify(replay));
    assert.equal(replay.opId, accepted.opId);
    assert.equal(replay.replacementTaskId, accepted.replacementTaskId);
    assert.deepEqual(replay.acceptance, accepted.acceptance);
    const afterReplay = makeTaskEventReader({ repoId, rootDir });
    assert.equal(afterReplay.read().revision, before + 2);
    await afterReplay.drain();
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("supersede lands an active task in cancelled and points the receipt at the replacement", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-supersede-active-")),
    repoId = workspaceId("task-supersede-active"),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
    oldTaskId = "task_active_old",
    replacementTaskId = "task_active_replacement";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-supersede-active",
      now: () => "2026-09-07T00:00:00.000Z",
    });
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: oldTaskId, title: "Active original" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-transition", taskId: oldTaskId, status: "active", reason: "Start the work" },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: replacementTaskId, title: "Replacement" }, binding)).outcome,
      "applied",
    );
    const accepted = await cell.run(
      {
        kind: "task-supersede",
        oldTaskId,
        byTaskId: replacementTaskId,
        confirm: oldTaskId,
        reason: "Replacement carries the future work",
      },
      binding,
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    assert.equal(accepted.status, "accepted_durable", JSON.stringify(accepted));

    const shown = JSON.parse(String((await cell.run({ kind: "task-show", taskId: oldTaskId }, binding)).evidence)) as {
      readonly task: {
        readonly status: string;
        readonly packageDisposition: string;
        readonly supersededBy: string | null;
      };
    };
    assert.equal(shown.task.status, "cancelled");
    assert.equal(shown.task.packageDisposition, "archived");
    assert.equal(shown.task.supersededBy, replacementTaskId);

    const reader = makeTaskEventReader({ repoId, rootDir }),
      event = reader.readEvent(accepted.opId);
    assert.equal(event?.type, "task_superseded");
    assert.equal(event?.schema, "task-event/v1");
    const recordedTask =
      event?.schema === "task-event/v1" && event.type === "task_superseded" ? event.payload.task : null;
    assert.equal(recordedTask?.status, "cancelled");
    assert.notEqual(
      `${recordedTask?.packageDisposition ?? "active"}/${recordedTask?.status}`,
      "archived/active",
      "a supersede event must never record the archived+active pair",
    );
    assert.deepEqual(
      (accepted.next ?? []).map(({ command }) => command).filter((command) => command?.startsWith("ha task start")),
      [],
    );
    assert.ok(
      (accepted.next ?? []).some(({ command }) => command === `ha task show ${replacementTaskId}`),
      JSON.stringify(accepted.next),
    );
    await reader.drain();
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("supersede refuses while a task dispatch is unsettled", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-supersede-dispatch-")),
    repoId = workspaceId("task-supersede-dispatch"),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
    oldTaskId = "task_dispatch_old",
    replacementTaskId = "task_dispatch_replacement",
    dispatchId = "dispatch_333333333333333333333333";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-supersede-dispatch",
      now: () => "2026-09-07T00:00:00.000Z",
    });
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: oldTaskId, title: "Dispatched original" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: replacementTaskId, title: "Replacement" }, binding)).outcome,
      "applied",
    );
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: oldTaskId,
      executionId: null,
      runtimeSessionId: "runtime_333333333333333333333333",
      instanceId: "instance-1",
      startedAt: "2026-09-07T00:00:00.000Z",
    });
    const rejected = await cell.run(
      {
        kind: "task-supersede",
        oldTaskId,
        byTaskId: replacementTaskId,
        confirm: oldTaskId,
        reason: "Replacing a task whose dispatch is still running",
      },
      binding,
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "unsettled_dispatch");
    const shown = JSON.parse(String((await cell.run({ kind: "task-show", taskId: oldTaskId }, binding)).evidence)) as {
      readonly task: { readonly packageDisposition?: string; readonly supersededBy?: string | null };
    };
    assert.equal(shown.task.packageDisposition ?? "active", "active");
    assert.equal(shown.task.supersededBy ?? null, null);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
