// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { workspaceFlowLayout } from "../src/renderer/components/WorkspaceLocalGraph.tsx";
import { workspaceTitleIndex } from "../src/renderer/model/workspace-readable.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CadenceFeedEvent, CadenceFeedState } from "../src/renderer/model/cadence.ts";
import type { WorkspaceScopeRead } from "../src/api/renderer-dto.ts";
import type { FactRef, RelationEdge } from "../src/renderer/model/types.ts";

/**
 * S6 可读性判据(真实台账下三处读不懂的修后契约):
 *  - 证据与产物三列:长无空格串在自己的列内断行,列不被 min-content 顶开;
 *  - 关键经过:事件 type 说人话、任务显示标题(原始 id 退到悬停)、
 *    「没有可读 payload」整段至多一句,不再逐行重复;不认识的 type 如实显示原名;
 *  - 局部关系图:节点是实体类型 + 标题,边的 kind 说人话,原始引用退到悬停。
 * 事件窗口用固定 feed 替身注入(视图侧的 observe.tail follow 循环不在本判据内)。
 */

import { setActiveLocale } from "../src/renderer/i18n/core.ts";
beforeEach(() => setActiveLocale("zh-CN"));

const FEED_EVENTS: CadenceFeedEvent[] = [];

vi.mock("../src/renderer/cadence-feed.ts", () => ({
  useCadenceFeed: (): CadenceFeedState => ({
    status: "live",
    error: null,
    unavailableReason: null,
    mode: "local",
    events: FEED_EVENTS,
    historyComplete: true,
    now: "2026-09-21T02:00:00.000Z",
  }),
}));

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

function render(): string {
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
          onOpenGroup={() => {}}
        />
      </QueryClientProvider>,
    ),
  );
  act(() => (host.querySelector("#workspace-tab-evidence") as HTMLButtonElement).click());
  const html = host.innerHTML;
  act(() => root.unmount());
  return html;
}

/** 取出某个区块的 html(区块之间互不干扰地断言)。 */
function sectionOf(html: string, labelledBy: string): string {
  const start = html.indexOf(`<section class=`, html.indexOf(`aria-labelledby="${labelledBy}"`) - 200);
  expect(start, `section not rendered: ${labelledBy}`).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

/** 只留下用户真正读到的字:属性值(含 title 悬停)全部剥掉。 */
function visibleText(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, " ").replaceAll(/\s+/gu, " ");
}

/** 抓住包住这段正文的那个元素的 class,用来断言收窄/断行是落在它身上的。 */
function classesAround(html: string, text: string): string {
  const index = html.indexOf(text);
  expect(index, `text not rendered: ${text}`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<", index),
    tag = html.slice(open, index),
    match = /class="([^"]*)"/u.exec(tag);
  return match?.[1] ?? "";
}

describe("workspace readability under real ledger shapes", () => {
  it("keeps a long unbroken run inside its own evidence column", () => {
    FEED_EVENTS.length = 0;
    const html = render(),
      factClasses = classesAround(html, LONG_RUN);
    // 三列容器与列本身都收窄,长串所在的按钮是块级满宽 + 可断行。
    expect(html).toContain('class="mt-3 grid min-w-0 gap-4 md:grid-cols-3"');
    expect(factClasses).toContain("block");
    expect(factClasses).toContain("w-full");
    expect(factClasses).toContain("break-words");
  });

  it("says history in plain words, shows task titles, and warns about payload-less rows once", () => {
    FEED_EVENTS.length = 0;
    FEED_EVENTS.push(
      event("execution_submitted", null),
      event("code_doc_reconciled", null),
      event("fact_recorded", "已提交评审并附回执"),
      event("vertical_thing_happened", null),
    );
    const history = sectionOf(render(), "workspace-history"),
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

  it("labels graph nodes with kind plus title and edges with a spoken relation kind", () => {
    FEED_EVENTS.length = 0;
    const graph = workspaceFlowLayout(
      [MEMBER],
      relations,
      workspaceTitleIndex({ tasks: scope().tasks, facts, decisions: [] }),
      new Set(),
    );
    const labels = graph.nodes.map((node) => node.data.label).join(" ");
    expect(labels).toContain(`任务 · ${MEMBER_TITLE}`);
    expect(labels).toContain("事实 · ");
    expect(graph.edges.map((edge) => edge.label)).toContain("产出");
    expect(labels).not.toContain(MEMBER);
    expect(labels).not.toContain(FACT_ANCHOR);
    expect(graph.edges[0].source).toBe(`task/${MEMBER}`);
  });
});
