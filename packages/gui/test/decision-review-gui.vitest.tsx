// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { harnessClient } from "../src/renderer/api-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { DecisionReviewState, DecisionRow } from "../src/renderer/model/types.ts";
import {
  decisionReviewRounds,
  decisionReviewSignal,
  dispatchOfReview,
  reviewCuts,
} from "../src/renderer/model/decision-review.ts";
import { entityDetailTargetOf } from "../src/renderer/navigation/entityRoutes.ts";
import {
  decisionDetailLocation,
  decisionReviewRef,
  decisionSessionsLocation,
  decisionSessionsRef,
} from "../src/renderer/navigation/decisionReviewRoutes.ts";
import { DecisionDetailView } from "../src/renderer/components/decisionDetail/DecisionDetailView.tsx";
import { SessionGroupList } from "../src/renderer/components/sessions/SessionGroupList.tsx";
import { WorkspaceView } from "../src/renderer/views/WorkspaceView.tsx";
import { decisionProjectionFields } from "./decision-projection-fields.ts";

/**
 * Decision 评审展示面(task_5122f83e,dec_A64B14D6 CH6/CH7):评审记录与逐条处置、accept 就绪
 * 取读面 readiness、评审会话按 Decision 归组、Decision ↔ 会话 ↔ 报告双向跳转、报告只读中心文档。
 */
const CUT_A = `sha256:${"a".repeat(64)}`,
  CUT_B = `sha256:${"b".repeat(64)}`,
  ACTOR = { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "closeout-reviewer" } },
  OWNER = { principal: { personId: "person-ceo" }, executor: null };
const REPORT_B = "decisions/decision-dec_r/artifacts/reports/dispatch-b.md";

function reviewState(overrides: Partial<DecisionReviewState> = {}): DecisionReviewState {
  return {
    reviews: [
      {
        reviewId: "review-dispatch-a",
        reviewContentDigest: CUT_B,
        verdict: "approved",
        reason: "整体方案可接受",
        findings: [],
        evidenceChecked: [],
        reportRef: "decisions/decision-dec_r/artifacts/reports/dispatch-a.md",
        actor: ACTOR,
        reviewedAt: "2026-09-29T01:20:00.000Z",
      },
      {
        reviewId: "review-dispatch-b",
        reviewContentDigest: CUT_B,
        verdict: "changes_requested",
        reason: "两项意见需要提案人判断",
        findings: [
          { findingId: "F1", text: "正文未进入摘要" },
          { findingId: "F2", text: "派工归属不宜全面泛化" },
        ],
        evidenceChecked: [],
        reportRef: REPORT_B,
        actor: ACTOR,
        reviewedAt: "2026-09-29T01:24:00.000Z",
      },
      {
        reviewId: "review-old",
        reviewContentDigest: CUT_A,
        verdict: "changes_requested",
        reason: "旧内容的打回",
        findings: [{ findingId: "F9", text: "旧意见" }],
        evidenceChecked: [],
        reportRef: null,
        actor: ACTOR,
        reviewedAt: "2026-09-28T01:00:00.000Z",
      },
    ],
    responses: [
      {
        reviewId: "review-old",
        findingId: "F9",
        disposition: "rebut",
        rationale: "保留原方案",
        amendmentRef: null,
        actor: OWNER,
        respondedAt: "2026-09-28T02:00:00.000Z",
      },
    ],
    overrides: [],
    currentDigest: CUT_B,
    readiness: {
      ready: false,
      currentDigest: CUT_B,
      basis: null,
      blocker: {
        code: "changes_requested",
        reviewIds: ["review-dispatch-b"],
        reason: "Current content has unresolved changes_requested reviews.",
      },
      next: { action: "override-review", actor: "owner", reason: "The owner must override the named reviews." },
    },
    dispatches: [
      {
        dispatchId: "dispatch-a",
        runtimeSessionId: "runtime-a",
        status: "succeeded",
        reviewContentDigest: CUT_B,
        reportRef: "decisions/decision-dec_r/artifacts/reports/dispatch-a.md",
      },
      {
        dispatchId: "dispatch-b",
        runtimeSessionId: "runtime-b",
        status: "succeeded",
        reviewContentDigest: CUT_B,
        reportRef: REPORT_B,
      },
      {
        dispatchId: "dispatch-c",
        runtimeSessionId: "runtime-c",
        status: "unknown",
        reviewContentDigest: CUT_B,
        reportRef: null,
      },
      {
        dispatchId: "dispatch-d",
        runtimeSessionId: "runtime-d",
        status: "failed",
        reviewContentDigest: CUT_A,
        reportRef: null,
      },
    ],
    ...overrides,
  };
}

