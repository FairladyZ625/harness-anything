import { describe, expect, it } from "vitest";
import { REPLAY_TASK_GRAPH } from "../../kernel/src/index.ts";
import type { TaskSnapshotProjectionRow } from "../src/api/renderer-dto.ts";
import { adaptProjectionRows, computeRootTaskId } from "../src/renderer/task-adapter.ts";

function row(overrides: Partial<TaskSnapshotProjectionRow> = {}): TaskSnapshotProjectionRow {
  const taskId = overrides.taskId ?? "task-x";
  return {
    taskId,
    workspaceRevision: 1,
    createdAt: "2026-08-11T23:59:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    snapshot: {
      revision: 1,
      task: {
        schema: "task/v1",
        taskId,
        title: "X",
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: { principal: { personId: "person-owner" }, executor: null },
        completionGateIds: [],
        presetSnapshotDigest: null,
        metadata: {
          idempotencyKey: null,
          parentTaskId: null,
          workKind: "feat",
          riskTier: "high",
          urgency: "medium",
          verticalId: "software-coding",
          presetId: "gui-task",
          profileId: "default",
          moduleKey: "gui",
          slug: "x",
          surfaces: ["packages/gui"],
          fromLegacyId: null,
        },
      },
      executions: [],
      reviews: [],
      consents: [],
      codeDocWitnesses: [],
      gateWitnesses: [],
      edgesTaken: [],
      lease: null,
    },
    packagePath: `tasks/${taskId}-x`,
    coordinationStatus: "planned",
    snapshotAvailability: { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" },
    closeoutAssessment: { readiness: "not_required", gates: [] },
    blockingAssessment: { taskId, state: "clear", blockers: [], warnings: [] },
    placement: {
      moduleKeys: ["gui"],
      productLines: ["harness"],
      spawningDecisionIds: [],
      parentTaskId: null,
      origin: "native",
      engine: "kernel/task-lifecycle/v1",
      packageDisposition: "active",
      provenance: [{ kind: "l2", ref: `tasks/${taskId}-x/INDEX.md` }],
    },
    executionEvidence: [],
    ...overrides,
  };
}

describe("computeRootTaskId", () => {
  it("walks a parent chain and terminates cycles", () => {
    expect(
      computeRootTaskId(
        "child",
        new Map([
          ["child", "root"],
          ["root", undefined],
        ]),
      ),
    ).toBe("root");
    expect(
      computeRootTaskId(
        "left",
        new Map([
          ["left", "right"],
          ["right", "left"],
        ]),
      ),
    ).toBe("left");
  });
});

