// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FactDetailView } from "../src/renderer/views/EntityDetailView.tsx";
import { DecisionDetailView } from "../src/renderer/components/decisionDetail/DecisionDetailView.tsx";
import { decisionStateLabel } from "../src/renderer/components/badges.tsx";
import { splitMarkdownBlocks } from "../src/renderer/components/decisionDetail/DecisionBodyPanel.tsx";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";
import { decisionProjectionFields } from "./decision-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * Fact 详情页(W4 可寻址路由的渲染面):
 * 详情栏复用 FactInspector,邻域复用 graph/EgoNeighborhood;
 * 无单体 read —— 取数来自已加载的 triadic 集合,集合加载中/实体缺失有显式态。
 * Decision 详情页(D-03):Task 详情形态(身份条+分页签),正文经 decision-show
 * 单体 read(includeBody)取回 —— 列表读面恒不带 body,取不到时显式说明原因。
 */

function task(taskId: string, title: string): TaskRow {
  return {
    taskId,
    title,
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    lastKnownAt: "2026-08-01T00:00:00.000Z",
    gates: [],
    docs: [],
  };
}

function decision(): DecisionRow {
  return {
    decisionId: "dec_1",
    title: "暴露投影",
    state: "in_effect",
    question: "走哪条读径?",
    chosen: [{ id: "CH1", text: "复用集合投影", evidence: [] }],
    rejected: [{ id: "RJ1", text: "直读 Markdown", evidence: [], whyNot: "绕开 canonical 投影" }],
    claims: [],
    proposedAt: "2026-08-01T00:00:00.000Z",
    ...decisionProjectionFields("proposed"),
  } as DecisionRow;
}

const facts: FactRef[] = [
  {
    anchor: "fact/F-001",
    taskId: "task_a",
    category: "finding",
    text: "GUI 收到了事件派生的三元行。",
    at: "2026-08-01T00:00:00.000Z",
  },
];

