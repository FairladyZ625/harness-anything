import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskProjectionRow } from "../../kernel/src/index.ts";
import type { DecisionRow, TaskRow } from "../src/renderer/model/types.ts";
import {
  buildGuiViewModelFromTaskProjection,
  readGuiTaskDetailResult,
  readGuiTaskDocumentResult,
  readGuiTaskListResult,
  toGuiCommandFeedback
} from "../src/api/view-model.ts";
import { rendererCapabilityModel, rendererNavigation } from "../src/renderer/app-model.ts";
import { GraphView } from "../src/renderer/views/GraphView.tsx";
import { DecisionPoolView } from "../src/renderer/views/DecisionPoolView.tsx";
import { TaskDetailView } from "../src/renderer/views/TaskDetailView.tsx";
import { parseTaskContractDocuments, taskDocumentQuery } from "../src/renderer/task-data.ts";
import { isTaskStartable, settleTaskReceipt } from "../src/renderer/task-actions.ts";

describe("renderer app model", () => {
  it("keeps the renderer capability model privilege-free", () => {
    expect(rendererCapabilityModel).toEqual({
      nodeGlobalsAvailable: false,
      privilegedModulesAvailable: false,
      receivesOnlyPreloadData: true
    });
  });

  it("keeps primary navigation stable for Vite renderer code", () => {
    expect(rendererNavigation.map((item) => item.id)).toEqual([
      "workspace",
      "board",
      "list",
      "detail",
      "doc-viewer",
      "review-queue",
      "graph"
    ]);
  });

  it("builds task shell views from sqlite-task-row/v1 fields only", () => {
    const rows = [
      taskRow({ taskId: "task-child", title: "Child", parentTaskId: "task-parent", coordinationStatus: "blocked" }),
      taskRow({ taskId: "task-parent", title: "Parent", closeoutReadiness: "ready" }),
      taskRow({ taskId: "task-archived", title: "Archived", packageDisposition: "archived" })
    ];

    const model = buildGuiViewModelFromTaskProjection(rows);

    expect(model.list.map((row) => row.taskId)).toEqual(["task-child", "task-parent"]);
    expect(model.board.find((column) => column.id === "blocked")?.taskIds).toEqual(["task-child"]);
    expect(model.reviewQueue.map((row) => row.taskId)).toEqual(["task-parent"]);
    expect(model.graph.nodes).toEqual([
      { id: "task-child", title: "Child" },
      { id: "task-parent", title: "Parent" }
    ]);
    expect(model.graph.edges).toEqual([
      { from: "task-parent", to: "task-child", kind: "child" }
    ]);
  });

  it("reads task route results defensively without depending on optional route fields", () => {
    const list = readGuiTaskListResult({
      ok: true,
      tasks: [
        taskRow({ taskId: "task-1", title: "One" }),
        taskRow({ taskId: "task-archived", title: "Archived", packageDisposition: "archived" })
      ]
    });
    const detail = readGuiTaskDetailResult({
      ok: true,
      task: taskRow({ taskId: "task-1", title: "One" }),
      documents: [{ path: "INDEX.md" }, { label: "ignored" }]
    });
    const document = readGuiTaskDocumentResult({ ok: true, taskId: "task-1", path: "INDEX.md" });
    const invalid = readGuiTaskListResult({ ok: true, tasks: [{ taskId: "task-1", title: "One" }] });

    expect(list).toMatchObject({ ok: true, warnings: [] });
    expect(list.ok && list.rows[0]).toMatchObject({ taskId: "task-1", title: "One" });
    expect(list.ok && list.rows.map((row) => row.taskId)).toEqual(["task-1"]);
    expect(detail.ok && detail.documents).toEqual([{ path: "INDEX.md" }]);
    expect(document).toEqual({ ok: true, taskId: "task-1", path: "INDEX.md", body: "" });
    expect(invalid).toEqual({
      ok: false,
      error: {
        code: "invalid_task_projection_row",
        hint: "Expected sqlite-task-row/v1 task projection row."
      }
    });
  });

  it("normalizes command feedback from lean local results and rich command receipts", () => {
    expect(toGuiCommandFeedback({ ok: true })).toEqual({
      ok: true,
      summary: "Command completed.",
      warnings: []
    });
    expect(toGuiCommandFeedback({
      ok: false,
      error: { code: "task_not_found", hint: "missing" }
    })).toEqual({
      ok: false,
      summary: "Command failed.",
      errorCode: "task_not_found",
      hint: "missing",
      warnings: []
    });
    expect(toGuiCommandFeedback({
      ok: true,
      schema: "command-receipt/v2",
      command: "ha task progress append",
      action: "progress append",
      summary: "appended progress",
      paths: [{ role: "progress", path: "progress.md" }],
      next: [{ command: "ha task show task-1" }],
      meta: {
        generatedAt: "2026-07-07T00:00:00.000Z",
        compatibility: {}
      }
    })).toEqual({
      ok: true,
      summary: "appended progress",
      warnings: []
    });
    expect(toGuiCommandFeedback({
      ok: false,
      schema: "command-receipt/v2",
      command: "ha task status set",
      action: "status set",
      summary: "failed",
      error: { code: "invalid_status", hint: "bad status" },
      warnings: ["ignored by default display"],
      meta: {
        generatedAt: "2026-07-07T00:00:00.000Z",
        compatibility: {}
      }
    })).toEqual({
      ok: false,
      summary: "failed",
      errorCode: "invalid_status",
      hint: "bad status",
      warnings: ["ignored by default display"]
    });
  });

  it("settles task writes only from durable canonical receipts and resolves pending by opId", async () => {
    const showReceipt = vi.fn(async () => receipt({ outcome: "applied", opId: "op-pending" }));
    const settled = await settleTaskReceipt(receipt({ outcome: "pending", opId: "op-pending", proof: {
      committedRevision: 8, appliedCut: 7, durable: true, canonicalVisible: false, worktreeVisible: true
    }, nextAction: "ha receipt show op-pending" }), showReceipt);

    expect(showReceipt).toHaveBeenCalledOnce();
    expect(showReceipt).toHaveBeenCalledWith({ opId: "op-pending" });
    expect(settled).toMatchObject({ state: "applied", opId: "op-pending" });
    expect(await settleTaskReceipt(receipt({ proof: {
      committedRevision: 8, appliedCut: 8, durable: true, canonicalVisible: false, worktreeVisible: true
    } }), showReceipt)).toMatchObject({ state: "pending", code: "canonical_not_visible" });
  });

  it("preserves raw rejection code, hint, and opId", async () => {
    const settled = await settleTaskReceipt({
      schema: "command-receipt/v2", ok: false, command: "task-submit", outcome: "rejected", opId: "op-rejected",
      code: "invalid_submission", origin: "daemon", evidence: "rejection:invalid_submission", nextAction: "Fix the packet.",
      error: { code: "invalid_submission", hint: "Completion claim is required." }
    }, vi.fn());
    expect(settled).toMatchObject({ state: "rejected", opId: "op-rejected", code: "invalid_submission", hint: "Completion claim is required." });
  });

  it("allows drag start only for native planned clear active packages", () => {
    const planned: TaskRow = { taskId: "task-1", title: "One", projectId: "p", coordinationStatus: "planned", canonicalStatus: "planned",
      blocking: "clear", rawStatus: "planned/implementation", freshness: "fresh", packageDisposition: "active", closeoutReadiness: "not_required",
      engine: "kernel/task-lifecycle/v1", origin: "native", source: "local-document", module: "gui", lastKnownAt: "2026-08-14T00:00:00.000Z", gates: [], docs: [] };
    expect(isTaskStartable(planned)).toBe(true);
    expect(isTaskStartable({ ...planned, blocking: "blocked", coordinationStatus: "blocked" })).toBe(false);
    expect(isTaskStartable({ ...planned, origin: "external" })).toBe(false);
    expect(isTaskStartable({ ...planned, canonicalStatus: "active", coordinationStatus: "active" })).toBe(false);
  });

  it("renders an explicit empty state when the triadic ledger has no entities", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, { tasks: [], decisions: [], facts: [], relations: [] })
    );

    expect(markup).toContain("triadic-graph-empty-state");
    expect(markup).toContain("暂无三元语关系数据");
  });

  it("renders the daemon L2 document body and status through the renderer query", async () => {
    const contract = JSON.stringify({ schema: "task-contract/v1", taskId: "task-1", documents: [
      { slot: "task.index", path: "INDEX.md", owner: "machine", materializeAs: "INDEX.md", requiredAnchors: [], templateRef: null, contentSha256: null }
    ] });
    const getTaskDocument = vi.fn(async ({ path }: { path: string }) => ({ ok: true, status: "ready", taskId: "task-1", path,
      body: path === "task-contract.json" ? contract : "# Canonical renderer document", blobSha256: "sha256:canonical", watermark: 7, sourceRevision: 7 }));
    vi.stubGlobal("window", { harness: { getTaskDocument } });
    const queryClient = new QueryClient();
    try {
      await queryClient.fetchQuery(taskDocumentQuery("task-1", "task-contract.json"));
      await queryClient.fetchQuery(taskDocumentQuery("task-1", "INDEX.md"));
      const task: TaskRow = { taskId: "task-1", title: "One", projectId: "project-1", coordinationStatus: "active", rawStatus: "active",
        freshness: "fresh", packageDisposition: "active", closeoutReadiness: "not_required", engine: "local", source: "snapshot-cache",
        module: "gui", packagePath: "tasks/task-1-one", lastKnownAt: "2026-08-13T00:00:00.000Z", gates: [], docs: [] };
      const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement(TaskDetailView,
        { task, onBack: () => undefined, projectName: "Harness" })));
      expect(getTaskDocument).toHaveBeenCalledWith({ taskId: "task-1", path: "task-contract.json" });
      expect(getTaskDocument).toHaveBeenCalledWith({ taskId: "task-1", path: "INDEX.md" });
      expect(markup).toContain("Canonical renderer document");
      expect(markup).toContain("L2 · ready");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("parses canonical task-contract descriptors without inventing document presence", () => {
    expect(parseTaskContractDocuments("task-1", JSON.stringify({ schema: "task-contract/v1", taskId: "task-1", documents: [
      { slot: "task.plan", path: "task_plan.md", owner: "doc-sync", materializeAs: "task_plan.md", requiredAnchors: [], templateRef: "template://plan@1", contentSha256: "abc" },
      { slot: "task.artifacts.keep", path: "artifacts/.gitkeep", owner: "doc-sync", materializeAs: "artifacts/.gitkeep", requiredAnchors: [], templateRef: null, contentSha256: "def" }
    ] }))).toEqual([
      expect.objectContaining({ path: "task_plan.md", group: "计划", required: true, presence: "unknown" }),
      expect.objectContaining({ path: "artifacts/.gitkeep", group: "证据", required: false, presence: "unknown" })
    ]);
    expect(() => parseTaskContractDocuments("task-1", JSON.stringify({ schema: "task-contract/v1", taskId: "other", documents: [] }))).toThrow("task-contract");
  });

  it("renders explicit active lease forms and read-only blocking explanations", () => {
    const active: TaskRow = { taskId: "task-active", title: "Active", projectId: "p", coordinationStatus: "active", canonicalStatus: "active", blocking: "clear",
      blockingLabel: "当前投影无 active blocking relation", rawStatus: "active/implementation", freshness: "fresh", packageDisposition: "active", closeoutReadiness: "not_required",
      engine: "kernel/task-lifecycle/v1", origin: "native", source: "local-document", module: "gui", lastKnownAt: "2026-08-14T00:00:00.000Z", activeExecutionId: "execution-gui-1", gates: [], docs: [] };
    const activeMarkup = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TaskDetailView,
      { task: active, onBack: () => undefined, projectName: "Harness" })));
    expect(activeMarkup).toContain("追加 progress"); expect(activeMarkup).toContain("atomic SubmissionV1"); expect(activeMarkup).toContain("execution-gui-1");

    const blockedMarkup = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TaskDetailView,
      { task: { ...active, canonicalStatus: "planned", coordinationStatus: "blocked", blocking: "blocked", blockingLabel: "1 个 active blocking relation", activeExecutionId: undefined,
        blockers: [{ relationId: "rel_1", kind: "blocks", sourceTaskId: "task-upstream", targetTaskId: "task-active", rationale: "wait" }] }, onBack: () => undefined, projectName: "Harness" })));
    expect(blockedMarkup).toContain("Blocked 是 relation overlay"); expect(blockedMarkup).toContain("rel_1"); expect(blockedMarkup).not.toContain("解除");
  });

  it("keeps the selected decision card visible and focused under all filters", () => {
    const decision: DecisionRow = {
      decisionId: "dec_gui_smoke",
      title: "Ship the GUI read surface",
      state: "proposed",
      riskTier: "high",
      urgency: "high",
      proposedBy: { kind: "agent", id: "codex" },
      question: "Should the GUI use daemon projections?",
      chosen: [],
      rejected: [],
      claims: []
    };
    const markup = renderToStaticMarkup(createElement(DecisionPoolView, {
      decisions: [decision],
      facts: [],
      relations: [],
      focusedDecisionId: decision.decisionId
    }));

    expect(markup).toContain('id="decision-card-dec_gui_smoke"');
    expect(markup).toContain('data-focused="true"');
  });
});

function taskRow(overrides: Partial<TaskProjectionRow>): TaskProjectionRow {
  return {
    schema: "sqlite-task-row/v1",
    taskId: "task-default",
    title: "Default",
    canonicalStatus: "planned",
    coordinationStatus: "open",
    rawStatus: "planned",
    packageDisposition: "active",
    closeoutReadiness: "not-ready",
    lifecycleEngine: "local",
    freshness: "fresh",
    updatedAt: "2026-07-07T00:00:00.000Z",
    source: "local-document",
    sourcePath: "harness/tasks/task-default/INDEX.md",
    ...overrides
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema: "command-receipt/v2", ok: true, command: "task-start", outcome: "applied", opId: "op-applied", revision: 8,
    evidence: "event-object:op-applied", visibility: "center", proof: { committedRevision: 8, appliedCut: 8, durable: true, canonicalVisible: true, worktreeVisible: true },
    ...overrides
  };
}