function decision(review: DecisionReviewState | undefined = reviewState()): DecisionRow {
  return {
    decisionId: "dec_r",
    title: "Decision 评审如何与 Task 共用规则",
    state: "proposed",
    ...decisionProjectionFields("proposed"),
    riskTier: "high",
    urgency: "medium",
    question: "Decision 能否独立评审?",
    chosen: [{ id: "CH1", text: "共用规则", evidence: [] }],
    rejected: [],
    claims: [],
    judgmentConsents: [],
    proposedBy: { kind: "agent", id: "proposer-agent" },
    ...(review ? { review } : {}),
  } as DecisionRow;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

const mounted: { readonly root: Root; readonly client: QueryClient }[] = [];
afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// React Query batches observer notifications on a zero-delay timer by default; run them as microtasks so a
// settled query has also re-rendered by the time the wait below observes it.
notifyManager.setScheduler(queueMicrotask);

async function mount(element: ReactElement): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  // Settle on a condition, not a count of timer ticks: every query this mount started has resolved and rendered.
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  await act(async () => undefined);
  return container;
}

/** decision-show 行(带正文):评审切面与就绪只在这里算得出;列表 full 行只贡献派工。 */
function stubShow(review: DecisionReviewState = reviewState(), status: "ready" | "pending" = "ready") {
  return vi.spyOn(harnessClient, "showDecision").mockResolvedValue({
    status,
    hint: null,
    decision: {
      decisionId: "dec_r",
      reviews: review.reviews,
      reviewResponses: review.responses,
      reviewOverrides: review.overrides,
      currentReviewContentDigest: review.currentDigest,
      acceptReviewReadiness: review.readiness,
      body: null,
    },
  } as never);
}

function detail(props: Record<string, unknown>) {
  if (!vi.isMockFunction(harnessClient.showDecision)) stubShow();
  return createElement(DecisionDetailView, {
    repoId: "repo-a",
    decisionId: "dec_r",
    decisions: [decision()],
    relations: [],
    loading: false,
    onBack: () => undefined,
    projectName: "Harness",
    onNavigateDecision: () => undefined,
    onNavigateEntity: () => undefined,
    ...props,
  });
}

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
};

