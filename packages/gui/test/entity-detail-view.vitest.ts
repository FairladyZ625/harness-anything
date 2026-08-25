// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FactDetailView } from "../src/renderer/views/EntityDetailView.tsx";
import { DecisionDetailView } from "../src/renderer/components/decisionDetail/DecisionDetailView.tsx";
import { splitMarkdownBlocks } from "../src/renderer/components/decisionDetail/DecisionBodyPanel.tsx";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";
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
    module: "gui",
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
  } as DecisionRow;
}

const facts: FactRef[] = [
  {
    anchor: "task_a/F-001",
    taskId: "task_a",
    category: "finding",
    text: "GUI 收到了事件派生的三元行。",
    at: "2026-08-01T00:00:00.000Z",
  },
];

const relations: RelationEdge[] = [
  { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
  { from: "decision/dec_1/CH1", to: "fact/task_a/F-001", kind: "evidenced-by", provenance: "local-document" },
  { from: "task/task_a", to: "fact/task_a/F-001", kind: "produces", provenance: "local-document" },
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
        factRef: "fact/task_a/F-001",
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
        factRef: "fact/task_a/F-001",
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
        factRef: "fact/task_b/F-002",
        facts: [],
        tasks: [task("task_b", "任务B")],
        decisions: [],
        relations: [],
        factAnchors: [{ factRef: "fact/task_b/F-002", taskId: "task_b", factId: "F-002" }],
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
        factRef: "fact/task_a/F-001",
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
        factRef: "fact/task_c/F-404",
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
        factRef: "fact/task_c/F-404",
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

  it("身份条与四个分页签齐备;池/图出口带决策 ID", async () => {
    vi.stubGlobal("window", { harness: { showDecision: vi.fn(async () => showReceipt(PROSE)) } });
    const onOpenPool = vi.fn(),
      onFocusGraph = vi.fn();
    const div = await mountDecisionView(decisionRow(), { onOpenPool, onFocusGraph });

    expect([...div.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual([
      "正文",
      "概况",
      "承重与裁决",
      "关系",
    ]);
    const identity = div.querySelector("[data-testid='decision-identity-strip']");
    expect(identity?.textContent).toContain("dec_1");
    expect(identity?.textContent).toContain("software-coding · plt-gui");

    const poolBtn = [...div.querySelectorAll("button")].find((b) => b.textContent === "在决策池查看")!;
    await act(async () => {
      poolBtn.click();
    });
    expect(onOpenPool).toHaveBeenCalledWith("dec_1");
    const graphBtn = [...div.querySelectorAll("button")].find((b) => b.textContent === "在关系图聚焦")!;
    await act(async () => {
      graphBtn.click();
    });
    expect(onFocusGraph).toHaveBeenCalledWith("decision/dec_1");
  });

  it("概况/承重与裁决/关系分页签渲染决策结构信息", async () => {
    vi.stubGlobal("window", { harness: { showDecision: vi.fn(async () => showReceipt(PROSE)) } });
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
    expect(relationsText).toContain("fact/task_a/F-001");
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
