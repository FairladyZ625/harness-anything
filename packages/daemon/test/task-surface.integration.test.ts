// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import {
  makeTaskEventReader,
  makeTaskEventStore,
  makeTaskProjection,
  REPLAY_TASK_GRAPH,
  taskLifecycleWritePlan,
  type TaskEventV1,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import {
  openBootstrappedRepoCell as openRepoCell,
  seedSettingsEvent,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

import { actor, git, initRepo } from "./task-surface.fixtures.ts";

import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const ciBin = mkdtempSync(path.join(tmpdir(), "ha-submit-ci-bin-"));
const originalPath = process.env.PATH;
before(() => {
  writeProviderExecutable(
    path.join(ciBin, "gh"),
    'if (process.argv[2] !== "run" || process.argv[3] !== "list") process.exit(1); console.log("[]");\n',
  );
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});

test("task create rejects ids that cannot form task entity references", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-id-ref-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("task-id-ref"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "task-id-ref-create",
  });
  t.after(() => cell.close());
  const rejected = await cell.run(
    { kind: "task-create", taskId: "t0", title: "Invalid id" },
    { actor, source: "local" },
  );
  assert.equal(rejected.outcome, "op_rejected");
  assert.equal(rejected.code, "invalid_field");
  const accepted = await cell.run(
    { kind: "task-create", taskId: "task-t0", title: "Valid id" },
    { actor, source: "local" },
  );
  assert.equal(accepted.outcome, "applied");
  // Bench F7: the same admission guard covers every lifecycle identity, not only task create.
  const proposed = await cell.run(
      {
        kind: "decision-propose",
        jsonInput: JSON.stringify({
          title: "Reckon target",
          question: "Which task delivers it?",
          riskTier: "low",
          urgency: "low",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: ["harness-anything"] },
          chosen: [{ id: "CH1", text: "Deliver it" }],
          rejected: [{ id: "RJ1", text: "Skip it", whyNot: "It is needed" }],
          claims: [{ id: "C1", text: "It is needed", loadBearing: false }],
        }),
      },
      { actor, source: "local" },
    ),
    decisionId = (JSON.parse(String(proposed.evidence)) as { readonly decisionId: string }).decisionId;
  for (const action of [
    { kind: "decision-reckon", decisionId, taskId: "t0" },
    { kind: "task-start", commandType: "StartExecution", taskId: "task-t0", executionId: "exec.1" },
    { kind: "task-review-execution", commandType: "RecordReview", taskId: "task-t0", reviewId: "review.1" },
  ]) {
    const refused = await cell.run(action, { actor, source: "local" });
    assert.deepEqual([refused.outcome, refused.code], ["op_rejected", "invalid_field"], JSON.stringify(refused));
  }
  const listed = await cell.run({ kind: "task-list" }, { actor, source: "local" });
  assert.match(String(listed.evidence), /task-t0/u);
});