describe("评审展示模型:只映射读面结果", () => {
  it("信号取自 readiness 与派工,不在前端重算 accept 判据", () => {
    expect(decisionReviewSignal(reviewState())).toBe("changesRequested");
    const ready = {
      ready: true,
      currentDigest: CUT_B,
      blocker: null,
      next: { action: "accept", actor: "proposer", reason: "ok" },
    } as const;
    expect(
      decisionReviewSignal(
        reviewState({
          readiness: { ...ready, basis: "policy_unreviewed" },
          dispatches: [
            { dispatchId: "d", runtimeSessionId: "r", status: "running", reviewContentDigest: CUT_B, reportRef: null },
          ],
        }),
      ),
    ).toBe("reviewing");
    // 当前切面有未处置打回时先归「待处置」,即使还有评审在跑(设计 Q5 的互斥主组顺序)。
    expect(
      decisionReviewSignal(
        reviewState({
          dispatches: [
            { dispatchId: "d", runtimeSessionId: "r", status: "running", reviewContentDigest: CUT_B, reportRef: null },
          ],
        }),
      ),
    ).toBe("changesRequested");
    expect(decisionReviewSignal(reviewState({ readiness: { ...ready, basis: "review" } }))).toBe("approved");
    // 必审未审:读面 blocker 为 review_required(下一步 dispatch-review)即「待评审」,不以「没评审过」近似。
    const reviewRequired = {
      ready: false,
      currentDigest: CUT_B,
      basis: null,
      blocker: { code: "review_required", reason: "Repository policy requires an approved review." },
      next: { action: "dispatch-review", actor: "proposer", reason: "Request an independent review." },
    } as const;
    expect(decisionReviewSignal(reviewState({ readiness: reviewRequired }))).toBe("reviewRequired");
    expect(decisionReviewSignal(reviewState({ readiness: reviewRequired, reviews: [], dispatches: [] }))).toBe(
      "reviewRequired",
    );
    // 已有当前切面评审在跑时仍是「评审中」(设计 Q5:评审中先于待评审)。
    expect(
      decisionReviewSignal(
        reviewState({
          readiness: reviewRequired,
          dispatches: [
            { dispatchId: "d", runtimeSessionId: "r", status: "running", reviewContentDigest: CUT_B, reportRef: null },
          ],
        }),
      ),
    ).toBe("reviewing");
    expect(
      decisionReviewSignal(reviewState({ readiness: { ...ready, basis: "policy_unreviewed" }, reviews: [] })),
    ).toBe("unreviewed");
    // 终态行没有就绪判定:不显示任何待裁信号。
    expect(decisionReviewSignal(reviewState({ readiness: null }))).toBeNull();
  });

  it("按评审自身切面分当前/历史;评审 ↔ 派工只按读面给出的 reportRef 连接", () => {
    const state = reviewState(),
      cuts = reviewCuts(state);
    expect(cuts.current.map(({ reviewId }) => reviewId)).toEqual(["review-dispatch-b", "review-dispatch-a"]);
    expect(cuts.historical.map(({ reviewId }) => reviewId)).toEqual(["review-old"]);
    expect(dispatchOfReview(state, state.reviews[1]!)?.runtimeSessionId).toBe("runtime-b");
    // 手工登记(无 reportRef)不猜派工。
    expect(dispatchOfReview(state, state.reviews[2]!)).toBeNull();
    // decision-show 行没有派工:null 表示「此读面不含派工」,不是空列表。
    expect(decisionReviewRounds(decision(reviewState({ dispatches: null })))).toBeNull();
    expect(decisionReviewRounds(decision())?.map(({ review }) => review?.verdict ?? null)).toEqual([
      "approved",
      "changes_requested",
      null,
      null,
    ]);
  });

  it("评审落点是 decisionDetail / sessions 的读导航别名,不与 claim 引用冲突", () => {
    expect(entityDetailTargetOf(decisionReviewRef("dec_r", "report", "review-dispatch-b"))).toEqual({
      view: "decisionDetail",
      focusedEntityRef: "decisionreview/dec_r/report/review-dispatch-b",
    });
    expect(decisionDetailLocation("decisionreview/dec_r/report/review-dispatch-b")).toEqual({
      decisionId: "dec_r",
      tab: "report",
      reviewId: "review-dispatch-b",
    });
    expect(decisionDetailLocation("decision/dec_r/C1")).toEqual({ decisionId: "dec_r", tab: null, reviewId: null });
    expect(decisionDetailLocation("decisionreview/dec_r/bogus")).toBeNull();
    expect(entityDetailTargetOf(decisionSessionsRef("dec_r", "runtime-b"))).toEqual({
      view: "sessions",
      focusedEntityRef: "decisionsessions/dec_r/runtime-b",
    });
    expect(decisionSessionsLocation("decisionsessions/dec_r")).toEqual({ decisionId: "dec_r", runtimeSessionId: null });
  });
});