describe("adaptProjectionRows", () => {
  it("derives renderer state from the canonical lifecycle snapshot", () => {
    const [task] = adaptProjectionRows([row()], "repo-test");
    expect(task).toMatchObject({
      taskId: "task-x",
      title: "X",
      coordinationStatus: "planned",
      rawStatus: "planned/implementation",
      canonicalStatus: "planned",
      blocking: "clear",
      blockingLabel: "当前投影无 active blocking relation",
      freshness: "fresh",
      createdAt: "2026-08-11T23:59:00.000Z",
      rootTaskId: "task-x",
      rootTitle: "X",
      module: "gui",
      moduleKeys: ["gui"],
      productLines: ["harness"],
      origin: "native",
      engine: "kernel/task-lifecycle/v1",
      taskClass: "standard",
      workKind: "feat",
      riskTier: "high",
      urgency: "medium",
      vertical: "software-coding",
      preset: "gui-task",
      profile: "default",
      createdBy: "person-owner",
    });
  });

  it("marks a pending projection stale but usable", () => {
    expect(adaptProjectionRows([row()], "repo-test", "pending")[0]?.freshness).toBe("stale-but-usable");
  });

  it("preserves readonly projection arrays instead of copying them at the renderer boundary", () => {
    const input = row({
      blockingAssessment: {
        taskId: "task-x",
        state: "blocked",
        blockers: [
          { relationId: "rel_0000000000000001", kind: "depends-on", sourceTaskId: "task-x", targetTaskId: "task-y" },
        ],
        warnings: ["cycle detected"],
      },
      placement: {
        ...row().placement,
        moduleKeys: ["gui"],
        productLines: ["desktop"],
        spawningDecisionIds: ["dec-source"],
      },
    });
    const [task] = adaptProjectionRows([input], "repo-test");

    expect(task?.blockers).toBe(input.blockingAssessment.blockers);
    expect(task?.blockingWarnings).toBe(input.blockingAssessment.warnings);
    expect(task?.moduleKeys).toBe(input.placement.moduleKeys);
    expect(task?.productLines).toBe(input.placement.productLines);
    expect(task?.spawningDecisionIds).toBe(input.placement.spawningDecisionIds);
  });

  it("passes execution outputs and receipts through untouched for the closeout tab (W5)", () => {
    const execution = {
      schema: "execution/v1" as const,
      executionId: "execution-x",
      taskId: "task-x",
      nodeId: "implementation" as const,
      iteration: 0 as const,
      state: "submitted" as const,
      actor: { principal: { personId: "person-owner" }, executor: null },
      claimedAt: "2026-08-12T00:00:00.000Z",
      submittedAt: "2026-08-12T00:01:00.000Z",
      closedAt: null,
      submission: {
        completionClaim: "done",
        deliverables: [],
        outputs: ["artifacts/r.txt"],
        verificationNotes: [],
        knownGaps: [],
        residualRisks: [],
        commitSha: "f".repeat(40),
      },
    };
    const evidence = [
      {
        executionId: "execution-x",
        origin: "native" as const,
        outputs: [
          {
            evidenceId: "evidence_x",
            locator: "artifacts/r.txt",
            substrate: "repository-path" as const,
            checkerReceiptRef: "receipt-x",
            checkerResult: "pass" as const,
          },
        ],
      },
    ];
    const [task] = adaptProjectionRows(
      [row({ snapshot: { ...row().snapshot, executions: [execution] }, executionEvidence: evidence })],
      "repo-test",
    );
    expect(task?.executions).toEqual([execution]);
    expect(task?.executionEvidence).toEqual(evidence);
  });

  it("renders authoritative closeout and blocking assessments without relation recomputation", () => {
    const input = row({
      taskId: "task-a",
      coordinationStatus: "blocked",
      closeoutAssessment: {
        readiness: "failed",
        executionId: "exe-a",
        blocker: "gate",
        gates: [{ gateId: "ci", status: "failed", detail: "current cut failed" }],
      },
      blockingAssessment: {
        taskId: "task-a",
        state: "blocked",
        blockers: [
          { relationId: "rel_0000000000000001", kind: "depends-on", sourceTaskId: "task-a", targetTaskId: "task-b" },
        ],
        warnings: [],
      },
    });
    const [task] = adaptProjectionRows([input], "repo-test", "ready");
    expect(task).toMatchObject({
      coordinationStatus: "blocked",
      blocking: "blocked",
      closeoutReadiness: "failed",
      gates: [{ name: "ci", ok: false, detail: "current cut failed" }],
      blockers: [{ sourceTaskId: "task-a", targetTaskId: "task-b" }],
    });
  });

  it("carries daemon-derived placement through, including every spawning decision id", () => {
    const parent = row({
      taskId: "task-parent",
      placement: { ...row().placement, moduleKeys: ["kernel"], productLines: ["platform"] },
    });
    const child = row({
      taskId: "task-child",
      placement: {
        ...row().placement,
        moduleKeys: ["gui"],
        productLines: ["desktop"],
        spawningDecisionIds: ["dec-scope"],
        parentTaskId: "task-parent",
      },
    });
    const tasks = adaptProjectionRows([parent, child], "repo-test", "ready");

    expect(tasks.find((task) => task.taskId === "task-child")).toMatchObject({
      module: "gui",
      moduleKeys: ["gui"],
      productLines: ["desktop"],
      parentTaskId: "task-parent",
      rootTaskId: "task-parent",
      rootTitle: "X",
      spawningDecisionIds: ["dec-scope"],
      spawningDecision: "dec-scope",
    });
    expect(tasks.find((task) => task.taskId === "task-parent")).toMatchObject({
      module: "kernel",
      productLines: ["platform"],
    });
  });

  it("keeps every spawning decision id when a task has more than one source decision", () => {
    const [task] = adaptProjectionRows(
      [row({ taskId: "task-multi", placement: { ...row().placement, spawningDecisionIds: ["dec-a", "dec-b"] } })],
      "repo-test",
    );
    expect(task?.spawningDecisionIds).toEqual(["dec-a", "dec-b"]);
    // 来源不唯一时不冒充单一 spawning decision,只给显式的合并提示。
    expect(task?.spawningDecision).toBeUndefined();
    expect(task?.placementWarning).toContain("多个 spawning decision");
  });
});
