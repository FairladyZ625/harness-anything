// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { makeTaskEventReader, makeTaskProjection, canStartExecution } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { actor, initRepo } from "./migration-import.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

test("explicit preset migration atomically freezes contract, gates and auditable snapshots", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-migration-")),
    repoId = workspaceId("preset-migration"),
    binding = { actor, source: "local" as const },
    taskId = "task_preset_migration",
    action = { kind: "task-contract-migrate" as const, taskId, toPresetId: "docs-task", mode: "apply" },
    now = "2026-09-12T01:00:00.000Z";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "migration", now: () => now });
    const created = await cell.run({ kind: "task-create", taskId, title: "Preset migration" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const reader = makeTaskEventReader({ repoId, rootDir }),
      before = reader.read(),
      original = before.events.find((event) => event.schema === "task-bootstrap-event/v1")!;
    assert.equal(original.schema, "task-bootstrap-event/v1");
    if (original.schema !== "task-bootstrap-event/v1") throw new Error("missing bootstrap");
    assert.deepEqual(original.payload.task.completionGateIds, ["ci", "code-doc-reconciliation"]);
    const preview = await cell.run({ ...action, mode: "dry-run" }, binding);
    assert.equal(preview.outcome, "pending", JSON.stringify(preview));
    assert.equal(reader.read().revision, before.revision);
    assert.match(preview.evidence!, /"applied":false/u);
    const unknown = await cell.run({ ...action, toPresetId: "not-installed" }, binding);
    assert.equal(unknown.outcome, "op_rejected", JSON.stringify(unknown));
    assert.equal(reader.read().revision, before.revision);
    const applied = await cell.run(action, binding);
    assert.equal(applied.status, "accepted_durable", JSON.stringify(applied));
    const event = reader.readEvent(applied.opId)!;
    assert.equal(event.schema, "preset-snapshot-upgrade-event/v1");
    if (event.schema !== "preset-snapshot-upgrade-event/v1") throw new Error("missing migration event");
    assert.deepEqual(event.actor, actor);
    assert.equal(event.occurredAt, now);
    assert.equal(event.payload.previousDigest, original.payload.task.presetSnapshotDigest);
    assert.equal(event.payload.task.metadata?.presetId, "docs-task");
    assert.deepEqual(event.payload.task.completionGateIds, []);
    assert.equal(event.payload.task.iteration, original.payload.task.iteration + 1);
    assert.equal(reader.read().revision, before.revision + 1);
    const projection = makeTaskProjection({ rootDir, eventStore: reader });
    const projected = projection.read(taskId),
      contract = JSON.parse(projection.readDocument(`${projected.packagePath}/task-contract.json`).document!.body);
    assert.equal(projection.readPresetSnapshot(event.payload.previousDigest).snapshot?.identity.id, "standard-task");
    assert.equal(
      projection.readPresetSnapshot(event.payload.presetSnapshotClaim.digest).snapshot?.identity.id,
      "docs-task",
    );
    assert.equal(contract.presetId, "docs-task");
    assert.equal(contract.metadata.presetId, "docs-task");
    assert.deepEqual(contract.completionGates, []);
    assert.equal(contract.presetSnapshotDigest, event.payload.presetSnapshotClaim.digest);
    assert.equal(contract.packagePath, projected.packagePath);
    assert.equal(
      canStartExecution(
        {
          ...projected.snapshot,
          task: { ...event.payload.task, status: "in_review", currentNode: "review" },
        },
        "execution_after_migration",
      ),
      true,
    );
    const rebuilt = makeTaskProjection({
      rootDir,
      eventStore: reader,
      projectionPath: path.join(rootDir, ".harness/migration-replay.sqlite"),
    });
    rebuilt.rebuild();
    assert.deepEqual(rebuilt.read(taskId).snapshot.task, projected.snapshot.task);
    assert.deepEqual(
      rebuilt.readPresetSnapshot(event.payload.presetSnapshotClaim.digest).snapshot,
      projection.readPresetSnapshot(event.payload.presetSnapshotClaim.digest).snapshot,
    );
    rebuilt.close();
    projection.close();
    await reader.drain();
    const wait = await cell.run(
      {
        kind: "receipt-show",
        opId: applied.opId,
        waitFor: ["accepted_durable", "projection_visible", "git_verified", "worktree_visible"],
        timeoutMs: 5000,
      },
      binding,
    );
    assert.equal(wait.wait?.state, "satisfied", JSON.stringify(wait));
    await realizeTaskPlanFixture(rootDir, String(created.packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    const started = await cell.run({ kind: "task-start", taskId, executionId: "execution_migrated" }, binding);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const leased = await cell.run({ ...action, toPresetId: "standard-task" }, binding);
    assert.equal(leased.code, "active_lease", JSON.stringify(leased));
    const released = await cell.run({ kind: "task-release", taskId }, binding);
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    const cancelled = await cell.run(
      {
        kind: "task-transition",
        taskId,
        status: "cancelled",
        force: true,
        reason: "Migration terminal guard",
      },
      binding,
    );
    assert.equal(cancelled.outcome, "applied", JSON.stringify(cancelled));
    const terminal = await cell.run({ ...action, toPresetId: "standard-task" }, binding);
    assert.equal(terminal.code, "terminal_task", JSON.stringify(terminal));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
