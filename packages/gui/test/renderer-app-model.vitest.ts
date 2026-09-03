import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DecisionRow, TaskRow } from "../src/renderer/model/types.ts";
import { taskCan } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { rendererCapabilityModel, rendererNavigation } from "../src/renderer/app-model.ts";
import { GraphView } from "../src/renderer/views/GraphView.tsx";
import { PhaseSteps } from "../src/renderer/components/taskDetail/PhaseSteps.tsx";
import { DecisionPoolView } from "../src/renderer/views/DecisionPoolView.tsx";
import { TaskDetailView } from "../src/renderer/views/TaskDetailView.tsx";
import { TaskCloseoutTab } from "../src/renderer/components/taskDetail/TaskDetailSections.tsx";
import { DecisionJudgmentPanel } from "../src/renderer/components/DecisionJudgmentPanel.tsx";
import { DecisionProposalForm } from "../src/renderer/components/DecisionProposalForm.tsx";
import { taskDocumentQuery } from "../src/renderer/task-data.ts";
import { settleTaskReceipt } from "../src/renderer/task-actions.ts";
import { decisionHasReachableEvidence, settleDecisionReceipt } from "../src/renderer/decision-actions.ts";
import { buildTriadicRendererData } from "../src/renderer/triadic-data.ts";

