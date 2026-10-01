// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import type {
  AgendaAnsweredRow,
  AgendaAwaitsRow,
  AgendaDecisionReviewRow,
  AgendaDecisionRow,
  AgendaExecutionRow,
  AgendaTaskRow,
} from "../src/api/renderer-dto.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { decisionAgendaRows } from "../src/renderer/model/decision-review.ts";
import { AgendaView } from "../src/renderer/views/AgendaView.tsx";
import { NAV_GROUPS, navLabel } from "../src/renderer/navigation/navConfig.tsx";
import { entityDetailTargetOf } from "../src/renderer/navigation/entityRoutes.ts";

/**
 * 议程页(标准 §2.4 列表页)与行落点:行全部取议程读面,FilterChips 带计数 +
 * 页内搜索,默认「需要关注」不默认全量;行用 DenseRow、状态用 StatusTag;点行
 * 开抽屉,抽屉里答复(awaits 源)或「打开完整详情」落 Decision 评审页签、逐项
 * 回应、评审会话、裁决页签与源实体详情。
 */
const AT = "2026-09-29T01:00:00.000Z";
const decisionRow = (decisionId: string): AgendaDecisionRow => ({
  decisionId,
  title: `决策 ${decisionId}`,
  riskTier: "high",
  urgency: "medium",
  proposedAt: AT,
});
const reviewingRow = (
  decisionId: string,
  reviewers: AgendaDecisionReviewRow["reviewers"] = [],
): AgendaDecisionReviewRow => ({ ...decisionRow(decisionId), reviewers });
const awaitsRow = (relationId: string, sourceRef: string): AgendaAwaitsRow => ({
  relationId,
  relationRevision: 1,
  sourceRef,
  title: `提案 ${sourceRef}`,
  status: "proposed",
  personId: "person_me",
  askKind: "consent",
  question: "has review changes to resolve.",
  askedAt: AT,
  askedBy: "person_me",
});
const answeredRow = (relationId: string, sourceRef: string): AgendaAnsweredRow => ({
  relationId,
  sourceRef,
  title: `已答复 ${sourceRef}`,
  status: "active",
  personId: "person_owner",
  askKind: "question",
  question: "接口要不要兼容旧字段?",
  answer: "不兼容，直接删",
  answeredAt: AT,
  answeredBy: "person_owner",
});
const blocking = { state: "clear" } as AgendaTaskRow["blockingAssessment"];
const reworkRow = (taskId: string): AgendaTaskRow => ({
  taskId,
  title: `返工 ${taskId}`,
  work: null,
  status: "active",
  pinned: false,
  updatedAt: AT,
  leaseExecutionId: null,
  activeExecutionIds: [],
  blockingAssessment: blocking,
  workspace: null,
});
const executionRow = (taskId: string): AgendaExecutionRow => ({
  taskId,
  title: `送审 ${taskId}`,
  work: null,
  pinned: false,
  executionId: `exec_${taskId}`,
  submittedAt: AT,
  blockingAssessment: blocking,
});
const agenda = (patch: Partial<AgendaSuccess> = {}): AgendaSuccess => ({
  ok: true,
  status: "ready",
  inFlight: [],
  pinnedEntities: [],
  pinnedEntityOverflow: 0,
  attentionItems: [],
  regionWeights: {
    ci: 0,
    mine: 0,
    stuck: 0,
    run: 0,
    review: 0,
    queue: 0,
    recent: 0,
    works: 0,
  },
  awaitingRework: [],
  awaitingAdjudication: [],
  underReview: [],
  awaitingYou: [],
  answeredForYou: [],
  decisionReviewInProgress: [],
  awaitingDecisionReview: [],
  awaitingDecision: [],
  waitingOnOthers: [],
  dispatchable: [],
  summary: "",
  page: { sourceLimit: 100, cursor: null, nextCursor: null },
  watermark: 7,
  sourceRevision: 7,
  ...patch,
});
const seeded = agenda({
  awaitingYou: [
    awaitsRow("rel_dec", "decision/dec_dispose"),
    awaitsRow("rel_dec_again", "decision/dec_dispose"),
    awaitsRow("rel_task", "task/task_x"),
  ],
  awaitingDecisionReview: [decisionRow("dec_review_a"), decisionRow("dec_review_b")],
  decisionReviewInProgress: [
    reviewingRow("dec_running", [
      { dispatchId: "dispatch_b", reviewer: "独立评审乙", findingCount: 2 },
      { dispatchId: "dispatch_a", reviewer: "独立评审甲", findingCount: null },
    ]),
  ],
  awaitingDecision: [decisionRow("dec_judge")],
});

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(withQueries(element)));
  return container;
}