describe("Decision 详情 · 提案与评审(S3)", () => {
  it("横幅、当前/历史切面、派工状态逐态显示,并能跳到报告与会话", async () => {
    const onNavigateEntity = vi.fn();
    const view = await mount(detail({ reviewLocation: { tab: "review", reviewId: null }, onNavigateEntity }));
    expect(view.querySelector("[data-testid='decision-review-signal']")?.textContent).toBe("待处置");
    expect(view.querySelector("[data-testid='decision-review-banner']")?.textContent).toContain(
      "当前内容有 1 条请求修改尚未由业主具名处置",
    );
    const current = view.querySelector("[data-testid='decision-review-current']")!;
    expect(current.textContent).toContain("review-dispatch-a");
    expect(current.textContent).toContain("review-dispatch-b");
    expect(current.textContent).not.toContain("review-old");
    expect(view.querySelector("[data-testid='decision-review-historical']")?.textContent).toContain("已反驳");
    // unknown 与「没有评审」分开;运行结束但没登记评审单独说明。
    expect(view.querySelector("[data-testid='decision-review-dispatch-dispatch-c']")?.textContent).toContain(
      "状态未知",
    );
    expect(view.querySelector("[data-testid='decision-review-dispatch-dispatch-c']")?.textContent).not.toContain(
      "未登记评审结论",
    );
    expect(view.querySelector("[data-testid='decision-review-dispatch-dispatch-d']")?.textContent).toContain(
      "未登记评审结论",
    );
    await click(view.querySelector("[data-testid='decision-review-open-report-review-dispatch-b']"));
    expect(onNavigateEntity).toHaveBeenLastCalledWith("decisionreview/dec_r/report/review-dispatch-b");
    await click(view.querySelector("[data-testid='decision-review-open-session-review-dispatch-b']"));
    expect(onNavigateEntity).toHaveBeenLastCalledWith("decisionsessions/dec_r/runtime-b");
    await click(view.querySelector("[data-testid='decision-review-sessions-open']"));
    expect(onNavigateEntity).toHaveBeenLastCalledWith("decisionsessions/dec_r");
  });

  it("评审切面与就绪取列表 full 行:正文单体读追赶中不挡评审页签", async () => {
    stubShow(reviewState({ readiness: null, currentDigest: null }), "pending");
    const view = await mount(detail({ reviewLocation: { tab: "review", reviewId: null } }));
    expect(view.querySelector("[data-testid='decision-review-tab']")).toBeTruthy();
    expect(view.querySelector("[data-testid='decision-review-signal']")?.textContent).toBe("待处置");
  });

  it("派审带读面当前切面摘要作为 expectedDigest", async () => {
    const dispatch = vi.spyOn(harnessClient, "dispatchDecisionReview").mockResolvedValue({
      schema: "command-receipt/v2",
      ok: true,
      command: "decision-dispatch-review",
      outcome: "applied",
      opId: "op-d",
      summary: "Dispatched",
    } as never);
    const view = await mount(detail({ reviewLocation: { tab: "review", reviewId: null } }));
    await click(view.querySelector("[data-testid='decision-review-dispatch']"));
    expect(dispatch).toHaveBeenCalledWith({ repoId: "repo-a", decisionId: "dec_r", expectedDigest: CUT_B });
  });
});

