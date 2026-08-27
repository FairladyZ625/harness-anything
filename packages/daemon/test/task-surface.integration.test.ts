// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventStore,
  readRelationGraphProjection,
  readTaskProjection,
  rebuildTaskProjection,
} from "../../kernel/src/index.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

import { actor, git, initRepo } from "./task-surface.fixtures.ts";
test("task create publishes complete metadata and initial relations that survive cold rebuild", async () => {
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
        relations: [
          {
            type: "depends-on",
            target: "task/task_dependency",
            rationale: "Dependency must land first",
          },
        ],
        locale: "zh-CN",
      },
      binding,
    )) as Record<string, unknown>;
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assert.equal(created.packagePath, "tasks/task_surface-surface");
    const event = makeTaskEventStore({ repoId: "task-surface", rootDir })
      .read()
      .events.find(
        (candidate) =>
          candidate.schema === "task-bootstrap-event/v1" &&
          candidate.taskId === "task_surface",
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
    assert.equal(event.payload.task.relations?.[0]?.type, "depends-on");
    const index = readFileSync(
        path.join(rootDir, "harness/tasks/task_surface-surface/INDEX.md"),
        "utf8",
      ),
      contract = JSON.parse(
        readFileSync(
          path.join(
            rootDir,
            "harness/tasks/task_surface-surface/task-contract.json",
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
    assert.match(
      index,
      /schema: task-package\/v2[\s\S]*task_id: task_surface[\s\S]*parent: task_dependency[\s\S]*packageDisposition: active[\s\S]*relations:[\s\S]*depends-on/u,
    );
    assert.equal(
      (contract.metadata as { moduleKey: string }).moduleKey,
      "kernel",
    );
    rebuildTaskProjection({ rootDir });
    const row = readTaskProjection({ rootDir }).rows.find(
        (candidate) => candidate.taskId === "task_surface",
      ),
      edge = readRelationGraphProjection({ rootDir }).edges.find(
        (candidate) => candidate.sourceRef === "task/task_surface",
      );
    assert.equal(row?.parentTaskId, "task_dependency");
    assert.equal(row?.moduleKey, "kernel");
    assert.equal(row?.riskTier, "high");
    assert.equal(edge?.targetRef, "task/task_dependency");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task lifecycle mutations publish L1 events, exact documents, and replayable dispositions", async () => {
  const rootDir = mkdtempSync(
    path.join(tmpdir(), "ha-task-lifecycle-surface-"),
  );
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
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
    ] as const)
      assert.equal(
        (
          await cell.run(
            { kind: "task-create", taskId, title, profileId: "baseline" },
            binding,
          )
        ).outcome,
        "applied",
      );
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
    const unblocked = await cell.run(
      { kind: "task-transition", taskId: "task_lifecycle", status: "active" },
      binding,
    );
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
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-submit",
            taskId: "task_reviewing",
            executionId: "exe_reviewing",
            submission: {
              completionClaim: "Status routing is ready for review.",
              deliverables: ["aggregate status route"],
              outputs: ["task lifecycle event"],
              verificationNotes: ["daemon integration"],
              knownGaps: [],
              residualRisks: [],
              commitSha: git(rootDir, "rev-parse", "HEAD"),
            },
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
    assert.match(
      String(submittedProgress.nextAction),
      /progress append has no recovery in this state/u,
    );
    assert.doesNotMatch(String(submittedProgress.nextAction), /ha task start/u);
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
        kind: "task-relate",
        taskId: "task_lifecycle",
        target: "task/task_replacement",
        relationType: "depends-on",
        rationale: "Replacement establishes the new contract",
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
    const taskRead = (await cell.run(
        { kind: "task-show", taskId: "task_lifecycle" },
        binding,
      )) as Record<string, unknown>,
      replacementRead = (await cell.run(
        { kind: "task-show", taskId: "task_replacement" },
        binding,
      )) as Record<string, unknown>;
    assert.match(String(taskRead.evidence), /"taskClass":"milestone"/u);
    assert.match(String(taskRead.evidence), /"packageDisposition":"archived"/u);
    assert.match(
      String(taskRead.evidence),
      /"supersededBy":"task_replacement"/u,
    );
    assert.match(
      String(replacementRead.evidence),
      /"packageDisposition":"active"/u,
    );
    const events = makeTaskEventStore({
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
      "task_relation_added",
      "task_archived",
      "task_reopened",
      "task_superseded",
      "task_deleted",
    ])
      assert.ok(
        events.includes(type as never),
        `${type} missing from ${events.join(",")}`,
      );
    rebuildTaskProjection({ rootDir });
    const rows = readTaskProjection({ rootDir }).rows,
      lifecycle = rows.find((row) => row.taskId === "task_lifecycle"),
      replacement = rows.find((row) => row.taskId === "task_replacement"),
      edge = readRelationGraphProjection({ rootDir }).edges.find(
        (row) =>
          row.sourceRef === "task/task_lifecycle" &&
          row.targetRef === "task/task_replacement",
      );
    assert.equal(lifecycle?.title, "Lifecycle amended");
    assert.equal(lifecycle?.riskTier, "high");
    assert.equal(lifecycle?.moduleKey, "daemon");
    assert.equal(lifecycle?.packageDisposition, "archived");
    assert.equal(replacement?.packageDisposition, "active");
    assert.equal(edge?.relationType, "depends-on");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