/** 答复面板的写动作挂在 react-query 上;只渲染不发请求。 */
const withQueries = (element: ReturnType<typeof createElement>) =>
  createElement(QueryClientProvider, { client: new QueryClient() }, element);

const click = (host: HTMLElement, testId: string) => {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`missing ${testId}`);
  act(() => button.click());
};
/** 点议程行:行壳是包装 div,DenseRow 的 button 在里面。 */
const clickRow = (host: HTMLElement, id: string) => {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="agenda-row-${id}"] button`);
  if (!button) throw new Error(`missing agenda-row-${id}`);
  act(() => button.click());
};
const typeInto = (input: HTMLInputElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const rowIds = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-testid^="agenda-row-"]')].map((node) =>
    node.getAttribute("data-testid")!.replace("agenda-row-", ""),
  );

describe("议程读面 → Decision 行", () => {
  it("按待处置/待评审/评审中/待裁决排列;同一 Decision 的多条 awaits 只列一次,Task 行不入", () => {
    expect(decisionAgendaRows(seeded).map(({ decisionId, group }) => `${group}:${decisionId}`)).toEqual([
      "dispose:dec_dispose",
      "review:dec_review_a",
      "review:dec_review_b",
      "reviewing:dec_running",
      "judge:dec_judge",
    ]);
  });
});

describe("议程页(标准 §2.4 列表页)", () => {
  it("侧栏只有一个总览入口(dec_DC3A1BB9 CH1)", () => {
    const ids = NAV_GROUPS.flatMap((group) => group.items.map(({ id }) => id));
    expect(ids.filter((id) => id.startsWith("overview"))).toEqual(["overview"]);
    expect(ids.map(navLabel).filter((label) => label.startsWith("总览"))).toEqual(["总览"]);
  });

  it("左侧导航在「工作」之后有「议程」一项", () => {
    const items = NAV_GROUPS.find((group) => group.id === "workspace")!.items.map(({ id }) => id);
    expect(items.indexOf("agenda")).toBe(items.indexOf("work") + 1);
    expect(navLabel("agenda")).toBe("议程");
  });

  it("筛选按钮带计数且默认「需要关注」,不默认展示全量;空组不渲染", () => {
    const host = mount(
      createElement(AgendaView, {
        repoId: "repo",
        agenda: seeded,
        agendaError: null,
        onNavigateEntity: () => {},
      }),
    );
    const chips = [...host.querySelectorAll('[data-testid="agenda-filter-chips"] button')];
    expect(chips.map((chip) => chip.textContent)).toEqual(["需要关注5", "待跟进1", "全部6"]);
    expect(chips[0]!.getAttribute("aria-pressed")).toBe("true");
    // 默认(需要关注):dispose/review/judge 的行都在,reviewing(待跟进)不出现。
    expect(rowIds(host)).toEqual(["rel_task", "dec_dispose", "dec_review_a", "dec_review_b", "dec_judge"]);
    act(() => chips[2]!.click());
    expect(rowIds(host)).toEqual([
      "rel_task",
      "dec_dispose",
      "dec_review_a",
      "dec_review_b",
      "dec_judge",
      "dec_running",
    ]);
  });

  it("页头与筛选行统一摆法(标准 §2.3):裸页头一行,筛选靠左、搜索在右占满剩余", () => {
    const host = mount(
      createElement(AgendaView, {
        repoId: "repo",
        agenda: seeded,
        agendaError: null,
        onNavigateEntity: () => {},
      }),
    );
    // 页头是裸行:不带边框、面板底色或玻璃;页名与计数同行。
    const header = host.querySelector('[data-testid="agenda-view"] > header') as HTMLElement;
    expect(header.className).not.toContain("border");
    expect(header.className).not.toContain("bg-");
    expect(header.querySelector("h1")?.className).toContain("text-xl");
    expect(header.querySelector('[data-testid="agenda-count"]')).toBeTruthy();
    // 筛选行:筛选按钮在搜索框之前(DOM 序),搜索占满剩余宽度。
    const filterRow = header.nextElementSibling as HTMLElement;
    const chips = filterRow.querySelector('[data-testid="agenda-filter-chips"]')!;
    const search = filterRow.querySelector('[data-testid="agenda-search"]')!;
    expect(chips.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(search.className).toContain("flex-1");
  });

  it("行是 DenseRow:状态用有底色 StatusTag、标题经 TitleText 拆分、原因与时长同行", () => {
    const host = mount(
      createElement(AgendaView, {
        repoId: "repo",
        agenda: seeded,
        agendaError: null,
        onNavigateEntity: () => {},
      }),
    );
    const row = host.querySelector('[data-testid="agenda-row-rel_task"]')!;
    const tag = row.querySelector("[data-status-tone]")!;
    expect(tag.getAttribute("data-status-tone")).toBe("bad"); // 待处置 = 等你,红档
    expect(tag.textContent).toContain("待处置");
    // 标题拆分:「提案 task/task_x」冒号前不足 4 字符,整条按原文渲染(不私拆)。
    expect(row.textContent).toContain("提案 task/task_x");
    expect(row.textContent).toContain("请你同意 · has review changes to resolve.");
    expect(row.textContent).toMatch(/\d+\s*(分|时|天)/u); // 右侧等宽时长
    const colonHost = mount(
      createElement(AgendaView, {
        repoId: "repo",
        agenda: agenda({
          awaitingDecisionReview: [{ ...decisionRow("dec_split"), title: "重构看板:按状态分列" }],
        }),
        agendaError: null,
        onNavigateEntity: () => {},
      }),
    );
    const title = colonHost.querySelector('[data-testid="agenda-row-dec_split"]')!;
    expect(title.textContent).toBe("待评审重构看板:按状态分列· 需要当前内容的一次独立评审"); // TitleText 不丢字
    expect(title.querySelector(".text-text-faint")?.textContent).toBe(":按状态分列"); // 冒号后补充弱色
  });

  it("点行打开抽屉;awaitingYou 行在抽屉里就地答复,decision 行给「打开完整详情」落评审页签", () => {
    const opened: string[] = [];
    const host = mount(
      createElement(AgendaView, {
        repoId: "repo",
        agenda: seeded,
        agendaError: null,
        onNavigateEntity: (ref) => opened.push(ref),
      }),
    );
    clickRow(host, "rel_task");
    let dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toMatch(/已等待\s*\d+\s*(分|时|天)/u);
    expect(dialog?.textContent).toContain("提案 task/task_x");
    expect(dialog?.textContent).toContain("has review changes to resolve.");
    click(host, "agenda-drawer-answer");
    const panel = document.body.querySelector('[data-testid="awaits-answer-panel"]');
    expect(panel?.textContent).toContain("has review changes to resolve.");
    expect(opened).toEqual([]);

    // reviewing(待跟进桶)切到「全部」后可达。
    act(() => [...host.querySelectorAll('[data-testid="agenda-filter-chips"] button')][2]!.click());
    for (const id of ["dec_running", "dec_dispose", "dec_review_a", "dec_judge"]) {
      clickRow(host, id);
      dialog = host.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      click(host, "agenda-drawer-open");
    }
    expect(opened).toEqual([
      "decisionsessions/dec_running",
      "decisionreview/dec_dispose/respond",
      "decisionreview/dec_review_a/review",
      "decisionreview/dec_judge/judge",
    ]);
  });

  it("已答复待跟进落源实体详情,评审返回 / 待初审 / 任务评审中落任务详情的评审(收口)页签", () => {
    const opened: string[] = [];
    const host = mount(
      createElement(AgendaView, {
        repoId: "repo",
        agenda: agenda({
          answeredForYou: [
            answeredRow("rel_ans_task", "task/task_asked"),
            answeredRow("rel_ans_dec", "decision/dec_asked"),
          ],
          awaitingRework: [reworkRow("task_rework")],
          awaitingAdjudication: [executionRow("task_submitted")],
          underReview: [executionRow("task_in_review")],
        }),
        agendaError: null,
        onNavigateEntity: (ref) => opened.push(ref),
      }),
    );
    // 默认「需要关注」:answered 与 taskReviewing(评审中,等别人)都在「待跟进」桶。
    expect(rowIds(host)).toEqual(["task_rework", "task_submitted"]);
    const answered = mount(
      createElement(AgendaView, {
        repoId: "repo",
        agenda: agenda({
          answeredForYou: [
            answeredRow("rel_ans_task", "task/task_asked"),
            answeredRow("rel_ans_dec", "decision/dec_asked"),
          ],
        }),
        agendaError: null,
        onNavigateEntity: (ref) => opened.push(ref),
      }),
    );
    // answered(待跟进桶)切到「全部」后可达。
    act(() => [...answered.querySelectorAll('[data-testid="agenda-filter-chips"] button')][2]!.click());
    const answeredRow0 = answered.querySelector('[data-testid="agenda-row-rel_ans_task"]')!;
    expect(answeredRow0.textContent).toContain("已答复 task/task_asked");
    expect(answeredRow0.textContent).toContain("待跟进");
    expect(answeredRow0.textContent).toContain("答复者 person_owner");
    expect(answeredRow0.textContent).toContain("答:不兼容，直接删");
    expect(answeredRow0.querySelector('[data-status-tone="wait"]')).not.toBeNull();
    for (const id of ["rel_ans_task", "rel_ans_dec"]) {
      clickRow(answered, id);
      click(answered, "agenda-drawer-open");
    }
    // taskReviewing(待跟进桶)同样切「全部」后可达。
    act(() => [...host.querySelectorAll('[data-testid="agenda-filter-chips"] button')][2]!.click());
    for (const id of ["task_rework", "task_submitted", "task_in_review"]) {
      clickRow(host, id);
      click(host, "agenda-drawer-open");
    }
    expect(opened).toEqual([
      "task/task_asked",
      "decision/dec_asked",
      "taskreview/task_rework",
      "taskreview/task_submitted",
      "taskreview/task_in_review",
    ]);
    // 议程为空的判定覆盖新分组:只有这些组有行时不显示「没有待推进」。
    expect(host.textContent).not.toContain("没有待推进");
  });

  it("页内搜索跨筛选桶匹配标题或原因", () => {
    const host = mount(
      createElement(AgendaView, {
        repoId: "repo",
        agenda: seeded,
        agendaError: null,
        onNavigateEntity: () => {},
      }),
    );
    const search = host.querySelector<HTMLInputElement>('[data-testid="agenda-search"]')!;
    typeInto(search, "has review changes");
    expect(rowIds(host)).toEqual(["rel_task"]); // 匹配原因(问题原文)
    // 搜索覆盖筛选桶:reviewing 行(待跟进桶)在默认「需要关注」下也能搜到。
    typeInto(search, "dec_running");
    expect(rowIds(host)).toEqual(["dec_running"]);
    typeInto(search, "不存在的内容");
    expect(rowIds(host)).toEqual([]);
    expect(host.textContent).toContain("没有待推进的事项");
  });

  it("taskreview/<id> 落任务详情并带评审页签;工作根仍按「根任务即工作」进工作页", () => {
    expect(entityDetailTargetOf("taskreview/task_rework")).toEqual({
      selectedId: "task_rework",
      focusedEntityRef: "taskreview/task_rework",
    });
    expect(entityDetailTargetOf("taskreview/task_root", [], (id) => id === "task_root")).toEqual({
      view: "workspace",
      scopeRootTaskId: "task_root",
      focusedEntityRef: null,
    });
    expect(entityDetailTargetOf("taskreview/")).toBeNull();
  });

  it("议程没读到、读失败、追赶中各自说明,不把空当成没有", () => {
    const loading = mount(
      createElement(AgendaView, { repoId: "repo", agenda: undefined, agendaError: null, onNavigateEntity: () => {} }),
    );
    expect(loading.textContent).toContain("正在读取议程");
    expect(rowIds(loading)).toEqual([]);
    act(() =>
      root!.render(
        withQueries(
          createElement(AgendaView, {
            repoId: "repo",
            agenda: undefined,
            agendaError: "boom",
            onNavigateEntity: () => {},
          }),
        ),
      ),
    );
    expect(loading.textContent).toContain("议程读取失败：boom");
    act(() =>
      root!.render(
        withQueries(
          createElement(AgendaView, {
            repoId: "repo",
            agenda: { ...seeded, status: "pending", page: { sourceLimit: 100, cursor: null, nextCursor: "c2" } },
            agendaError: null,
            onNavigateEntity: () => {},
          }),
        ),
      ),
    );
    expect(loading.textContent).toContain("正在追赶台账切面(r7)");
  });
});