const relations: RelationEdge[] = [
  { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
  { from: "decision/dec_1/CH1", to: "fact/F-001", kind: "evidenced-by", provenance: "local-document" },
  { from: "task/task_a", to: "fact/F-001", kind: "produces", provenance: "local-document" },
];

async function mountView(element: ReturnType<typeof createElement>) {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  await act(async () => {
    root.render(element);
  });
  return { div, root: root as Root };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

describe("FactDetailView", () => {
  it("renders the fact inspector beside a neighborhood centered on the fact", async () => {
    const { div, root } = await mountView(
      createElement(FactDetailView, {
        factRef: "fact/F-001",
        facts,
        tasks: [task("task_a", "任务A")],
        decisions: [decision()],
        relations,
        factAnchors: [],
        loading: false,
      }),
    );
    expect(div.querySelector("[data-testid='fact-inspector']")?.textContent).toContain("GUI 收到了事件派生的三元行。");
    expect(div.querySelector("[data-testid='fact-detail-view'] .react-flow")).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("neighbor nodes report jumps through onNavigateEntity (跳去邻居详情页)", async () => {
    const onNavigateEntity = vi.fn();
    const { div, root } = await mountView(
      createElement(FactDetailView, {
        factRef: "fact/F-001",
        facts,
        tasks: [task("task_a", "任务A")],
        decisions: [decision()],
        relations,
        factAnchors: [],
        loading: false,
        onNavigateEntity,
      }),
    );
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务A"))!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onNavigateEntity).toHaveBeenCalledWith("task/task_a");
    await act(async () => {
      root.unmount();
    });
  });

  it("anchor-only facts (no body in the projection) still show a neighborhood", async () => {
    const { div, root } = await mountView(
      createElement(FactDetailView, {
        factRef: "fact/F-002",
        facts: [],
        tasks: [task("task_b", "任务B")],
        decisions: [],
        relations: [],
        factAnchors: [{ factRef: "fact/F-002", taskId: "task_b", factId: "F-002" }],
        loading: false,
      }),
    );
    expect(div.querySelector("[data-testid='fact-inspector']")).not.toBeNull();
    // 仅有锚点也有详情页(不因正文缺席而 404)。
    expect(div.querySelector("[data-testid='entity-detail-pending']")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("W5 后不再有「在分诊中查看」出口(事实分诊页已撤销,详情页即终点)", async () => {
    const { div, root } = await mountView(
      createElement(FactDetailView, {
        factRef: "fact/F-001",
        facts,
        tasks: [task("task_a", "任务A")],
        decisions: [decision()],
        relations,
        factAnchors: [],
        loading: false,
      }),
    );
    expect(div.querySelector("[data-testid='fact-detail-open-triage']")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("missing fact while loading shows loading; after load shows not-in-projection", async () => {
    const loadingView = await mountView(
      createElement(FactDetailView, {
        factRef: "fact/F-404",
        facts,
        tasks: [],
        decisions: [],
        relations: [],
        factAnchors: [],
        loading: true,
      }),
    );
    expect(loadingView.div.querySelector("[data-testid='entity-detail-pending']")?.textContent).toContain("加载中");
    await act(async () => {
      loadingView.root.unmount();
    });
    const missingView = await mountView(
      createElement(FactDetailView, {
        factRef: "fact/F-404",
        facts,
        tasks: [],
        decisions: [],
        relations: [],
        factAnchors: [],
        loading: false,
      }),
    );
    expect(missingView.div.querySelector("[data-testid='entity-detail-pending']")?.textContent).toContain(
      "不在当前投影",
    );
    await act(async () => {
      missingView.root.unmount();
    });
  });
});

// ============ Decision 详情页(D-03:正文可见)============

const PROSE = "# 决策正文\n\n选择的策略是复用投影读面。\n\n- 第一条理由\n- 第二条理由\n";

function decisionRow(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_1",
    title: "暴露投影",
    state: "in_effect",
    question: "走哪条读径?",
    chosen: [{ id: "CH1", text: "复用集合投影", evidence: [] }],
    rejected: [{ id: "RJ1", text: "直读 Markdown", evidence: [], whyNot: "绕开 canonical 投影" }],
    claims: [{ id: "C1", text: "正文必须经单体 read 取回", loadBearing: true, fulfillment: "delivered" }],
    judgmentConsents: [
      {
        schema: "decision-judgment-consent/v1",
        consentId: "djc_1",
        decisionId: "dec_1",
        action: "accept",
        targetState: "in_effect",
        machineDigest: "sha256:ab",
        actor: { principal: { personId: "person-ceo" }, executor: null },
        source: "local",
        consentedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    proposedAt: "2026-08-01T00:00:00.000Z",
    decidedAt: "2026-08-02T00:00:00.000Z",
    vertical: "software-coding",
    preset: "plt-gui",
    decisionClass: "ordinary",
    workspaceRevision: 7,
    appliesTo: { modules: ["gui"], productLines: ["platform"] },
    proposedBy: { kind: "human", id: "person-ceo" },
    arbiter: { kind: "human", id: "person-ceo" },
    provenance: [{ runtime: "claude-code", sessionId: "session-1", boundAt: "2026-08-01T00:00:00.000Z" }],
    ...overrides,
  } as DecisionRow;
}

/** decision-show(includeBody:true) 的 daemon receipt 形态(readReceipt 的 evidence 是 JSON 字符串)。 */
function showReceipt(body: string | null, status: "ready" | "pending" = "ready") {
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "decision-show",
    outcome: status === "ready" ? "applied" : "pending",
    opId: "read:decision-show",
    revision: 7,
    evidence: JSON.stringify({
      status,
      watermark: 7,
      sourceRevision: 7,
      decision: {
        schema: "decision-row/v1",
        decisionId: "dec_1",
        path: "decisions/decision-dec_1/decision.md",
        state: "in_effect",
        title: "暴露投影",
        question: "走哪条读径?",
        riskTier: "low",
        urgency: "low",
        vertical: "software-coding",
        preset: "plt-gui",
        decisionClass: "ordinary",
        appliesTo: { modules: ["gui"], productLines: ["platform"] },
        proposer: { principal: { personId: "person-ceo" }, executor: null },
        arbiter: { principal: { personId: "person-ceo" }, executor: null },
        proposedAt: "2026-08-01T00:00:00.000Z",
        decidedAt: "2026-08-02T00:00:00.000Z",
        workspaceRevision: 7,
        chosen: [],
        rejected: [],
        claims: [],
        provenance: [],
        judgmentConsents: [],
        reviews: [],
        reviewResponses: [],
        reviewOverrides: [],
        // decision-show 的评审切面(daemon decisionReviewState):终态行没有 accept 就绪判定。
        currentReviewContentDigest: `sha256:${"b".repeat(64)}`,
        acceptReviewReadiness: null,
        body:
          body === null
            ? null
            : {
                path: "decisions/decision-dec_1/decision.md",
                blobSha256: `sha256:${"a".repeat(64)}`,
                size: body.length,
                mediaType: "text/markdown",
                body,
                workspaceRevision: 7,
              },
      },
    }),
    visibility: "center",
    proof: {
      committedRevision: 7,
      appliedCut: 7,
      durable: true,
      canonicalVisible: status === "ready",
      worktreeVisible: null,
    },
    ...(status === "pending" ? { nextAction: "Retry decision-show after projection catch-up." } : {}),
  };
}

const queryMounted: { readonly root: Root; readonly client: QueryClient }[] = [];

afterEach(async () => {
  await act(async () => {
    for (const { root, client } of queryMounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  vi.unstubAllGlobals();
});

/** 概况页签里的 Region 是 motion 布局节点,挂载时要在 window 上挂 resize 监听。 */
function stubOverviewWindow() {
  vi.stubGlobal("window", {
    harness: { showDecision: vi.fn(async () => showReceipt(PROSE)) },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

async function mountDecisionView(decision: DecisionRow | null, props: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  queryMounted.push({ root, client });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DecisionDetailView, {
          repoId: "repo-a",
          decisionId: decision?.decisionId ?? "dec_1",
          decisions: decision ? [decision] : [],
          relations,
          loading: false,
          onBack: () => undefined,
          projectName: "Harness",
          fromViewLabel: "决策池",
          onNavigateDecision: () => undefined,
          onNavigateEntity: () => undefined,
          ...props,
        }),
      ),
    );
  });
  for (let index = 0; index < 3; index++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

describe("DecisionDetailView", () => {
  it("八个页签两两切换时保留点击落点,并响应外部评审路由与决策变化", async () => {
    stubOverviewWindow();
    let navigate!: (tab: "review" | "respond" | "report" | "judge" | null, id?: string) => void;
    function RoutedDetail() {
      const [location, setLocation] = useState<{ tab: "review" | "respond" | "report" | "judge" | null; id: string }>({
        tab: "judge",
        id: "dec_1",
      });
      navigate = (tab, id = "dec_1") => setLocation({ tab, id });
      return createElement(DecisionDetailView, {
        repoId: "repo-a",
        decisionId: location.id,
        decisions: [{ ...decisionRow(), decisionId: location.id }],
        loading: false,
        projectName: "Harness",
        onBack: () => undefined,
        onNavigateDecision: () => undefined,
        onNavigateEntity: () => undefined,
        reviewLocation: { tab: location.tab, reviewId: null },
        onLocate: (ref) =>
          navigate(
            ref.startsWith("decisionreview/") ? (ref.split("/")[2] as "review" | "respond" | "report" | "judge") : null,
            location.id,
          ),
      });
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div"),
      root = createRoot(container);
    document.body.append(container);
    queryMounted.push({ root, client });
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(RoutedDetail))));
    const keys = ["body", "overview", "claims", "relations", "review", "respond", "report", "judge"];
    const selected = (key: string) =>
      expect(container.querySelector(`#decision-tab-${key}`)?.getAttribute("aria-selected")).toBe("true");
    const click = async (key: string) => {
      await act(async () => (container.querySelector(`#decision-tab-${key}`) as HTMLButtonElement).click());
      selected(key);
    };
    selected("judge");
    // 首个回归路径:裁决 → 概况;随后覆盖全部 56 个不同页签有向组合。
    await click("overview");
    for (const source of keys)
      for (const target of keys) {
        if (source === target) continue;
        await click(source);
        await click(target);
      }
    for (const tab of ["review", "respond", "report", "judge"] as const) {
      await act(async () => navigate(tab));
      selected(tab);
    }
    await click("claims");
    await act(async () => navigate(null, "dec_2"));
    selected("body");
  });

  it("页头长标题自己折行;状态/风险/紧急徽章不折行、不被压缩(标准 §2.5 v2)", async () => {
    stubOverviewWindow();
    vi.stubGlobal("window", { harness: { showDecision: vi.fn(async () => showReceipt(null)) } });
    const div = await mountDecisionView(
      decisionRow({
        title: "为公开仓库添加 production-delta 门:把任务包绕过 CI 直写生产代码的路径关掉的超长决策标题",
        riskTier: "high",
        urgency: "high",
      }),
    );
    const header = div.querySelector("[data-testid='decision-detail-header']");
    const h1 = header?.querySelector("h1");
    // 标题不再 truncate(截断):换行由标题自己承担,徽章保持横排一行。
    expect(h1?.className).not.toContain("truncate");
    const badges = h1?.parentElement?.querySelectorAll(":scope > span") ?? [];
    expect(badges.length).toBeGreaterThanOrEqual(3);
    for (const badge of badges) {
      expect(badge.className, `徽章「${badge.textContent}」必须 whitespace-nowrap + shrink-0`).toContain(
        "whitespace-nowrap",
      );
      expect(badge.className).toContain("shrink-0");
    }
  });

  it("选中决策后能读到 Markdown 正文(正向不变量)", async () => {
    const showDecision = vi.fn(async () => showReceipt(PROSE));
    vi.stubGlobal("window", { harness: { showDecision } });
    const div = await mountDecisionView(decisionRow());

    expect(showDecision).toHaveBeenCalledWith({ repoId: "repo-a", decisionId: "dec_1", includeBody: true });
    const body = div.querySelector("[data-testid='decision-body-document']");
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain("决策正文");
    expect(body!.textContent).toContain("第一条理由");
    expect(body!.querySelector("h1")).not.toBeNull();
    expect(div.querySelector("[data-testid='decision-body-loading']")).toBeNull();
  });

  it("投影未返回正文时说出原因,不显示空白(负向不变量)", async () => {
    vi.stubGlobal("window", { harness: { showDecision: vi.fn(async () => showReceipt(null)) } });
    const div = await mountDecisionView(decisionRow());

    expect(div.querySelector("[data-testid='decision-body-unavailable']")?.textContent).toContain(
      "投影未返回该决策的正文",
    );
    expect(div.querySelector("[data-testid='decision-body-document']")).toBeNull();
  });

  it("投影追赶(pending)与读取失败各自显式说明", async () => {
    vi.stubGlobal("window", { harness: { showDecision: vi.fn(async () => showReceipt(PROSE, "pending")) } });
    const pending = await mountDecisionView(decisionRow());
    expect(pending.querySelector("[data-testid='decision-body-pending']")?.textContent).toContain("投影仍在追赶");
    expect(pending.querySelector("[data-testid='decision-body-pending']")?.textContent).toContain(
      "Retry decision-show after projection catch-up.",
    );

    await act(async () => {
      for (const { root, client } of queryMounted.splice(0)) {
        root.unmount();
        client.clear();
      }
    });
    vi.stubGlobal("window", {
      harness: {
        showDecision: vi.fn(async () => ({
          schema: "command-receipt/v2",
          ok: false,
          command: "decision-show",
          outcome: "op_rejected",
          opId: "op-x",
        })),
      },
    });
    const failed = await mountDecisionView(decisionRow());
    const error = failed.querySelector("[data-testid='decision-body-error']");
    expect(error?.textContent).toContain("决策正文读取失败");
  });

  it("长正文一次完整渲染,不再有「再显示」入口(规模不变量)", async () => {
    const longBody = Array.from({ length: 30 }, (_, index) => `第 ${index} 节内容,验证长正文完整渲染。`).join("\n\n");
    vi.stubGlobal("window", { harness: { showDecision: vi.fn(async () => showReceipt(longBody)) } });
    const div = await mountDecisionView(decisionRow());

    expect(div.querySelectorAll("[data-testid='decision-body-block']").length).toBe(30);
    expect(div.textContent).toContain("第 29 节内容");
    expect(div.querySelector("[data-testid='decision-body-more']")).toBeNull();
  });

  it("实体不在投影时给出显式态,且不发起正文读取", async () => {
    const showDecision = vi.fn(async () => showReceipt(PROSE));
    vi.stubGlobal("window", { harness: { showDecision } });
    const missing = await mountDecisionView(null);
    expect(missing.querySelector("[data-testid='decision-detail-pending']")?.textContent).toContain("不在当前投影");
    expect(showDecision).not.toHaveBeenCalled();
  });

  it("身份条与分页签齐备(含四个评审页签);池/图出口带决策 ID", async () => {
    vi.stubGlobal("window", { harness: { showDecision: vi.fn(async () => showReceipt(PROSE)) } });
    const onOpenPool = vi.fn(),
      onFocusGraph = vi.fn();
    const div = await mountDecisionView(decisionRow(), { onOpenPool, onFocusGraph });

    expect([...div.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual([
      "正文",
      "概况",
      "承重与裁决",
      "关系",
      "提案与评审",
      "意见回应",
      "报告",
      "裁决",
    ]);
    const identity = div.querySelector("[data-testid='decision-identity-strip']");
    expect(identity?.textContent).toContain("dec_1");
    expect(identity?.textContent).toContain("software-coding · plt-gui");

    const poolBtn = [...div.querySelectorAll("button")].find((b) => b.textContent === "在决策池查看")!;
    await act(async () => {
      poolBtn.click();
    });
    expect(onOpenPool).toHaveBeenCalledWith("dec_1");
    const graphBtn = [...div.querySelectorAll("button")].find((b) => b.textContent === "在关系图中查看")!;
    await act(async () => {
      graphBtn.click();
    });
    expect(onFocusGraph).toHaveBeenCalledWith("decision/dec_1");
  });

  it("概况/承重与裁决/关系分页签渲染决策结构信息", async () => {
    stubOverviewWindow();
    const div = await mountDecisionView(decisionRow());

    const clickTab = async (label: string) => {
      const tab = [...div.querySelectorAll('[role="tab"]')].find((node) => node.textContent?.trim() === label)!;
      await act(async () => {
        tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };
    await clickTab("概况");
    expect(div.querySelector("[data-testid='decision-panel-overview']")?.textContent).toContain("复用集合投影");
    expect(div.querySelector("[data-testid='decision-panel-overview']")?.textContent).toContain("直读 Markdown");
    await clickTab("承重与裁决");
    expect(div.querySelector("[data-testid='decision-panel-claims']")?.textContent).toContain(
      "正文必须经单体 read 取回",
    );
    expect(div.querySelector("[data-testid='decision-panel-claims']")?.textContent).toContain("djc_1");
    await clickTab("关系");
    const relationsText = div.querySelector("[data-testid='decision-panel-relations']")?.textContent ?? "";
    expect(relationsText).toContain("task/task_a");
    expect(relationsText).toContain("fact/F-001");
  });

  it("页签栏是 Tabs 原语,与持久的 TabPanel 配对;页签仍按 id 可达", async () => {
    stubOverviewWindow();
    const onLocate = vi.fn();
    const div = await mountDecisionView(decisionRow(), { onLocate });

    const tablist = div.querySelector('[role="tablist"]')!;
    // 下划线式共享标签栏(标准 §4):不再有本页自写的 nav。
    expect(tablist.className).toContain("gap-[18px]");
    expect(tablist.getAttribute("aria-label")).toBe("Decision 详情分区");
    const panel = div.querySelector('[role="tabpanel"]')!;
    expect(panel.id).toBe("decision-panel");
    for (const tab of tablist.querySelectorAll('[role="tab"]'))
      expect(tab.getAttribute("aria-controls")).toBe("decision-panel");
    expect(div.querySelector("#decision-tab-body")?.getAttribute("aria-selected")).toBe("true");
    expect(panel.getAttribute("aria-labelledby")).toBe("decision-tab-body");

    await act(async () => {
      div.querySelector<HTMLElement>("#decision-tab-overview")!.click();
    });
    expect(div.querySelector("#decision-tab-overview")?.getAttribute("aria-selected")).toBe("true");
    // 同一个面板跨页签持久(入场动效挂在它上面),只换 aria-labelledby 与内容。
    expect(div.querySelector('[role="tabpanel"]')).toBe(panel);
    expect(panel.getAttribute("aria-labelledby")).toBe("decision-tab-overview");
    expect(onLocate).toHaveBeenLastCalledWith("decision/dec_1");
    await act(async () => {
      div.querySelector<HTMLElement>("#decision-tab-judge")!.click();
    });
    expect(onLocate).toHaveBeenLastCalledWith("decisionreview/dec_1/judge");
  });

  it("概况是区域板:问题/已选/已否在区域框里,选项是两行条目,时间线在板的最后一列", async () => {
    stubOverviewWindow();
    const div = await mountDecisionView(
      decisionRow({
        chosen: [{ id: "CH1", text: "复用集合投影", rationale: "读径只有一条", evidence: [] }],
        review: {
          reviews: [
            {
              reviewId: "rev_1",
              reviewContentDigest: "sha256:aa",
              verdict: "changes_requested",
              reason: "缺证据",
              findings: [],
              evidenceChecked: [],
              reportRef: null,
              actor: { principal: { personId: "person-ceo" }, executor: { kind: "agent", id: "reviewer-1" } },
              reviewedAt: "2026-08-01T06:00:00.000Z",
            },
          ],
          responses: [],
          overrides: [],
          currentDigest: null,
          readiness: null,
          dispatches: null,
        } as DecisionRow["review"],
      }),
    );
    await act(async () => {
      div.querySelector<HTMLElement>("#decision-tab-overview")!.click();
    });
    const panel = div.querySelector("[data-testid='decision-panel-overview']")!;
    // 面板是板的容器量尺,并在宽时给板确定高度(RegionBoard 的宿主约定)。
    expect(panel.className).toContain("@container");
    expect(panel.className).toContain("flex-col");
    const board = panel.querySelector("[data-testid='decision-overview-board']")!;
    expect(board.parentElement).toBe(panel);
    expect([...board.querySelectorAll<HTMLElement>("[data-region]")].map((box) => box.dataset.region)).toEqual([
      "question",
      "chosen",
      "rejected",
      "timeline",
    ]);
    // 每个区域外框里都是一个 Region;板上没有区域框之外的内容,也没有自写的边框块。
    for (const box of board.querySelectorAll("[data-region]"))
      expect(box.firstElementChild?.matches("section[data-entry-region]")).toBe(true);
    expect(panel.querySelector(".rounded-md")).toBeNull();
    expect(board.lastElementChild).toBe(panel.querySelector("[data-testid='decision-overview-timeline']"));

    const region = (key: string) => board.querySelector(`[data-region='${key}']`)!;
    expect([...board.querySelectorAll("h2")].map((title) => title.textContent)).toEqual([
      "问题",
      "已选",
      "已否",
      "时间线",
    ]);
    expect(region("question").querySelector("[data-dense-row]")?.textContent).toBe("走哪条读径?");
    // 选项是 DenseRow 宽松两行:标题 = 选项,第二行 = 理由;编号在右侧。
    const chosen = region("chosen").querySelectorAll("[data-dense-row]");
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.className).toContain("min-h-14");
    expect(chosen[0]!.textContent).toBe("复用集合投影读径只有一条CH1");
    const rejected = region("rejected").querySelectorAll("[data-dense-row]");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.textContent).toBe("直读 Markdown绕开 canonical 投影RJ1");

    // 时间线:提出、评审、裁决 consent,以及与 consent 不同刻的 decidedAt,新的在上。
    const timeline = region("timeline");
    expect(timeline.querySelector("h2")?.nextElementSibling?.textContent).toBe("4");
    const entries = [...timeline.querySelectorAll("[data-day] > div > *")].map((row) => row.textContent);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toContain("human:person-ceo");
    // 状态词与页头徽章同源(decisionStateLabel),不在这里另写一份词表。
    expect(entries[0]).toContain(decisionStateLabel("in_effect"));
    expect(entries[1]).toContain("agent:reviewer-1");
    expect(entries[1]).toContain("请求修改");
    expect(entries.slice(2).join("|")).toContain("提出");
  });

  it("概况的时间线不重复列与 consent 同刻的 decidedAt;空区域整块不出现", async () => {
    stubOverviewWindow();
    const div = await mountDecisionView(
      decisionRow({ chosen: [], proposedAt: "2026-07-30T00:00:00.000Z", decidedAt: "2026-08-01T00:00:00.000Z" }),
    );
    await act(async () => {
      div.querySelector<HTMLElement>("#decision-tab-overview")!.click();
    });
    const board = div.querySelector("[data-testid='decision-overview-board']")!;
    expect([...board.querySelectorAll<HTMLElement>("[data-region]")].map((box) => box.dataset.region)).toEqual([
      "question",
      "rejected",
      "timeline",
    ]);
    expect(board.querySelectorAll("[data-region='timeline'] [data-day] > div > *")).toHaveLength(2);
  });
});

describe("splitMarkdownBlocks", () => {
  it("按空行分块,围栏代码块内的空行不切", () => {
    const source = "# 标题\n\n第一段。\n\n```\n代码内\n\n空行\n```\n\n结尾段。";
    expect(splitMarkdownBlocks(source)).toEqual(["# 标题", "第一段。", "```\n代码内\n\n空行\n```", "结尾段。"]);
  });

  it("纯空白输入得到空数组", () => {
    expect(splitMarkdownBlocks("")).toEqual([]);
    expect(splitMarkdownBlocks("\n\n  \n")).toEqual([]);
  });
});