test("task create publishes complete metadata and first-class relations survive cold rebuild", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-surface-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-surface"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-surface-create",
      now: () => "2026-08-15T00:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-create",
            taskId: "task_dependency",
            title: "Dependency",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const created = (await cell.run(
      {
        kind: "task-create",
        taskId: "task_surface",
        title: "Surface",
        idempotencyKey: "surface-once",
        parentTaskId: "task_dependency",
        workKind: "feat",
        riskTier: "high",
        urgency: "medium",
        verticalId: "software/coding",
        presetId: "standard-task",
        profileId: "baseline",
        moduleKey: "kernel",
        registerModule: {
          key: "kernel",
          title: "Kernel",
          prefix: "KER",
          scope: "packages/kernel/**",
        },
        slug: "surface",
        surfaces: ["ha task create", "packages/kernel"],
        locale: "zh-CN",
      },
      binding,
    )) as Record<string, unknown>;
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assert.equal(created.packagePath, "tasks/task_surface-surface");
    const event = makeTaskEventReader({ repoId: "task-surface", rootDir })
      .read()
      .events.find(
        (candidate) => candidate.schema === "task-bootstrap-event/v1" && candidate.taskId === "task_surface",
      );
    assert.ok(event && event.schema === "task-bootstrap-event/v1");
    assert.deepEqual(event.payload.task.metadata, {
      idempotencyKey: "surface-once",
      parentTaskId: "task_dependency",
      workKind: "feat",
      riskTier: "high",
      urgency: "medium",
      verticalId: "software/coding",
      presetId: "standard-task",
      profileId: "baseline",
      moduleKey: "kernel",
      slug: "surface",
      surfaces: ["ha task create", "packages/kernel"],
      fromLegacyId: null,
    });
    assert.equal("relations" in event.payload.task, false);
    const related = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: "task/task_surface",
        targetRef: "task/task_dependency",
        relationType: "depends-on",
        rationale: "Dependency must land first",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(related.outcome, "applied", JSON.stringify(related));
    // Writes return at acceptance; the worktree follower settles afterwards, so wait before reading the package.
    await waitForFixturePublication(cell, related.opId, binding);
    const index = readFileSync(path.join(rootDir, "harness/tasks/task_surface-surface/INDEX.md"), "utf8"),
      contract = JSON.parse(
        readFileSync(path.join(rootDir, "harness/tasks/task_surface-surface/task-contract.json"), "utf8"),
      ) as Record<string, unknown>;
    assert.doesNotMatch(index, /relations:/u);
    assert.equal((contract.metadata as { moduleKey: string }).moduleKey, "kernel");
    const replay = makeTaskProjection({
        rootDir,
        eventStore: makeTaskEventReader({ repoId: "task-surface", rootDir }),
      }),
      task = replay.read("task_surface").snapshot.task,
      edge = replay.readRelationQuery({}).rows.find((candidate) => candidate.sourceRef === "task/task_surface");
    replay.close();
    assert.equal(task?.metadata.parentTaskId, "task_dependency");
    assert.equal(task?.metadata.moduleKey, "kernel");
    assert.equal(task?.metadata.riskTier, "high");
    assert.equal(edge?.targetRef, "task/task_dependency");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task lifecycle mutations publish L1 events, exact documents, and replayable dispositions", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-lifecycle-surface-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    writeFileSync(path.join(rootDir, "README.md"), "# Task lifecycle fixture delivery\n");
    git(rootDir, "add", "README.md");
    git(rootDir, "commit", "-qm", "fixture delivery");
    const deliveryCommit = git(rootDir, "rev-parse", "HEAD");
    cell = await openRepoCell({
      repoId: workspaceId("task-lifecycle-surface"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-lifecycle-surface",
      now: () => "2026-08-15T01:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    for (const [taskId, title] of [
      ["task_lifecycle", "Lifecycle"],
      ["task_replacement", "Replacement"],
      ["task_reviewing", "Reviewing"],
    ] as const) {
      const created = await cell.run({ kind: "task-create", taskId, title, profileId: "baseline" }, binding);
      assert.equal(created.outcome, "applied");
      await waitForFixturePublication(cell, created.opId, binding);
      await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
        cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
    }
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-start",
            taskId: "task_lifecycle",
            executionId: "exe_surface",
            ttlMs: 60_000,
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
            kind: "task-release",
            taskId: "task_lifecycle",
            reason: "Pause before changing scope",
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
            taskId: "task_lifecycle",
            status: "blocked",
            reason: "Waiting on scope",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const unblocked = await cell.run({ kind: "task-transition", taskId: "task_lifecycle", status: "active" }, binding);
    assert.equal(unblocked.outcome, "applied");
    const plannedActivation = await cell.run(
      {
        kind: "task-transition",
        taskId: "task_replacement",
        status: "active",
        reason: "Bypass task start",
      },
      binding,
    );
    assert.equal(plannedActivation.outcome, "op_rejected");
    assert.equal(plannedActivation.code, "invalid_transition");
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-start",
            taskId: "task_reviewing",
            executionId: "exe_reviewing",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "harness/tasks/task_reviewing-reviewing/closeout.md"),
      `# Closeout\n\n## Summary\n\nStatus routing delivery ${deliveryCommit} is ready for review.\n\n## Verification\n\nDaemon integration assertions exercise lifecycle events and dispositions.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nAll task status routes consume the canonical projection.\n`,
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-submit",
            taskId: "task_reviewing",
            executionId: "exe_reviewing",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const submittedProgress = await cell.run(
      {
        kind: "task-progress-append",
        taskId: "task_reviewing",
        text: "Late review judgment",
        evidence: [],
      },
      binding,
    );
    assert.equal(submittedProgress.outcome, "op_rejected");
    assert.equal(submittedProgress.code, "progress_lease_required");
    const submittedRestart = await cell.run(
      {
        kind: "task-start",
        taskId: "task_reviewing",
        executionId: "exe_reviewing",
      },
      binding,
    );
    assert.equal(submittedRestart.outcome, "op_rejected");
    assert.equal(submittedRestart.code, "invalid_transition");
    const reviewActivation = await cell.run(
      {
        kind: "task-transition",
        taskId: "task_reviewing",
        status: "active",
        reason: "Bypass review outcome",
      },
      binding,
    );
    assert.equal(reviewActivation.outcome, "op_rejected");
    assert.equal(reviewActivation.code, "invalid_transition");
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-transition",
            taskId: "task_lifecycle",
            status: "done",
            reason: "bypass",
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
            kind: "task-amend",
            taskId: "task_lifecycle",
            patches: [
              { field: "title", value: "Lifecycle amended" },
              { field: "riskTier", value: "high" },
              { field: "moduleKey", value: "daemon" },
              { field: "taskClass", value: "milestone" },
            ],
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
            kind: "task-amend",
            taskId: "task_lifecycle",
            patches: [{ field: "taskClass", value: "container" }],
          },
          binding,
        )
      ).outcome,
      "op_rejected",
    );
    const related = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: "task/task_lifecycle",
        targetRef: "task/task_replacement",
        relationType: "depends-on",
        rationale: "Replacement establishes the new contract",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(related.outcome, "applied", JSON.stringify(related));
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-archive",
            taskId: "task_lifecycle",
            reason: "Scope retired",
            archivedBy: "person-surface",
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
            kind: "task-reopen",
            taskId: "task_lifecycle",
            reason: "Scope restored",
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
            kind: "task-supersede",
            oldTaskId: "task_lifecycle",
            byTaskId: "task_replacement",
            confirm: "task_lifecycle",
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
            kind: "task-delete",
            taskId: "task_replacement",
            mode: "hard",
            confirm: "task_replacement",
            reason: "destructive",
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
            kind: "task-delete",
            taskId: "task_replacement",
            mode: "soft",
            reason: "Duplicate",
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
            kind: "task-reopen",
            taskId: "task_replacement",
            reason: "Not a duplicate",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const taskRead = (await cell.run({ kind: "task-show", taskId: "task_lifecycle" }, binding)) as Record<
        string,
        unknown
      >,
      replacementRead = (await cell.run({ kind: "task-show", taskId: "task_replacement" }, binding)) as Record<
        string,
        unknown
      >;
    assert.match(String(taskRead.evidence), /"taskClass":"milestone"/u);
    assert.match(String(taskRead.evidence), /"packageDisposition":"archived"/u);
    assert.match(String(taskRead.evidence), /"supersededBy":"task_replacement"/u);
    assert.match(String(replacementRead.evidence), /"packageDisposition":"active"/u);
    const events = makeTaskEventReader({
      repoId: "task-lifecycle-surface",
      rootDir,
    })
      .read()
      .events.filter((event) => event.schema === "task-event/v1")
      .map((event) => event.type);
    for (const type of [
      "lease_released",
      "task_transitioned",
      "task_amended",
      "task_archived",
      "task_reopened",
      "task_superseded",
      "task_deleted",
    ])
      assert.ok(events.includes(type as never), `${type} missing from ${events.join(",")}`);
    assert.equal(
      makeTaskEventReader({ repoId: "task-lifecycle-surface", rootDir })
        .read()
        .events.some((event) => event.schema === "relation-event/v1" && event.type === "relation_created"),
      true,
    );
    const replay = makeTaskProjection({
        rootDir,
        eventStore: makeTaskEventReader({ repoId: "task-lifecycle-surface", rootDir }),
      }),
      lifecycle = replay.read("task_lifecycle").snapshot.task,
      replacement = replay.read("task_replacement").snapshot.task,
      edge = replay
        .readRelationQuery({})
        .rows.find((row) => row.sourceRef === "task/task_lifecycle" && row.targetRef === "task/task_replacement");
    replay.close();
    assert.equal(lifecycle?.title, "Lifecycle amended");
    assert.equal(lifecycle?.metadata.riskTier, "high");
    assert.equal(lifecycle?.metadata.moduleKey, "daemon");
    assert.equal(lifecycle?.packageDisposition, "archived");
    assert.equal(replacement?.packageDisposition, "active");
    assert.equal(edge?.relationType, "depends-on");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a lifecycle rejection bound to a declared criterion reports the guard's own reason", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-rejection-reason-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("task-rejection-reason"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "task-rejection-reason",
  });
  t.after(() => cell.close());
  await cell.run({ kind: "task-create", taskId: "task-reason", title: "Reason" }, { actor, source: "local" });
  const refused = await cell.run(
    {
      kind: "task-review-execution",
      commandType: "RecordReview",
      taskId: "task-reason",
      reviewId: "review-reason",
      jsonInput: JSON.stringify({ verdict: "approved", reason: "Looks done.", evidenceChecked: ["read"] }),
    },
    { actor, source: "local" },
  );
  assert.equal(refused.unmetCriteria?.[0]?.ref, "task-lifecycle-review-transitions/review.validate");
  assert.match(String(refused.rejectionExplanation), /Current submitted execution candidates: none/u);
  assert.notEqual(refused.rejectionExplanation, refused.unmetCriteria?.[0]?.explain);
});

