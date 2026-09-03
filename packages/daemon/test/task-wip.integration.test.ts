// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  MIGRATION_IMPORT_SOURCE,
  makeTaskEventStore,
  migrationImportWritePlan,
  sha256Text,
  type ActorIdentity,
  type ArchivedExecutionV0,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import {
  resolveTaskRootThreshold,
  resolveTaskWipLimit,
  TASK_ROOT_THRESHOLD_ENV,
  TASK_ROOT_THRESHOLD_SETTING,
  TASK_WIP_LIMIT_ENV,
} from "../src/task-wip-settings.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const actor: ActorIdentity = { principal: { personId: "person-wip" }, executor: null } as const;
type Cell = Awaited<ReturnType<typeof openRepoCell>>;

test("the execution WIP gate hard-rejects at the limit and never holds closeout backfill (kty-web deadlock)", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-wip-deadlock-"));
  const previous = process.env[TASK_WIP_LIMIT_ENV];
  process.env[TASK_WIP_LIMIT_ENV] = "2";
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-wip-deadlock"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-wip-deadlock",
      now: () => "2026-08-16T00:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    for (const [taskId, title] of [
      ["task_OCC_A", "Occupant A"],
      ["task_OCC_B", "Occupant B"],
      ["task_FRESH", "Fresh work"],
      ["task_BACKFILL", "Closeout backfill"],
    ] as const)
      await createReadyTask(cell, rootDir, taskId, title);
    // A migrated archived execution with a recorded submission is canonical delivery evidence:
    // the work is already done and the task exists only to write it off.
    const backfillPackage = await packagePathOf(cell, "task_BACKFILL");
    await cell.close();
    cell = undefined;
    await appendMigratedExecution(
      rootDir,
      "task-wip-deadlock",
      "task_BACKFILL",
      `${backfillPackage}/executions/exe_legacy.md`,
    );
    cell = await openRepoCell({
      repoId: workspaceId("task-wip-deadlock"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-wip-deadlock",
      now: () => "2026-08-16T00:00:00.000Z",
    });
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_OCC_A", executionId: "exe_occ_a" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-transition", taskId: "task_OCC_B", status: "blocked", reason: "Occupying" },
          binding,
        )
      ).outcome,
      "applied",
    );
    // The worktable is now exactly full (2/2): new work is hard-rejected, preview and apply agree.
    const fresh = await cell.run({ kind: "task-start", taskId: "task_FRESH", executionId: "exe_fresh" }, binding);
    assert.equal(fresh.outcome, "op_rejected");
    assert.equal(fresh.code, "task_wip_limit_reached");
    assert.deepEqual(fresh.diagnostic, { kind: "failure", code: "task_wip_limit_reached" });
    const preview = await cell.run(
      { kind: "task-start", taskId: "task_FRESH", executionId: "exe_fresh", dryRun: true },
      binding,
    );
    assert.equal(preview.outcome, "op_rejected");
    assert.equal(preview.code, "task_wip_limit_reached");
    // The same transition surface cannot bypass the gate.
    const sideways = await cell.run(
      { kind: "task-transition", taskId: "task_FRESH", status: "active", reason: "Bypass" },
      binding,
    );
    assert.equal(sideways.outcome, "op_rejected");
    assert.equal(sideways.code, "invalid_transition");
    // THE DEADLOCK: at a full worktable, starting the closeout backfill must still work.
    const backfill = await cell.run(
      { kind: "task-start", taskId: "task_BACKFILL", executionId: "exe_backfill" },
      binding,
    );
    assert.equal(backfill.outcome, "applied", JSON.stringify(backfill));
    // Work that reduces WIP stays open at the limit: cancel, park (occupy-to-occupy), and lease release.
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-transition",
            taskId: "task_FRESH",
            status: "cancelled",
            force: true,
            reason: "Write-down at a full worktable",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-release", taskId: "task_OCC_A", reason: "Freeing the slot" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-transition", taskId: "task_OCC_A", status: "blocked", reason: "Parking for review" },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-archive", taskId: "task_FRESH", reason: "Cancelled work leaves the worktable" },
          binding,
        )
      ).outcome,
      "applied",
    );
  } finally {
    if (previous === undefined) delete process.env[TASK_WIP_LIMIT_ENV];
    else process.env[TASK_WIP_LIMIT_ENV] = previous;
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the limit is configurable from settings.tasks.wipLimit and overridden by the environment", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-wip-settings-"));
  const previous = process.env[TASK_WIP_LIMIT_ENV];
  delete process.env[TASK_WIP_LIMIT_ENV];
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "harness/harness.yaml"),
      "layout:\n  authoredRoot: harness\nsettings:\n  tasks:\n    wipLimit: 1\n",
    );
    const open = () =>
      openRepoCell({
        repoId: workspaceId("task-wip-settings"),
        rootDir: canonicalRoot(rootDir),
        ownerId: "task-wip-settings",
        now: () => "2026-08-16T00:00:00.000Z",
      });
    cell = await open();
    const binding = { actor, source: "local" as const };
    assert.deepEqual(resolveTaskWipLimit(rootDir), { limit: 1, label: "settings.tasks.wipLimit" });
    for (const taskId of ["task_ONE", "task_TWO", "task_THREE"]) await createReadyTask(cell, rootDir, taskId, taskId);
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_ONE", executionId: "exe_one" }, binding)).outcome,
      "applied",
    );
    const project = await cell.run({ kind: "task-start", taskId: "task_TWO", executionId: "exe_two" }, binding);
    assert.equal(project.outcome, "op_rejected");
    assert.equal(project.code, "task_wip_limit_reached");
    assert.deepEqual(project.diagnostic, { kind: "failure", code: "task_wip_limit_reached" });
    process.env[TASK_WIP_LIMIT_ENV] = "3";
    await cell.close();
    cell = await open();
    assert.deepEqual(resolveTaskWipLimit(rootDir), { limit: 3, label: TASK_WIP_LIMIT_ENV });
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_TWO", executionId: "exe_two" }, binding)).outcome,
      "applied",
    );
    process.env[TASK_WIP_LIMIT_ENV] = "0";
    await cell.close();
    cell = await open();
    const invalid = await cell.run({ kind: "task-start", taskId: "task_THREE", executionId: "exe_three" }, binding);
    assert.equal(invalid.outcome, "op_rejected");
    assert.equal(invalid.code, "task_wip_limit_invalid");
    assert.deepEqual(invalid.diagnostic, { kind: "failure", code: "task_wip_limit_invalid" });
    writeFileSync(
      path.join(rootDir, "harness/harness.yaml"),
      "layout:\n  authoredRoot: harness\nsettings:\n  tasks:\n    wipLimit: 0\n",
    );
    delete process.env[TASK_WIP_LIMIT_ENV];
    await cell.close();
    cell = await open();
    const invalidSetting = await cell.run(
      { kind: "task-start", taskId: "task_THREE", executionId: "exe_three" },
      binding,
    );
    assert.equal(invalidSetting.outcome, "op_rejected");
    assert.equal(invalidSetting.code, "task_wip_limit_invalid");
    assert.deepEqual(invalidSetting.diagnostic, { kind: "failure", code: "task_wip_limit_invalid" });
  } finally {
    if (previous === undefined) delete process.env[TASK_WIP_LIMIT_ENV];
    else process.env[TASK_WIP_LIMIT_ENV] = previous;
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a standard task becomes a visible structure-derived root without rewriting taskClass", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-root-derive-"));
  const previousLimit = process.env[TASK_WIP_LIMIT_ENV],
    previousThreshold = process.env[TASK_ROOT_THRESHOLD_ENV];
  process.env[TASK_WIP_LIMIT_ENV] = "1";
  delete process.env[TASK_ROOT_THRESHOLD_ENV];
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "harness/harness.yaml"),
      "layout:\n  authoredRoot: harness\nsettings:\n  tasks:\n    wipLimit: 1\n    rootThreshold: 3\n",
    );
    const open = () =>
      openRepoCell({
        repoId: workspaceId("task-root-derive"),
        rootDir: canonicalRoot(rootDir),
        ownerId: "task-root-derive",
        now: () => "2026-08-20T00:00:00.000Z",
      });
    cell = await open();
    const binding = { actor, source: "local" as const };
    for (const [taskId, title] of [
      ["task_ROOT_3", "Three children"],
      ["task_ROOT_2", "Two children"],
      ["task_ROOT_4", "Four children"],
    ] as const)
      await createReadyTask(cell, rootDir, taskId, title);
    for (const [parentTaskId, count] of [
      ["task_ROOT_3", 3],
      ["task_ROOT_2", 2],
      ["task_ROOT_4", 4],
    ] as const)
      for (let index = 0; index < count; index++)
        await createReadyTask(cell, rootDir, `${parentTaskId}_CHILD_${index}`, `Child ${index}`, { parentTaskId });
    assert.deepEqual(resolveTaskRootThreshold(rootDir), { threshold: 3, label: TASK_ROOT_THRESHOLD_SETTING });
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_ROOT_2", executionId: "exe_root_2" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_ROOT_3", executionId: "exe_root_3" }, binding)).outcome,
      "applied",
      "3 children derives root and does not consume the existing slot",
    );
    const shown = evidence(await cell.run({ kind: "task-show", taskId: "task_ROOT_3" }, binding));
    assert.equal(
      (shown.task as { readonly taskClass: string }).taskClass,
      "standard",
      "derived root never writes taskClass",
    );
    assert.deepEqual(shown.rootAssessment, { isRoot: true, reason: "derived", directChildCount: 3, threshold: 3 });
    process.env[TASK_ROOT_THRESHOLD_ENV] = "5";
    await cell.close();
    cell = await open();
    assert.deepEqual(resolveTaskRootThreshold(rootDir), { threshold: 5, label: TASK_ROOT_THRESHOLD_ENV });
    const four = await cell.run({ kind: "task-start", taskId: "task_ROOT_4", executionId: "exe_root_4" }, binding);
    assert.equal(four.outcome, "op_rejected", "4 children occupies again after threshold is raised to 5");
    assert.equal(four.code, "task_wip_limit_reached");
    assert.deepEqual(four.diagnostic, { kind: "failure", code: "task_wip_limit_reached" });
    process.env[TASK_ROOT_THRESHOLD_ENV] = "invalid";
    await cell.close();
    cell = await open();
    const invalid = await cell.run({ kind: "task-start", taskId: "task_ROOT_4", executionId: "exe_root_4" }, binding);
    assert.equal(invalid.outcome, "op_rejected");
    assert.equal(invalid.code, "task_root_threshold_invalid");
    delete process.env[TASK_ROOT_THRESHOLD_ENV];
    writeFileSync(
      path.join(rootDir, "harness/harness.yaml"),
      "layout:\n  authoredRoot: harness\nsettings:\n  tasks:\n    wipLimit: 1\n    rootThreshold: 0\n",
    );
    await cell.close();
    cell = await open();
    const invalidSetting = await cell.run(
      { kind: "task-start", taskId: "task_ROOT_4", executionId: "exe_root_4" },
      binding,
    );
    assert.equal(invalidSetting.outcome, "op_rejected");
    assert.equal(invalidSetting.code, "task_root_threshold_invalid");
  } finally {
    if (previousLimit === undefined) delete process.env[TASK_WIP_LIMIT_ENV];
    else process.env[TASK_WIP_LIMIT_ENV] = previousLimit;
    if (previousThreshold === undefined) delete process.env[TASK_ROOT_THRESHOLD_ENV];
    else process.env[TASK_ROOT_THRESHOLD_ENV] = previousThreshold;
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task list exposes active package metadata and excludes archived packages from the worktable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-wip-projection-"));
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-wip-projection"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-wip-projection",
      now: () => "2026-08-16T00:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    await createReadyTask(cell, rootDir, "task_STD", "Standard work");
    await createReadyTask(cell, rootDir, "task_MILESTONE", "Milestone container", { taskClass: "milestone" });
    await createReadyTask(cell, rootDir, "task_ARCHIVED", "Retired work");
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_STD", executionId: "exe_std" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_MILESTONE", executionId: "exe_milestone" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-transition", taskId: "task_ARCHIVED", status: "blocked", reason: "Stale" },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-archive", taskId: "task_ARCHIVED", reason: "Retired from the worktable" }, binding))
        .outcome,
      "applied",
    );
    const listed = evidence(await cell.run({ kind: "task-list" }, binding));
    const rows = listed.rows as readonly {
      readonly taskId: string;
      readonly status: string;
      readonly taskClass: string;
      readonly packageDisposition: string;
    }[];
    const byTask = new Map(rows.map((row) => [row.taskId, row]));
    assert.equal(byTask.get("task_STD")?.taskClass, "standard");
    assert.equal(byTask.get("task_STD")?.packageDisposition, "active");
    assert.equal(byTask.get("task_MILESTONE")?.taskClass, "milestone");
    assert.equal(byTask.has("task_ARCHIVED"), false);
    // The gate's counting criteria, recomputed only from visible worktable rows: 1 occupying slot.
    const occupying = rows.filter(
      (row) =>
        ["active", "blocked", "in_review"].includes(row.status) &&
        row.packageDisposition === "active" &&
        row.taskClass === "standard",
    );
    assert.deepEqual(
      occupying.map((row) => row.taskId),
      ["task_STD"],
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a released active task returns to planned while held leases and stale writers reject", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-return-planned-"));
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-return-planned"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-return-planned",
      now: () => "2026-08-30T00:00:00.000Z",
    });
    const binding = { actor, source: "local" as const },
      taskId = "task_RETURN_PLANNED";
    await createReadyTask(cell, rootDir, taskId, "Return released work to planning");
    assert.equal(
      (await cell.run({ kind: "task-start", taskId, executionId: "exe_return_planned" }, binding)).outcome,
      "applied",
    );
    const held = await cell.run(
      { kind: "task-transition", taskId, status: "planned", reason: "Scope needs replanning" },
      binding,
    );
    assert.equal(held.outcome, "op_rejected");
    assert.equal(held.code, "invalid_transition");
    assert.deepEqual(held.diagnostic, { kind: "failure", code: "invalid_transition" });

    const released = await cell.run(
      { kind: "task-release", taskId, reason: "No worker remains; return scope to planning" },
      binding,
    );
    assert.equal(released.outcome, "applied");
    assert.match(
      String((released.next as readonly { readonly command?: string }[] | undefined)?.[0]?.command),
      new RegExp(`ha task transition ${taskId} planned --reason`, "u"),
    );

    const expectedVersion = released.revision,
      attempts = await Promise.all([
        cell.run(
          {
            kind: "task-transition",
            taskId,
            status: "planned",
            reason: "Owner returned orphaned work to planning",
            expectedVersion,
          },
          binding,
        ),
        cell.run(
          {
            kind: "task-transition",
            taskId,
            status: "planned",
            reason: "Concurrent return to planning",
            expectedVersion,
          },
          binding,
        ),
      ]),
      applied = attempts.filter((receipt) => receipt.outcome === "applied"),
      rejected = attempts.filter((receipt) => receipt.outcome === "op_rejected");
    assert.equal(applied.length, 1, JSON.stringify(attempts));
    assert.equal(rejected.length, 1, JSON.stringify(attempts));
    assert.equal(rejected[0]?.code, "invalid_transition");
    assert.equal(
      (
        JSON.parse(String((await cell.run({ kind: "task-show", taskId }, binding)).evidence)) as {
          readonly task: { readonly status: string };
        }
      ).task.status,
      "planned",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("taskClass=long_running work never occupies the execution worktable, even mid-flight", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-wip-long-running-"));
  const previous = process.env[TASK_WIP_LIMIT_ENV];
  process.env[TASK_WIP_LIMIT_ENV] = "1";
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-wip-long-running"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-wip-long-running",
      now: () => "2026-08-16T00:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    await createReadyTask(cell, rootDir, "task_OCC", "Occupant");
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_OCC", executionId: "exe_occ" }, binding)).outcome,
      "applied",
    );
    // The migration path the live carrier will take: amend an existing task into the class.
    await createReadyTask(cell, rootDir, "task_RESIDENT", "Resident ledger");
    assert.equal(
      (
        await cell.run(
          { kind: "task-amend", taskId: "task_RESIDENT", patches: [{ field: "taskClass", value: "long_running" }] },
          binding,
        )
      ).outcome,
      "applied",
    );
    await createReadyTask(cell, rootDir, "task_NATIVE", "Native resident", { taskClass: "long_running" });
    // The worktable is full at 1/1 with natural-endpoint work; resident work still runs.
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_RESIDENT", executionId: "exe_resident" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_NATIVE", executionId: "exe_native" }, binding)).outcome,
      "applied",
    );
    await createReadyTask(cell, rootDir, "task_FRESH", "Fresh work");
    const rejected = await cell.run({ kind: "task-start", taskId: "task_FRESH", executionId: "exe_fresh" }, binding);
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "task_wip_limit_reached");
    const listed = evidence(await cell.run({ kind: "task-list" }, binding));
    const rows = listed.rows as readonly {
      readonly taskId: string;
      readonly status: string;
      readonly taskClass: string;
      readonly packageDisposition: string;
    }[];
    const byTask = new Map(rows.map((row) => [row.taskId, row]));
    assert.equal(byTask.get("task_RESIDENT")?.taskClass, "long_running");
    assert.equal(byTask.get("task_RESIDENT")?.status, "active");
    assert.equal(byTask.get("task_NATIVE")?.taskClass, "long_running");
    assert.equal(byTask.get("task_NATIVE")?.status, "active");
    assert.deepEqual(
      rows
        .filter(
          (row) =>
            ["active", "blocked", "in_review"].includes(row.status) &&
            row.packageDisposition === "active" &&
            row.taskClass === "standard",
        )
        .map((row) => row.taskId),
      ["task_OCC"],
    );
  } finally {
    if (previous === undefined) delete process.env[TASK_WIP_LIMIT_ENV];
    else process.env[TASK_WIP_LIMIT_ENV] = previous;
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function packagePathOf(cell: Cell, taskId: string): Promise<string> {
  const shown = (await cell.run({ kind: "task-show", taskId }, { actor, source: "local" })) as {
    readonly evidence: string;
  };
  return String((JSON.parse(shown.evidence) as { readonly packagePath: string }).packagePath);
}

async function createReadyTask(
  cell: Cell,
  rootDir: string,
  taskId: string,
  title: string,
  options: { readonly taskClass?: "milestone" | "long_running"; readonly parentTaskId?: string } = {},
): Promise<void> {
  const binding = { actor, source: "local" as const };
  await createRealizedTaskPlanFixture(
    rootDir,
    () => cell.run({ kind: "task-create", taskId, title, ...options }, binding),
    (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    title,
  );
}

async function appendMigratedExecution(
  rootDir: string,
  repoId: string,
  taskId: string,
  documentPath: string,
): Promise<void> {
  const store = makeTaskEventStore({ repoId, rootDir });
  const execution: ArchivedExecutionV0 = {
    schema: "archived-execution/v1",
    generation: "v0",
    migratedFrom: "exe_legacy",
    executionId: "exe_legacy",
    taskId,
    nodeId: "implementation",
    iteration: 0,
    state: "submitted",
    actor: { principal: { personId: "person-wip" }, executor: null },
    claimedAt: "2026-01-01T00:00:00.000Z",
    submittedAt: "2026-01-02T00:00:00.000Z",
    closedAt: null,
    sessionBindings: [],
    outputs: [],
    submission: null,
    archivedSubmission: {
      completionClaim: "Delivered before the ledger existed",
      deliverables: [],
      evidenceRefs: [],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
    },
  };
  const body = `${JSON.stringify(execution, null, 2)}\n`,
    sha = sha256Text(body),
    opId = `migration-${sha256Text(`execution\0exe_legacy`).slice(0, 26)}`;
  const event = {
    schema: "migration-import-event/v1" as const,
    eventId: `event-${sha256Text(opId)}`,
    workspaceRevision: (store.readHead()?.revision ?? 0) + 1,
    opId,
    type: "entity_migrated" as const,
    actor: { principal: { personId: "person-wip" }, executor: null },
    source: MIGRATION_IMPORT_SOURCE,
    occurredAt: "2026-01-02T00:00:00.000Z",
    payload: {
      migratedFrom: "exe_legacy",
      generation: "v0" as const,
      entity: {
        kind: "execution" as const,
        execution,
        documentClaim: {
          path: documentPath,
          sha256: sha,
          size: Buffer.byteLength(body),
          mediaType: "application/json",
          policyId: MIGRATION_DOCUMENT_POLICY_ID,
        },
      },
    },
  };
  store.append({
    event,
    plan: migrationImportWritePlan(event),
    blobs: [{ sha256: sha, size: Buffer.byteLength(body), mediaType: "application/json", body }],
  });
  await store.drain();
}

function evidence(receipt: Awaited<ReturnType<Cell["run"]>>): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Task WIP Test");
  git(rootDir, "config", "user.email", "task-wip@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