describe("renderer app model", () => {
  it("keeps the renderer capability model privilege-free", () => {
    expect(rendererCapabilityModel).toEqual({
      nodeGlobalsAvailable: false,
      privilegedModulesAvailable: false,
      receivesOnlyPreloadData: true,
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
      "execution-evidence",
      "graph",
    ]);
  });

  it("settles task writes only from durable canonical receipts and resolves pending by opId", async () => {
    const showReceipt = vi.fn(async () => receipt({ outcome: "applied", opId: "op-pending" }));
    const settled = await settleTaskReceipt(
      receipt({
        outcome: "pending",
        opId: "op-pending",
        proof: {
          committedRevision: 8,
          appliedCut: 7,
          durable: true,
          canonicalVisible: false,
          worktreeVisible: true,
        },
        nextAction: "ha receipt show op-pending",
      }),
      showReceipt,
    );

    expect(showReceipt).toHaveBeenCalledOnce();
    expect(showReceipt).toHaveBeenCalledWith({ opId: "op-pending" });
    expect(settled).toMatchObject({ state: "applied", opId: "op-pending" });
    expect(
      await settleTaskReceipt(
        receipt({
          proof: {
            committedRevision: 8,
            appliedCut: 8,
            durable: true,
            canonicalVisible: false,
            worktreeVisible: true,
          },
        }),
        showReceipt,
      ),
    ).toMatchObject({ state: "pending", code: "canonical_not_visible" });
  });

  it("preserves raw rejection code, hint, and opId", async () => {
    const settled = await settleTaskReceipt(
      {
        schema: "command-receipt/v2",
        ok: false,
        command: "task-submit",
        outcome: "op_rejected",
        opId: "op-rejected",
        code: "invalid_submission",
        origin: "daemon",
        evidence: "rejection:invalid_submission",
        nextAction: "Fix the packet.",
        error: { code: "invalid_submission", hint: "Completion claim is required." },
      },
      vi.fn(),
    );
    expect(settled).toMatchObject({
      state: "op_rejected",
      opId: "op-rejected",
      code: "invalid_submission",
      hint: "Completion claim is required.",
    });
  });

  it("settles decision writes once by opId and requires the complete durable worktree proof", async () => {
    const showReceipt = vi.fn(async () => decisionReceipt({ outcome: "applied", opId: "op-decision" }));
    const settled = await settleDecisionReceipt(
      decisionReceipt({ outcome: "pending", opId: "op-decision", nextAction: "receipt show" }),
      showReceipt,
    );

    expect(showReceipt).toHaveBeenCalledOnce();
    expect(showReceipt).toHaveBeenCalledWith({ opId: "op-decision" });
    expect(settled).toMatchObject({
      state: "applied",
      opId: "op-decision",
      receipt: {
        consentId: "djc_0123456789abcdef0123456789",
        path: "decisions/decision-dec_test/decision.md",
        worktreeVisible: true,
      },
    });
    expect(await settleDecisionReceipt(decisionReceipt({ worktreeVisible: false }), vi.fn())).toMatchObject({
      state: "pending",
      code: "canonical_not_visible",
    });
  });

  it("renders an applied decision receipt while its Git commit identity is pending", async () => {
    const showReceipt = vi.fn();
    const settled = await settleDecisionReceipt(decisionReceipt({ commitSha: null }), showReceipt);

    expect(showReceipt).not.toHaveBeenCalled();
    expect(settled).toMatchObject({
      state: "applied",
      opId: "op-applied",
      receipt: { commitSha: null, worktreeVisible: true },
    });
  });

  it("preserves decision rejection origin/code/hint/opId and never resolves it as success", async () => {
    const settled = await settleDecisionReceipt(
      {
        schema: "command-receipt/v2",
        ok: false,
        command: "decision-accept",
        outcome: "op_rejected",
        opId: "op-reject",
        code: "judgment_only_rationale_required",
        origin: "daemon",
        nextAction: "Provide an independent rationale.",
        evidence: "rejection:judgment_only_rationale_required",
        error: { code: "judgment_only_rationale_required", hint: "No reachable claim evidence." },
      },
      vi.fn(),
    );

    expect(settled).toMatchObject({
      state: "op_rejected",
      opId: "op-reject",
      code: "judgment_only_rationale_required",
      origin: "daemon",
      hint: "No reachable claim evidence.",
    });
  });

  it("requires an active claim-to-evidence edge for non-judgment-only acceptance", () => {
    const decision = {
      decisionId: "dec_test",
      title: "D",
      state: "proposed",
      question: "Q",
      chosen: [],
      rejected: [],
      claims: [{ id: "C1", text: "Claim", loadBearing: true, fulfillment: "evidenced" }],
      judgmentConsents: [],
    } satisfies DecisionRow;
    const edge = {
      from: "decision/dec_test/C1",
      to: "fact/F-live",
      kind: "evidenced-by",
      direction: "directed",
      state: "active",
      provenance: "local-document",
    } as const;

    expect(decisionHasReachableEvidence(decision, [edge])).toBe(true);
    expect(decisionHasReachableEvidence(decision, [{ ...edge, from: "decision/dec_test/C2" }])).toBe(false);
    // 边的 currency 在管道收口处判定(adaptRelationRows 只留 current):retired 边
    // 根本进不了这里的输入,这里不再复查状态词。
    expect(
      buildTriadicRendererData({
        graph: {
          ok: true,
          edges: [
            {
              relationId: "rel_retired",
              sourceRef: "decision/dec_test/C1",
              targetRef: "fact/F-live",
              relationType: "evidenced-by",
              direction: "directed",
              strength: "strong",
              origin: "declared",
              state: "retired",
              targetObservedVersion: null,
              currentTargetVersion: null,
              freshness: "current",
              rationale: "audit history",
              ownerRef: "decision/dec_test",
              sourcePath: "event:dec_test",
              recordIndex: 0,
              current: false,
            },
          ],
          coverageRows: [],
          factAnchors: [],
          facts: [],
          warnings: [],
        },
        decisions: { ok: true, decisions: [], warnings: [] },
      }).relations,
    ).toEqual([]);
  });

  // 拖拽起跑的判据不再由 renderer 拼状态词,而是读 daemon 投影的 start 能力。
  // 阶段位与「为何没有阶段位」都来自投影:renderer 只翻译 reason 码,不比较状态词。
  it("paints the phase position from the projection and translates off-path reason codes", () => {
    const steps = ["planned", "active", "in_review", "done"] as const;
    const activeMarkup = renderToStaticMarkup(createElement(PhaseSteps, { phase: { index: 1, reason: null, steps } }));
    expect(activeMarkup).toContain("active");
    expect(activeMarkup).toContain("font-semibold");

    const blocked = renderToStaticMarkup(
      createElement(PhaseSteps, { phase: { index: null, reason: "blocked_overlay", steps } }),
    );
    expect(blocked).toContain("relation overlay");
    const cancelled = renderToStaticMarkup(
      createElement(PhaseSteps, { phase: { index: null, reason: "terminal_cancelled", steps } }),
    );
    expect(cancelled).toContain("cancelled：终态");
    const unresolved = renderToStaticMarkup(
      createElement(PhaseSteps, { phase: { index: null, reason: "phase_unresolved", steps } }),
    );
    expect(unresolved).toContain("快照展示值，无阶段位置");
  });

  it("allows drag start exactly when the projected start capability is available", () => {
    const planned: TaskRow = {
      taskId: "task-1",
      title: "One",
      projectId: "p",
      coordinationStatus: "planned",
      canonicalStatus: "planned",
      blocking: "clear",
      rawStatus: "planned/implementation",
      freshness: "fresh",
      packageDisposition: "active",
      closeoutReadiness: "not_required",
      engine: "kernel/task-lifecycle/v1",
      origin: "native",
      source: "local-document",
      module: "gui",
      lastKnownAt: "2026-08-14T00:00:00.000Z",
      gates: [],
      docs: [],
      ...projectedTaskFields("planned", { can: ["start"] }),
    };
    expect(taskCan(planned, "start")).toBe(true);
    expect(taskCan({ ...planned, ...projectedTaskFields("blocked") }, "start")).toBe(false);
    expect(taskCan({ ...planned, ...projectedTaskFields("active") }, "start")).toBe(false);
  });

  it("renders an explicit empty state when the triadic ledger has no entities", () => {
    const markup = renderToStaticMarkup(
      createElement(GraphView, { tasks: [], decisions: [], facts: [], relations: [] }),
    );

    expect(markup).toContain("triadic-graph-empty-state");
    expect(markup).toContain("暂无三元语关系数据");
  });

  it("renders the task plan body from the daemon document projection", async () => {
    const getTaskDocument = vi.fn(async ({ path }: { path: string }) => ({
      ok: true,
      status: "ready",
      taskId: "task-1",
      path,
      body: "# Canonical task plan",
      blobSha256: "sha256:canonical",
      worktreeBody: null,
      uncommitted: false,
      watermark: 7,
      sourceRevision: 7,
    }));
    vi.stubGlobal("window", { harness: { getTaskDocument } });
    const queryClient = new QueryClient();
    try {
      await queryClient.fetchQuery(taskDocumentQuery("project-1", "task-1", "task_plan.md"));
      const task: TaskRow = {
        taskId: "task-1",
        title: "One",
        projectId: "project-1",
        coordinationStatus: "active",
        rawStatus: "active",
        freshness: "fresh",
        packageDisposition: "active",
        closeoutReadiness: "not_required",
        engine: "local",
        source: "snapshot-cache",
        module: "gui",
        packagePath: "tasks/task-1-one",
        lastKnownAt: "2026-08-13T00:00:00.000Z",
        gates: [],
        docs: [],
        ...projectedTaskFields("active", { can: ["progress", "submit"] }),
      };
      const markup = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(TaskDetailView, { task, onBack: () => undefined, projectName: "Harness" }),
        ),
      );
      expect(getTaskDocument).toHaveBeenCalledWith({ repoId: "project-1", taskId: "task-1", path: "task_plan.md" });
      expect(markup).toContain("Canonical task plan");
      expect(markup).toContain("task-identity-strip");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders explicit active lease forms and read-only blocking explanations", () => {
    const active: TaskRow = {
      taskId: "task-active",
      title: "Active",
      projectId: "p",
      coordinationStatus: "active",
      canonicalStatus: "active",
      blocking: "clear",
      blockingLabel: "none",
      rawStatus: "active/implementation",
      freshness: "fresh",
      packageDisposition: "active",
      closeoutReadiness: "not_required",
      engine: "kernel/task-lifecycle/v1",
      origin: "native",
      source: "local-document",
      module: "gui",
      lastKnownAt: "2026-08-14T00:00:00.000Z",
      activeExecutionId: "execution-gui-1",
      gates: [],
      docs: [],
      ...projectedTaskFields("active", { can: ["progress", "submit"] }),
    };
    const activeMarkup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(TaskCloseoutTab, { task: active }),
      ),
    );
    expect(activeMarkup).toContain("追加 progress");
    expect(activeMarkup).toContain("atomic SubmissionV1");
    expect(activeMarkup).toContain("execution-gui-1");

    const blockedMarkup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(TaskCloseoutTab, {
          task: {
            ...active,
            canonicalStatus: "planned",
            coordinationStatus: "blocked",
            blocking: "blocked",
            blockingLabel: "relations",
            activeExecutionId: undefined,
            capabilities: [
              { id: "start", available: false, reason: "blocked" },
              { id: "progress", available: false, reason: "invalid_transition" },
            ],
            blockers: [
              {
                relationId: "rel_1",
                kind: "depends-on",
                sourceTaskId: "task-active",
                targetTaskId: "task-upstream",
                rationale: "wait",
              },
            ],
          },
        }),
      ),
    );
    expect(blockedMarkup).toContain("Blocked 是 relation overlay");
    expect(blockedMarkup).toContain("rel_1");
    expect(blockedMarkup).not.toContain("解除");
  });

  it("keeps the selected decision card visible and focused under all filters", () => {
    const decision: DecisionRow = {
      decisionId: "dec_gui_smoke",
      capabilities: [
        { id: "accept", available: true, reason: null },
        { id: "reject", available: true, reason: null },
        { id: "defer", available: true, reason: null },
        { id: "supersede", available: false, reason: "invalid_transition" },
        { id: "retire", available: false, reason: "invalid_transition" },
      ],
      claimsOpen: true,
      title: "Ship the GUI read surface",
      state: "proposed",
      riskTier: "high",
      urgency: "high",
      proposedBy: { kind: "agent", id: "codex" },
      question: "Should the GUI use daemon projections?",
      chosen: [],
      rejected: [],
      claims: [],
      judgmentConsents: [],
    };
    const decisions = Array.from({ length: 35 }, (_, index) => ({
      ...decision,
      decisionId: `dec_${String(index).padStart(2, "0")}`,
      title: `Decision ${index}`,
    }));
    const focused = decisions.at(-1)!;
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(DecisionPoolView, {
          repoId: "repo-a",
          decisions,
          facts: [],
          relations: [],
          focusedDecisionId: focused.decisionId,
          summary: {
            total: decisions.length,
            inboxCount: decisions.length,
            byState: {
              proposed: decisions.length,
              in_effect: 0,
              rejected: 0,
              deferred: 0,
              superseded: 0,
              outcome_retired: 0,
            },
            groups: [
              {
                id: "proposed",
                states: ["proposed"],
                count: decisions.length,
                decisionIds: decisions.map((row) => row.decisionId),
              },
              { id: "in_effect", states: ["in_effect"], count: 0, decisionIds: [] },
              { id: "rejected", states: ["rejected"], count: 0, decisionIds: [] },
              { id: "deferred", states: ["deferred"], count: 0, decisionIds: [] },
              { id: "retired", states: ["superseded", "outcome_retired"], count: 0, decisionIds: [] },
            ],
          },
        }),
      ),
    );

    // 完整渲染(2026-08-25 泽宇裁决):全部 35 张卡都在,聚焦卡天然可见,不需要任何点击。
    expect(markup.match(/id="decision-card-/gu)).toHaveLength(35);
    expect(markup).toContain(`id="decision-card-${focused.decisionId}"`);
    expect(markup).toContain('data-focused="true"');
    expect(markup).not.toContain('data-testid="decision-pool-more"');
    expect(markup).toMatch(/proposed\s*·\s*35/);
  });

  it("renders the exact proposal surface with human-selected risk and urgency", () => {
    const markup = renderToStaticMarkup(
      createElement(DecisionProposalForm, {
        onClose: () => undefined,
        onSubmit: async () => ({ state: "success", kind: "propose", opId: "op", hint: "ok" }),
      }),
    );

    for (const field of [
      "title",
      "question",
      "risk · 人选",
      "urgency · 人选",
      "decisionClass",
      "appliesTo.modules",
      "appliesTo.productLines",
      "chosen",
      "rejected",
      "claims",
      "fulfillments",
      "背景",
      "权衡",
      "结论",
    ])
      expect(markup).toContain(field);
    expect(markup.match(/<option value="" disabled="" selected="">请选择<\/option>/gu)).toHaveLength(2);
  });

  it("opens judgment-only rationale whenever acceptance has no active claim evidence", () => {
    const decision: DecisionRow = {
      decisionId: "dec_no_evidence",
      title: "D",
      state: "proposed",
      question: "Q",
      chosen: [],
      rejected: [],
      claims: [],
      judgmentConsents: [],
    };
    const markup = renderToStaticMarkup(
      createElement(DecisionJudgmentPanel, {
        decision,
        relations: [],
        openRequest: { action: "accept", nonce: 1 },
        onSubmit: async () => ({ state: "success", kind: "accept", opId: "op", hint: "ok" }),
      }),
    );

    expect(markup).toContain("judgment-only rationale");
    expect(markup).toContain("1..199");
  });

  it("keeps a pending judgment on its card and offers receipt-show without mutation replay", () => {
    const decision: DecisionRow = {
      decisionId: "dec_pending",
      title: "D",
      state: "proposed",
      question: "Q",
      chosen: [],
      rejected: [],
      claims: [],
      judgmentConsents: [],
    };
    const markup = renderToStaticMarkup(
      createElement(DecisionJudgmentPanel, {
        decision,
        relations: [],
        feedback: { state: "pending", kind: "accept", opId: "op-pending", hint: "wait" },
        onCheckReceipt: () => undefined,
        onSubmit: async () => ({ state: "success", kind: "accept", opId: "op", hint: "ok" }),
      }),
    );

    expect(markup).toContain("op-pending");
    expect(markup).toContain("receipt-show（不重放 mutation）");
  });
});

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "task-start",
    outcome: "applied",
    opId: "op-applied",
    revision: 8,
    evidence: "event-object:op-applied",
    visibility: "center",
    proof: { committedRevision: 8, appliedCut: 8, durable: true, canonicalVisible: true, worktreeVisible: true },
    ...overrides,
  };
}

function decisionReceipt(overrides: Record<string, unknown> = {}) {
  return receipt({
    command: "decision-accept",
    path: "decisions/decision-dec_test/decision.md",
    commitSha: "a".repeat(40),
    documentSha256: `sha256:${"b".repeat(64)}`,
    worktreeVisible: true,
    consentId: "djc_0123456789abcdef0123456789",
    ...overrides,
  });
}
