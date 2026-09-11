import { describe, expect, it } from "vitest";
import { REPLAY_TASK_GRAPH, taskCompletionNext } from "../../kernel/src/index.ts";
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
        schema: "task/v2",
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
        pinned: false,
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
    blockingAssessment: { taskId, state: "clear", label: "none", blockers: [], warnings: [] },
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
    board: { columnId: "open", rank: 3 },
    visibility: { archived: false, noise: false },
    capabilities: [{ id: "start", available: true, reason: null }],
    risk: { flagged: false },
    phase: { index: 0, reason: null, steps: ["planned", "active", "in_review", "done"] },
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
      blockingLabel: "none",
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

  it("preserves done status independently from the review graph cursor", () => {
    const complete = row({
      coordinationStatus: "done",
      snapshot: {
        ...row().snapshot,
        task: { ...row().snapshot.task!, status: "done", currentNode: "review" },
      },
    });
    const [task] = adaptProjectionRows([complete], "repo-test");
    expect(task).toMatchObject({ canonicalStatus: "done", currentNode: "review", rawStatus: "done/review" });
  });

  it("surfaces the lease holder and the ledger pin on the row itself", () => {
    const leased = row({
      snapshot: {
        ...row().snapshot,
        lease: {
          schema: "lease/v1",
          taskId: "task-x",
          executionId: "execution-holder",
          actor: { principal: { personId: "person-zeyu" }, executor: { kind: "agent", id: "codex-sol" } },
          source: { channel: "gui" },
          phase: "held",
          expiresAt: "2026-08-30T01:00:00.000Z",
          ttlMs: 900_000,
          version: 1,
        },
        task: { ...row().snapshot.task!, pinned: true },
      },
    });
    const [task] = adaptProjectionRows([leased], "repo-test");
    expect(task).toMatchObject({
      activeExecutionId: "execution-holder",
      leaseHolder: "person-zeyu · codex-sol",
      leasePhase: "held",
      leaseExpiresAt: "2026-08-30T01:00:00.000Z",
      pinned: true,
    });
    expect(adaptProjectionRows([row()], "repo-test")[0]?.pinned).toBeUndefined();
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
        gates: [{ gateId: "ci", status: "failed", ok: false, detail: "current cut failed" }],
      },
      blockingAssessment: {
        taskId: "task-a",
        state: "blocked",
        label: "relations",
        blockers: [
          { relationId: "rel_0000000000000001", kind: "depends-on", sourceTaskId: "task-a", targetTaskId: "task-b" },
        ],
        warnings: [],
      },
      risk: { flagged: true },
      phase: { index: null, reason: "blocked_overlay", steps: ["planned", "active", "in_review", "done"] },
    });
    const [task] = adaptProjectionRows([input], "repo-test", "ready");
    expect(task).toMatchObject({
      coordinationStatus: "blocked",
      blocking: "blocked",
      blockingLabel: "relations",
      closeoutReadiness: "failed",
      gates: [{ name: "ci", ok: false, detail: "current cut failed" }],
      blockers: [{ sourceTaskId: "task-a", targetTaskId: "task-b" }],
      risk: { flagged: true },
      phase: { index: null, reason: "blocked_overlay", steps: ["planned", "active", "in_review", "done"] },
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
    // 来源不唯一时仍显式给出合并提示,徽章交给 spawningDecisionBadge 判定(无徽章)。
    expect(task?.placementWarning).toContain("多个 spawning decision");
  });
});

/**
 * 行级引用保持(W9):`joinLedgerCut` 对未变化的行保留上游行对象引用,adapter
 * 的输出必须兑现同一不变量——未变行复用上一份 TaskRow(下游 memo 的比较键),
 * 变行换新引用;root 派生仍随整份 parent/title 表走(标题或 parent 变了,
 * 受影响行的 rootTaskId/rootTitle 必须换新对象)。行序与字段语义不变。
 */
