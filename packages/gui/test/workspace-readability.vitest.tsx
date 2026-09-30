// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CadenceFeedEvent } from "../src/renderer/model/cadence.ts";
import type { WorkspaceScopeRead } from "../src/api/renderer-dto.ts";
import type { DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";

/**
 * S6 可读性判据(真实台账下三处读不懂的修后契约),落在原型 v2 的新标签上:
 *  - 检修页:事件 type 说人话、任务显示标题(原始 id 退到悬停)、
 *    「没有可读 payload」整段至多一句,不再逐行重复;不认识的 type 如实显示原名;
 *  - 决策与事实页:事实长无空格串在自己的列内断行,列不被 min-content 顶开。
 * 事件窗口用 scope 摘要注入(服务端按工作取窗,前端不再拉全仓事件)。
 */

import { setActiveLocale } from "../src/renderer/i18n/core.ts";
beforeEach(() => setActiveLocale("zh-CN"));

const FEED_EVENTS: CadenceFeedEvent[] = [];

const { WorkspaceView } = await import("../src/renderer/views/WorkspaceView.tsx");

const MEMBER = "task_5d40f42b8fba623de6c5c7984c",
  MEMBER_TITLE = "解耦：消除 GUI 对 Daemon 源码的相对路径穿透",
  // 真实台账里把证据列撑穿的那种长无空格串。
  LONG_RUN = "start/progress.append/submit/complete/adjudicate/consent/forward/CreateReplayTask",
  FACT_ANCHOR = "fact/F-7E08BD10";

const event = (type: string, summary: string | null): CadenceFeedEvent => ({
  key: `${type}:${summary ?? "index-only"}`,
  type,
  at: "2026-09-21T01:53:00.000Z",
  revision: 9,
  taskId: MEMBER,
  factId: null,
  decisionId: null,
  executorId: null,
  touchedPaths: [],
  gateId: null,
  gateResult: null,
  reviewVerdict: null,
  summary,
});

const scopeRow = (taskId: string, title: string) =>
  ({
    taskId,
    title,
    status: "active",
    taskClass: "implementation",
    parentTaskId: null,
    updatedAt: "2026-09-21T01:53:00.000Z",
    pinned: false,
    hasChildren: false,
  }) as const;

function scope(): WorkspaceScopeRead {
  return {
    schema: "daemon.workspace-scope/v1",
    ok: true,
    status: "ready",
    root: scopeRow("task_002ff91f79fa621b9bb0421439", "统一工作体验"),
    ancestors: [],
    goalMaterial: null,
    counts: { done: 0, executing: 1, pending: 0, blocked: 0, planned: 0, cancelled: 0 },
    scope: { descendantCount: 1, executableLeafCount: 1, archivedCount: 0 },
    groups: [],
    memberTaskIds: [MEMBER],
    eventSummaries: FEED_EVENTS.map((item) => ({
      eventId: item.key,
      schema: "task-event/v1",
      type: item.type,
      occurredAt: item.at!,
      workspaceRevision: item.revision!,
      taskId: item.taskId!,
      payload: item.summary === null ? {} : { text: item.summary },
    })),
    eventWindowComplete: true,
    tasks: [scopeRow(MEMBER, MEMBER_TITLE)],
    page: { limit: 100, cursor: null, nextCursor: null },
    incompleteParentRefs: [],
    watermark: 9,
    sourceRevision: 9,
    warnings: [],
  };
}

const facts: FactRef[] = [
  {
    anchor: FACT_ANCHOR,
    taskId: MEMBER,
    category: "finding",
    text: `GUI 写面 allowlist 的闭合 facet 表不含任务创建 ingress：task 相关只有 ${LONG_RUN}`,
    at: "2026-09-21T01:45:00.000Z",
    confidence: "high",
  },
];

const relations: RelationEdge[] = [
  {
    relationId: "rel-1",
    from: `task/${MEMBER}`,
    to: FACT_ANCHOR,
    kind: "produces",
    provenance: "local-document",
  },
];

function render(tab: "inspect" | "decisions", inspect?: (host: HTMLDivElement) => void): string {
  const host = document.createElement("div"),
    root = createRoot(host);
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceView
          scope={scope()}
          repoId="harness-anything"
          projectName="harness-anything"
          facts={facts}
          relations={relations}
          onOpenTask={() => {}}
        />
      </QueryClientProvider>,
    ),
  );
  act(() => (host.querySelector(`#workspace-tab-${tab}`) as HTMLButtonElement).click());
  inspect?.(host);
  const html = host.innerHTML;
  act(() => root.unmount());
  return html;
}

/** 取出某个区块的 html(区块之间互不干扰地断言)。 */
function sectionOf(html: string, labelledBy: string): string {
  const start = html.indexOf(`<section`, html.indexOf(`aria-labelledby="${labelledBy}"`) - 200);
  expect(start, `section not rendered: ${labelledBy}`).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

/** 只留下用户真正读到的字:属性值(含 title 悬停)全部剥掉。 */
function visibleText(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, " ").replaceAll(/\s+/gu, " ");
}

