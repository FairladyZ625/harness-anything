// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { actor, initRepo } from "./migration-import.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

test("task archive accepts two members atomically and retries after pre-outcome failure", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-maintenance-batch-")),
    repoId = workspaceId("maintenance-batch"),
    binding = { actor, source: "local" as const },
    action = {
      kind: "task-archive" as const,
      taskIds: ["task_batch_one", "task_batch_two"],
      reason: "Atomic maintenance batch",
    };
  let armed = false,
    crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    crashed = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "maintenance-batch-one",
      killpoint: (point) => {
        if (armed && point === "after_event_write") throw new Error("stop before command outcome");
      },
    });
    for (const [taskId, title] of [
      ["task_batch_one", "Batch one"],
      ["task_batch_two", "Batch two"],
    ] as const) {
      const created = await crashed.run({ kind: "task-create", taskId, title }, binding);
      assert.equal(created.outcome, "applied", JSON.stringify(created));
    }
    const before = makeTaskEventReader({ repoId, rootDir }),
      beforeEvents = before.read().events,
      beforeRevision = before.read().revision,
      beforeOutcomes = beforeEvents.filter(({ opId }) => before.readCommandOutcome(opId) !== null).length;
    await before.drain();
    armed = true;
    const failed = await crashed.run(action, binding);
    armed = false;
    assert.equal(failed.outcome, "op_rejected", JSON.stringify(failed));
    const rolledBack = makeTaskEventReader({ repoId, rootDir });
    assert.equal(rolledBack.read().revision, beforeRevision);
    assert.deepEqual(rolledBack.read().events, beforeEvents);
    assert.equal(rolledBack.readCommandOutcome(failed.opId), null);
    assert.equal(
      rolledBack.read().events.filter(({ opId }) => rolledBack.readCommandOutcome(opId) !== null).length,
      beforeOutcomes,
    );
    await rolledBack.drain();
    for (const taskId of action.taskIds)
      assert.match(
        String((await crashed.run({ kind: "task-show", taskId }, binding)).evidence),
        /"packageDisposition":"active"/u,
      );

    await crashed.close();
    crashed = undefined;
    recovered = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "maintenance-batch-two",
    });
    const accepted = await recovered.run(action, binding);
    assert.equal(accepted.status, "accepted_durable", JSON.stringify(accepted));
    const committed = makeTaskEventReader({ repoId, rootDir }),
      outcome = committed.readCommandOutcome(accepted.opId)!;
    assert.equal(committed.read().revision, beforeRevision + 2);
    assert.equal(outcome.status, "accepted_durable");
    assert.equal(outcome.firstRevision, beforeRevision + 1);
    assert.equal(outcome.lastRevision, beforeRevision + 2);
    assert.equal(outcome.memberOpIds.length, 2);
    assert.equal(committed.read().events.filter((event) => outcome.memberOpIds.includes(event.opId)).length, 2);
    await committed.drain();
    for (const taskId of action.taskIds)
      assert.match(
        String((await recovered.run({ kind: "task-show", taskId }, binding)).evidence),
        /"packageDisposition":"archived"/u,
      );
  } finally {
    await crashed?.close();
    await recovered?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("queued command retains acceptance when receipt assembly fails after the store returns", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-post-accept-receipt-")),
    repoId = workspaceId("post-accept-receipt"),
    binding = { actor, source: "local" as const };
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    armed = false,
    commitCallbacks = 0;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "post-accept-receipt",
      killpoint: (point) => {
        if (armed && point === "after_sqlite_commit" && ++commitCallbacks === 2)
          throw new Error("receipt assembly failed after store acceptance");
      },
    });
    const beforeReader = makeTaskEventReader({ repoId, rootDir }),
      beforeRevision = beforeReader.read().revision;
    await beforeReader.drain();
    armed = true;
    const receipt = await cell.run(
      { kind: "task-create", taskId: "task_after_accept", title: "Accepted before receipt failure" },
      binding,
    );
    armed = false;
    assert.equal(commitCallbacks, 2, "failure must occur after the adapter returned");
    assert.equal(receipt.status, "accepted_durable", JSON.stringify(receipt));
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(receipt.acceptance?.revisionFrom, beforeRevision + 1);
    assert.equal(receipt.acceptance?.revisionTo, beforeRevision + 1);
    const reader = makeTaskEventReader({ repoId, rootDir });
    assert.equal(reader.read().revision, beforeRevision + 1);
    assert.equal(reader.readCommandOutcome(receipt.opId)?.status, "accepted_durable");
    assert.equal(reader.readEvent(receipt.opId)?.schema, "task-bootstrap-event/v1");
    await reader.drain();
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