describe("逐项回应(S4):「我的判断」不设默认值", () => {
  it("没有预选;未选判断不提交;选定并写理由后按 finding 提交", async () => {
    const respond = vi.spyOn(harnessClient, "respondDecisionReview").mockResolvedValue({
      schema: "command-receipt/v2",
      ok: true,
      command: "decision-respond-review",
      outcome: "pending",
      opId: "op-r",
    } as never);
    const view = await mount(detail({ reviewLocation: { tab: "respond", reviewId: null } }));
    const radios = [...view.querySelectorAll<HTMLInputElement>("input[type='radio']")];
    expect(radios.length).toBe(6);
    expect(radios.some((radio) => radio.checked)).toBe(false);

    await click(view.querySelector("[data-testid='decision-respond-save']"));
    expect(respond).not.toHaveBeenCalled();
    expect(view.textContent).toContain("还没有选定任何一条意见的判断");

    const rationale = view.querySelector<HTMLTextAreaElement>(
      "[data-testid='decision-respond-review-dispatch-b/F2-rationale']",
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(rationale, "保留 reviewer 专用 target");
      rationale.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(view.querySelector("[data-testid='decision-respond-save']"));
    expect(respond).not.toHaveBeenCalled();
    expect(view.textContent).toContain("每条要回应的意见都必须选定判断并写明理由");

    await click(view.querySelector("[data-testid='decision-respond-review-dispatch-b/F2-rebut']"));
    await click(view.querySelector("[data-testid='decision-respond-save']"));
    expect(respond).toHaveBeenCalledWith({
      repoId: "repo-a",
      decisionId: "dec_r",
      responses: [
        {
          reviewId: "review-dispatch-b",
          findingId: "F2",
          disposition: "rebut",
          rationale: "保留 reviewer 专用 target",
          amendmentRef: null,
        },
      ],
    });
  });
});

describe("裁决(S8)与报告(S6)", () => {
  it("readiness 未就绪时 accept 停用并说明原因,reject/defer 仍可用;业主处置列出当前打回", async () => {
    const view = await mount(detail({ reviewLocation: { tab: "judge", reviewId: null }, onJudge: vi.fn() }));
    expect(view.querySelector<HTMLButtonElement>("[data-testid='decision-judge-accept']")?.disabled).toBe(true);
    expect(view.querySelector<HTMLButtonElement>("[data-testid='decision-judge-reject']")?.disabled).toBe(false);
    expect(view.querySelector("[data-testid='decision-judge-accept-blocked']")?.textContent).toContain(
      "unresolved changes_requested",
    );
    expect(view.querySelector("[data-testid='decision-judge-unresolved']")?.textContent).toContain("review-dispatch-b");
    expect(
      view.querySelector<HTMLInputElement>("[data-testid='decision-override-pick-review-dispatch-b']")?.checked,
    ).toBe(false);
  });

  it("报告正文按 reportRef 经中心文档读取;中心拒收时逐态说明,不读本机文件", async () => {
    const show = vi.spyOn(harnessClient, "showDocument").mockResolvedValue({
      schema: "command-receipt/v2",
      ok: true,
      command: "doc-show",
      outcome: "applied",
      opId: "read:doc-show",
      evidence: "# 独立评审报告\n\nF1 正文未进入摘要。",
    } as never);
    const onNavigateEntity = vi.fn();
    const view = await mount(
      detail({ reviewLocation: { tab: "report", reviewId: "review-dispatch-b" }, onNavigateEntity }),
    );
    expect(show).toHaveBeenCalledWith({ repoId: "repo-a", path: REPORT_B });
    expect(view.querySelector("[data-testid='decision-report-body']")?.textContent).toContain("F1 正文未进入摘要");
    await click(view.querySelector("[data-testid='decision-report-back-session']"));
    expect(onNavigateEntity).toHaveBeenLastCalledWith("decisionsessions/dec_r/runtime-b");
    await click(view.querySelector("[data-testid='decision-report-back-decision']"));
    expect(onNavigateEntity).toHaveBeenLastCalledWith("decisionreview/dec_r/review");

    show.mockResolvedValue({
      schema: "command-receipt/v2",
      ok: false,
      command: "doc-show",
      outcome: "op_rejected",
      opId: "read:doc-show",
      error: { code: "document_not_found" },
    } as never);
    const missing = await mount(detail({ reviewLocation: { tab: "report", reviewId: "review-dispatch-a" } }));
    expect(missing.querySelector("[data-testid='decision-report-body']")?.textContent).toContain("document_not_found");
  });
});

describe("会话页(S5):评审会话按被评审 Decision 归组", () => {
  it("Decision 组可展开为评审轮次;点击精确落 decisionsessions,组尾回到 Decision 评审", async () => {
    const onSelectEntity = vi.fn(),
      onToggleGroup = vi.fn();
    const group = {
      key: "dec_r",
      kind: "decision" as const,
      label: "dec_r",
      decisionId: "dec_r",
      latestStatus: "succeeded" as const,
      roundCount: 2,
      sessionCount: 2,
      runningCount: 0,
      latestActivityAt: "2026-09-29T01:24:00.000Z",
      latestRound: null,
    };
    const view = await mount(
      createElement(SessionGroupList, {
        groups: [group] as never,
        truncated: false,
        expandedKeys: new Set(["dec_r"]),
        rowsByGroup: new Map(),
        decisionRowsByGroup: new Map([
          [
            "dec_r",
            {
              title: "Decision 评审如何与 Task 共用规则",
              rounds: decisionReviewRounds(decision()),
              pending: false,
              error: null,
            },
          ],
        ]),
        selectedId: "runtime-b",
        query: "",
        decisionRefsFor: () => [],
        onSelectSession: vi.fn(),
        onToggleGroup,
        onOpenTask: vi.fn(),
        onSelectEntity,
      }),
    );
    expect(view.querySelector("[data-testid='session-group-dec_r']")?.textContent).toContain(
      "Decision 评审如何与 Task 共用规则",
    );
    expect(view.querySelector("[data-testid='rail-session-runtime-c']")?.textContent).toContain("状态未知");
    await click(view.querySelector("[data-testid='rail-session-runtime-b']"));
    expect(onSelectEntity).toHaveBeenLastCalledWith("decisionsessions/dec_r/runtime-b");
    await click(
      [...view.querySelectorAll("button")].find((button) => button.textContent?.includes("Decision 评审详情")),
    );
    expect(onSelectEntity).toHaveBeenLastCalledWith("decisionreview/dec_r/review");
  });
});

describe("工作页(S2):工作内 Decision 按评审信号分组", () => {
  const ready = {
    ready: true,
    currentDigest: CUT_B,
    basis: "policy_unreviewed",
    blocker: null,
    next: { action: "accept", actor: "proposer", reason: "ok" },
  } as const;
  const row = (decisionId: string, title: string, review: DecisionReviewState, state = "proposed") =>
    ({ ...decision(review), decisionId, title, state }) as DecisionRow;
  const workDecisions = [
    row("dec_a", "打回未处置的提案", reviewState()),
    row(
      "dec_b",
      "评审进行中的提案",
      reviewState({
        readiness: ready,
        dispatches: [
          { dispatchId: "d", runtimeSessionId: "r", status: "running", reviewContentDigest: CUT_B, reportRef: null },
        ],
      }),
    ),
    row("dec_c", "可免审裁决的提案", reviewState({ reviews: [], readiness: ready, dispatches: [] })),
    row(
      "dec_e",
      "必审未审的提案",
      reviewState({
        reviews: [],
        dispatches: [],
        readiness: {
          ready: false,
          currentDigest: CUT_B,
          basis: null,
          blocker: { code: "review_required", reason: "Repository policy requires an approved review." },
          next: { action: "dispatch-review", actor: "proposer", reason: "Request an independent review." },
        },
      }),
    ),
    row("dec_d", "已生效的提案", reviewState({ readiness: null }), "in_effect"),
  ];
  const scope = {
    schema: "daemon.workspace-scope/v1",
    ok: true,
    status: "ready",
    root: {
      taskId: "task_root",
      title: "Review 跨实体统一",
      status: "active",
      taskClass: "work",
      parentTaskId: null,
      updatedAt: "2026-09-29T00:00:00.000Z",
      pinned: true,
      hasChildren: true,
    },
    ancestors: [],
    goalMaterial: { taskId: "task_root", path: "task_plan.md" },
    counts: { done: 0, executing: 0, pending: 0, blocked: 0, planned: 0, cancelled: 0 },
    scope: { descendantCount: 1, executableLeafCount: 1, archivedCount: 0 },
    groups: [],
    memberTaskIds: ["task_leaf"],
    eventSummaries: [],
    eventWindowComplete: true,
    tasks: [],
    page: { limit: 100, cursor: null, nextCursor: null },
    incompleteParentRefs: [],
    watermark: 1,
    sourceRevision: 1,
    warnings: [],
  } as const;

  it("待处置/待评审/评审中/待裁决各成一组并带计数;页签只改当前显示;查看直达评审页签", async () => {
    const onNavigateEntity = vi.fn();
    const view = await mount(
      createElement(WorkspaceView, {
        scope,
        projectName: "Harness",
        onOpenTask: () => undefined,
        decisions: workDecisions,
        relations: workDecisions.map(({ decisionId }) => ({
          from: "task/task_leaf",
          to: `decision/${decisionId}`,
          kind: "derives",
        })) as never,
        onNavigateEntity,
      }),
    );
    // 原型 v2:Decision 评审分组住在「决策与事实」页签下。
    await click(view.querySelector("#workspace-tab-decisions"));
    const section = view.querySelector("[data-testid='work-decision-review']")!;
    expect(section).toBeTruthy();
    const group = (id: string) => section.querySelector(`[data-testid='work-decision-review-group-${id}']`);
    expect(group("dispose")?.textContent).toContain("打回未处置的提案");
    expect(group("dispose")?.textContent).toContain("1 项");
    expect(group("reviewing")?.textContent).toContain("评审进行中的提案");
    expect(group("judge")?.textContent).toContain("可免审裁决的提案");
    // review_required 的 Decision 进「待评审」,不落进待裁决。
    expect(group("review")?.textContent).toContain("必审未审的提案");
    expect(group("judge")?.textContent).not.toContain("必审未审的提案");
    expect([...section.querySelectorAll("[role='tab']")].map((tab) => tab.textContent)).toEqual([
      "全部",
      "待处置",
      "待评审",
      "评审中",
      "待裁决",
    ]);
    // 终态 Decision 没有就绪判定,不进任何组。
    expect(section.textContent).not.toContain("已生效的提案");
    await click(section.querySelector("[data-testid='work-decision-review-tab-reviewing']"));
    expect(group("dispose")).toBeNull();
    expect(group("reviewing")?.textContent).toContain("评审进行中的提案");
    await click(section.querySelector("[data-testid='work-decision-review-tab-all']"));
    await click(section.querySelector("[data-testid='work-decision-review-open-dec_a']"));
    expect(onNavigateEntity).toHaveBeenLastCalledWith("decisionreview/dec_a/review");
  });
});