describe("workspace readability under real ledger shapes", () => {
  it("groups dates in the same selected time zone as event times", () => {
    localStorage.setItem("harness:gui:time-zone", "Asia/Taipei");
    try {
      FEED_EVENTS.length = 0;
      FEED_EVENTS.push(
        { ...event("execution_submitted", null), key: "a", at: "2026-09-20T23:00:00.000Z" },
        { ...event("execution_submitted", null), key: "b", at: "2026-09-21T01:00:00.000Z" },
      );
      render("inspect", (host) => {
        const days = host.querySelectorAll('section[aria-labelledby="workspace-history"] li > p');
        expect(days).toHaveLength(1);
        expect(days[0]!.textContent).toBe("2026-09-21");
      });
    } finally {
      localStorage.removeItem("harness:gui:time-zone");
    }
  });

  it("keeps all window events reachable in bounded pages", () => {
    FEED_EVENTS.length = 0;
    FEED_EVENTS.push(
      ...Array.from({ length: 85 }, (_, i) => ({ ...event("execution_submitted", `record-${i}`), key: `event-${i}` })),
    );
    render("inspect", (host) => {
      const history = host.querySelector('section[aria-labelledby="workspace-history"]')!;
      expect(history.querySelectorAll("li")).toHaveLength(40);
      expect(history.textContent).toContain("record-84");
      const next = history.querySelector<HTMLButtonElement>("nav button:last-child")!;
      act(() => next.click());
      expect(history.querySelectorAll("li")).toHaveLength(40);
      expect(history.textContent).toContain("record-44");
      act(() => next.click());
      expect(history.querySelectorAll("li")).toHaveLength(5);
      expect(history.textContent).toContain("record-0");
      expect(next.disabled).toBe(true);
    });
  });

  it("keeps the fact list readable on demand without long strings stretching the column", () => {
    FEED_EVENTS.length = 0;
    const host = document.createElement("div"),
      root = createRoot(host),
      onNavigateEntity = vi.fn();
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <WorkspaceView
            scope={scope()}
            repoId="harness-anything"
            projectName="harness-anything"
            facts={facts}
            relations={relations}
            onOpenTask={() => {}}
            onNavigateEntity={onNavigateEntity}
          />
        </QueryClientProvider>,
      ),
    );
    act(() => (host.querySelector("#workspace-tab-decisions") as HTMLButtonElement).click());
    const factRow = host.querySelector<HTMLButtonElement>('[data-fact-row="fact/F-7E08BD10"] button')!;
    // 长无空格串在自己的列内截断,列不被 min-content 顶开;点行进抽屉看全文。
    expect(factRow.textContent).toContain("GUI 写面 allowlist");
    expect(factRow.querySelector("span.truncate")).not.toBeNull();
    act(() => factRow.click());
    const detail = host.querySelector('[data-testid="work-fact-detail"]')!;
    expect(detail.textContent).toContain("完整原文");
    expect(detail.textContent).toContain(LONG_RUN);
    act(() => (host.querySelector('[data-testid="work-fact-open-detail"]') as HTMLButtonElement).click());
    expect(onNavigateEntity).toHaveBeenCalledWith("fact/F-7E08BD10");
    act(() => root.unmount());
  });

  it("groups facts by owning task, collapses older groups behind one line, and summarizes on top", () => {
    FEED_EVENTS.length = 0;
    const sha = "3c6e75936ad4a368edd8be89590ab12c3d4e5f60",
      members = ["task_a", "task_b", "task_c", "task_d", "task_e"],
      digestScope = {
        ...scope(),
        memberTaskIds: members,
        tasks: members.map((taskId) => scopeRow(taskId, `组 ${taskId}`)),
      },
      digestFacts: FactRef[] = [
        ...members.map((taskId, index) => ({
          anchor: `fact/F-${index}`,
          taskId,
          category: "finding" as const,
          text: `At commit ${sha} 后 ${taskId} 门禁绿了;复测三次。`,
          at: `2026-09-2${members.length - index}T08:00:00.000Z`,
          confidence: "high" as const,
        })),
        { ...facts[0]!, anchor: "fact/F-related", taskId: undefined, at: "2026-09-30T12:00:00.000Z" },
      ],
      // 无任务归属的事实由关系边连入工作,否则读面收束时会被过滤。
      digestRelations: RelationEdge[] = [
        ...relations,
        {
          relationId: "rel-related",
          from: "task/task_a",
          to: "fact/F-related",
          kind: "produces",
          provenance: "local-document",
        },
      ],
      host = document.createElement("div"),
      root = createRoot(host);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <WorkspaceView
            scope={digestScope}
            repoId="harness-anything"
            projectName="harness-anything"
            facts={digestFacts}
            relations={digestRelations}
            onOpenTask={() => {}}
          />
        </QueryClientProvider>,
      ),
    );
    act(() => (host.querySelector("#workspace-tab-decisions") as HTMLButtonElement).click());
    // 顶部摘要:条数、任务数、最近一条。
    expect(host.textContent).toContain("6 条事实，来自 5 个任务");
    // 6 组只展开最近 3 组,其余收进一行「更早 3 组 · 展开」。
    expect(host.querySelectorAll("[data-fact-group]")).toHaveLength(3);
    const older = host.querySelector<HTMLButtonElement>('[data-testid="work-facts-older-toggle"]')!;
    expect(older.textContent).toContain("更早 3 组 · 展开");
    act(() => older.click());
    expect(host.querySelectorAll("[data-fact-group]")).toHaveLength(6);
    // 组标题用任务标题;行只露结论句,40 位 SHA 缩到 7 位。
    expect(host.querySelector('[data-fact-group="task_a"]')!.textContent).toContain("组 task_a");
    const row = host.querySelector<HTMLButtonElement>('[data-fact-row="fact/F-0"] button')!;
    expect(row.textContent).toContain("task_a 门禁绿了");
    expect(row.textContent).toContain(sha.slice(0, 7));
    expect(row.textContent).not.toContain(sha);
    act(() => root.unmount());
  });

  it("segments decisions by state and keeps the page search on the decisions tab", () => {
    FEED_EVENTS.length = 0;
    const decision = (decisionId: string, state: DecisionRow["state"], title: string): DecisionRow =>
        ({
          decisionId,
          title,
          state,
          question: "承重选择",
          chosen: [],
          rejected: [],
          claims: [],
          judgmentConsents: [],
          capabilities: {},
          claimsOpen: state === "proposed",
          lastChangedAt: "2026-09-29T08:00:00.000Z",
        }) as DecisionRow,
      host = document.createElement("div"),
      root = createRoot(host);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <WorkspaceView
            scope={scope()}
            repoId="harness-anything"
            projectName="harness-anything"
            facts={facts}
            relations={[
              ...relations,
              // 工作成员与这三条 Decision 有边,决策才进「决策与事实」的口径。
              ...(["dec_effect", "dec_old", "dec_old2"] as const).map((decisionId) => ({
                relationId: `rel-${decisionId}`,
                from: `task/${MEMBER}`,
                to: `decision/${decisionId}`,
                kind: "derives",
                provenance: "local-document",
              })),
            ]}
            decisions={[
              decision("dec_effect", "in_effect", "生效中的决策"),
              decision("dec_old", "superseded", "已取代的决策"),
              decision("dec_old2", "rejected", "已否决的决策"),
            ]}
            onOpenTask={() => {}}
          />
        </QueryClientProvider>,
      ),
    );
    act(() => (host.querySelector("#workspace-tab-decisions") as HTMLButtonElement).click());
    // 生效中平铺;已退场折叠成一行计数,点开才平铺。
    expect(host.textContent).toContain("生效中");
    expect(host.textContent).toContain("生效中的决策");
    expect(host.textContent).not.toContain("已取代的决策");
    const retired = host.querySelector<HTMLButtonElement>('[data-testid="work-decisions-retired-toggle"]')!;
    expect(retired.textContent).toContain("2 条已退场 · 展开");
    act(() => retired.click());
    expect(host.textContent).toContain("已取代的决策");
    // 页内搜索停在决策与事实页,命中事实原文(不只结论句)。
    const search = host.querySelector<HTMLInputElement>('[data-testid="workspace-search"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, LONG_RUN);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector("#workspace-tab-decisions")!.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-fact-row="fact/F-7E08BD10"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="work-facts-older-toggle"]')).toBeNull();
    act(() => root.unmount());
  });

  it("says history in plain words, shows task titles, and warns about payload-less rows once", () => {
    FEED_EVENTS.length = 0;
    FEED_EVENTS.push(
      event("execution_submitted", null),
      event("code_doc_reconciled", null),
      event("fact_recorded", "已提交评审并附回执"),
      event("vertical_thing_happened", null),
    );
    const history = sectionOf(render("inspect"), "workspace-history"),
      text = visibleText(history),
      note = "其中部分事件只有索引、没有可读正文";
    expect(text).toContain("已提交评审");
    expect(text).toContain("代码与文档已对账");
    expect(text).toContain("记录了一条事实");
    // 不认识的 type 如实显示原名,不猜。
    expect(text).toContain("vertical_thing_happened");
    // 每行显示任务标题;原始 task id 与原始 type 只留在悬停属性里。
    expect(text).toContain(MEMBER_TITLE);
    expect(text).not.toContain(MEMBER);
    expect(text).not.toContain("execution_submitted");
    expect(history).toContain(`title="execution_submitted · ${MEMBER}"`);
    // 三行没有正文,提示整段只说一次。
    expect(text.split(note).length - 1).toBe(1);
  });
});