test("cancellation and reinstatement are audited and terminal tasks require supersede instead of reopen", async () => {
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
    const bareCancellation = await cell.run(
      {
        kind: "task-transition",
        taskId: "task_terminal",
        status: "cancelled",
      },
      binding,
    );
    assert.equal(bareCancellation.outcome, "op_rejected");
    assert.equal(bareCancellation.code, "missing_field");
    assert.deepEqual(bareCancellation.diagnostic, {
      kind: "validation",
      entity: "task-transition",
      field: "reason",
      actual: "missing",
      expectation: "a non-empty cancellation reason",
    });
    const cancelled = await cell.run(
      {
        kind: "task-transition",
        taskId: "task_terminal",
        status: "cancelled",
        reason: "Audited cancellation after invalid scope",
      },
      binding,
    );
    assert.equal(cancelled.outcome, "applied");
    const bareReinstate = await cell.run(
      { kind: "task-transition", taskId: "task_terminal", status: "planned" },
      binding,
    );
    assert.equal(bareReinstate.outcome, "op_rejected");
    assert.equal(bareReinstate.code, "missing_field");
    const expectedVersion = cancelled.revision,
      [reinstated, staleReinstate] = await Promise.all([
        cell.run(
          {
            kind: "task-transition",
            taskId: "task_terminal",
            status: "planned",
            reason: "Owner adjudicated rollback",
            expectedVersion,
          },
          binding,
        ),
        cell.run(
          {
            kind: "task-transition",
            taskId: "task_terminal",
            status: "planned",
            reason: "Concurrent rollback",
            expectedVersion,
          },
          binding,
        ),
      ]);
    assert.equal(reinstated.outcome, "applied");
    assert.equal(staleReinstate.outcome, "op_rejected");
    assert.equal(staleReinstate.code, "invalid_transition");
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-transition",
            taskId: "task_terminal",
            status: "cancelled",
            force: true,
            reason: "Scope remains withdrawn",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const leased = await cell.run(
      {
        kind: "task-create",
        taskId: "task_leased",
        title: "Leased terminal",
        profileId: "baseline",
      },
      binding,
    );
    await waitForWorktree(cell, leased);
    await realizeTaskPlanFixture(rootDir, String(leased.packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_leased", executionId: "execution_leased" }, binding)).outcome,
      "applied",
    );
    const leasedCancellation = await cell.run(
      {
        kind: "task-transition",
        taskId: "task_leased",
        status: "cancelled",
        reason: "Cancellation requires execution confirmation",
      },
      binding,
    );
    assert.equal(leasedCancellation.outcome, "op_rejected");
    assert.equal(leasedCancellation.code, "missing_field");
    assert.deepEqual(leasedCancellation.diagnostic, {
      kind: "validation",
      entity: "task-transition",
      field: "force",
      actual: "missing",
      expectation: "--force after execution has started",
    });
    await cell.run(
      {
        kind: "task-archive",
        taskId: "task_terminal",
        reason: "Retain cancellation audit",
      },
      binding,
    );
    const reopen = await cell.run({ kind: "task-reopen", taskId: "task_terminal", reason: "More work" }, binding);
    assert.equal(reopen.outcome, "op_rejected");
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
    const hot = (await cell.read("repo.tasks.list")).rows.find((row) => row.taskId === "task_status_replay")?.snapshot;
    assert.ok(hot);
    await cell.close();
    cell = undefined;
    const store = makeTaskEventReader({ repoId: "task-status-replay", rootDir }),
      replay = makeTaskProjection({ rootDir, eventStore: store });
    assert.deepEqual(
      store
        .read()
        .events.filter((event) => event.schema === "task-event/v1")
        .map((event) => event.type),
      ["task_transitioned", "task_transitioned", "task_transitioned", "task_transitioned"],
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
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-archive-preflight-"));
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
    const before = makeTaskEventReader({
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
    assert.equal(makeTaskEventReader({ repoId: "task-archive-preflight", rootDir }).read().events.length, before);
    assert.match(
      String((await cell.run({ kind: "task-show", taskId: "task_archive_valid" }, binding)).evidence),
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
    seedSettingsEvent({ repoId: "task-contract-manual", rootDir });
    const workspaceRevision = makeTaskEventReader({ repoId: "task-contract-manual", rootDir }).read().revision + 1;
    const event: TaskEventV1 = {
      schema: "task-event/v1",
      eventId: "event-legacy",
      workspaceRevision,
      opId: "op-legacy",
      taskId: "task_legacy_l1",
      type: "task_created",
      actor,
      source: "local",
      occurredAt: "2026-08-15T02:45:00.000Z",
      payload: {
        task: {
          schema: "task/v2",
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
          pinned: false,
        },
      },
    };
    const seed = makeTaskEventStore({ repoId: "task-contract-manual", rootDir });
    seed.append({
      event,
      plan: taskLifecycleWritePlan(event),
      blobs: [],
    });
    await seed.drain();
    cell = await openRepoCell({
      repoId: workspaceId("task-contract-manual"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-contract-manual",
      now: () => "2026-08-15T02:45:00.000Z",
    });
    const revisionBeforeDryRun = makeTaskEventReader({ repoId: "task-contract-manual", rootDir }).read().revision;
    const receipt = await cell.run(
      {
        kind: "task-contract-migrate",
        mode: "dry-run",
        taskId: "task_legacy_l1",
      },
      { actor, source: "local" },
    );
    assert.equal(receipt.outcome, "pending");
    assert.equal(receipt.acceptance, null);
    assert.equal(receipt.proof, undefined);
    assert.equal(
      makeTaskEventReader({ repoId: "task-contract-manual", rootDir }).read().revision,
      revisionBeforeDryRun,
    );
    assert.match(String(receipt.evidence), /"status":"manual"[\s\S]*"reason":"contract_metadata_incomplete"/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function waitForWorktree(cell: Awaited<ReturnType<typeof openRepoCell>>, receipt: { readonly opId: string }) {
  const shown = await cell.run(
    {
      kind: "receipt-show",
      opId: receipt.opId,
      waitFor: ["accepted_durable", "projection_visible", "git_verified", "worktree_visible"],
      timeoutMs: 5_000,
    },
    { actor, source: "local" },
  );
  assert.equal(shown.status, "accepted_durable", JSON.stringify(shown));
  assert.equal(shown.wait?.state, "satisfied", JSON.stringify(shown));
  return shown;
}