describe("adaptProjectionRows reference stability (W9)", () => {
  it("reuses the previous output array when the input array reference is unchanged", () => {
    const rows = [row({ taskId: "task-a" }), row({ taskId: "task-b" })];
    const first = adaptProjectionRows(rows, "repo-test");
    expect(adaptProjectionRows(rows, "repo-test")).toBe(first);
  });

  it("keeps TaskRow identity for unchanged rows and swaps only the changed row", () => {
    const before = [row({ taskId: "task-a" }), row({ taskId: "task-b" }), row({ taskId: "task-c" })];
    const first = adaptProjectionRows(before, "repo-test");

    // 增量页语义:只有 task-b 换了新行对象,其余行引用保持。
    const changed = row({ taskId: "task-b", updatedAt: "2026-08-12T01:00:00.000Z" });
    const after = adaptProjectionRows([before[0]!, changed, before[2]!], "repo-test");

    expect(after.length).toBe(3);
    expect(after[0]).toBe(first[0]);
    expect(after[2]).toBe(first[2]);
    expect(after[1]).not.toBe(first[1]);
    expect(after[1]?.lastKnownAt).toBe("2026-08-12T01:00:00.000Z");
    // 行序随输入(taskId 升序)保持。
    expect(after.map((task) => task.taskId)).toEqual(["task-a", "task-b", "task-c"]);
  });

  it("returns the previous output array when a new array carries the same row references", () => {
    const rows = [row({ taskId: "task-a" }), row({ taskId: "task-b" })];
    const first = adaptProjectionRows(rows, "repo-test");
    expect(adaptProjectionRows([...rows], "repo-test")).toBe(first);
  });

  it("re-derives rootTaskId/rootTitle when an ancestor's parent or title changes", () => {
    const root = row({ taskId: "task-root", updatedAt: "2026-08-12T00:00:00.000Z" });
    const child = row({
      taskId: "task-child",
      placement: { ...row().placement, parentTaskId: "task-root" },
    });
    const first = adaptProjectionRows([root, child], "repo-test");
    expect(first[1]).toMatchObject({ rootTaskId: "task-root", rootTitle: "X" });

    // 根标题变化:child 的行引用未变,但 rootTitle 派生变了,必须换新对象。
    const retitledRoot = row({
      taskId: "task-root",
      updatedAt: "2026-08-12T01:00:00.000Z",
      snapshot: { ...root.snapshot, task: { ...root.snapshot.task!, title: "Retitled" } },
    });
    const afterRetitle = adaptProjectionRows([retitledRoot, child], "repo-test");
    expect(afterRetitle[1]).not.toBe(first[1]);
    expect(afterRetitle[1]).toMatchObject({ rootTaskId: "task-root", rootTitle: "Retitled" });

    // parent 变化:child 改挂新根,rootTaskId 派生跟着走。
    const regraftedChild = row({
      taskId: "task-child",
      placement: { ...row().placement, parentTaskId: "task-other" },
    });
    const afterRegraft = adaptProjectionRows([retitledRoot, regraftedChild], "repo-test");
    // task-other 不在集合里,链断在自身:child 以自己为根(computeRootTaskId 语义)。
    expect(afterRegraft[1]?.rootTaskId).toBe("task-child");
    expect(afterRegraft[1]?.rootTitle).toBe("X");
  });

  it("rebuilds fully when projectId or projectionStatus changes", () => {
    const rows = [row({ taskId: "task-a" })];
    const first = adaptProjectionRows(rows, "repo-one");
    const otherProject = adaptProjectionRows(rows, "repo-two");
    expect(otherProject).not.toBe(first);
    expect(otherProject[0]?.projectId).toBe("repo-two");

    const pending = adaptProjectionRows(rows, "repo-two", "pending");
    expect(pending[0]?.freshness).toBe("stale-but-usable");
    const backToReady = adaptProjectionRows(rows, "repo-two", "ready");
    expect(backToReady[0]?.freshness).toBe("fresh");
  });

  it("produces value-equal output regardless of cache hits (no semantic drift)", () => {
    const build = () => [
      row({ taskId: "task-a" }),
      row({ taskId: "task-child", placement: { ...row().placement, parentTaskId: "task-a" } }),
    ];
    // 两份内容相同但引用不同的输入:命中缓存与否,输出逐字段一致。
    const first = adaptProjectionRows(build(), "repo-fresh");
    const second = adaptProjectionRows(build(), "repo-fresh");
    expect(second).toEqual(first);
  });
});

it("preserves the center completion next without renderer interpretation", () => {
  const input = row(),
    next = taskCompletionNext(input.snapshot, {
      closeout: "ready",
      closeoutPath: "tasks/task-x/closeout.md",
      eligibleDirtyPaths: [],
      producesFactCount: 1,
    }).next;
  const [task] = adaptProjectionRows([{ ...input, completionNext: next }], "repo-test");
  expect(task?.completionNext).toBe(next);
});
