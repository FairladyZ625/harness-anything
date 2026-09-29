// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import type { AgendaAwaitsRow, AgendaDecisionReviewRow, AgendaDecisionRow } from "../src/api/renderer-dto.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import {
  decisionAgendaRows,
  decisionTileTarget,
  type DecisionTileTarget,
} from "../src/renderer/model/decision-review.ts";
import { AgendaView } from "../src/renderer/views/AgendaView.tsx";
import { DecisionReviewTiles } from "../src/renderer/components/overview/DecisionReviewTiles.tsx";
import { DecisionReviewNow } from "../src/renderer/components/overview/DecisionReviewNow.tsx";
import { NAV_GROUPS, navLabel } from "../src/renderer/navigation/navConfig.tsx";

/**
 * 议程页(原型 S2 #agenda)、总览「需要我的判断 / 正在发生」(S1)与四格落点(设计 Q6):
 * 行全部取议程读面,落点按组分流到 Decision 评审页签、逐项回应、裁决页签与评审会话。
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
const agenda = (patch: Partial<AgendaSuccess> = {}): AgendaSuccess => ({
  ok: true,
  status: "ready",
  inFlight: [],
  pinnedEntities: [],
  pinnedEntityOverflow: 0,
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
  act(() => root!.render(element));
  return container;
}

const click = (host: HTMLElement, testId: string) => {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`missing ${testId}`);
  act(() => button.click());
};
const groupIds = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-testid^="agenda-decision-group-"]')].map((node) =>
    node.getAttribute("data-testid")!.replace("agenda-decision-group-", ""),
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

  it("四格落点:恰好一行直达那一行,否则评审中进会话页、其余进议程页", () => {
    const rows = decisionAgendaRows(seeded);
    expect(decisionTileTarget("dispose", rows)).toEqual({
      kind: "entity",
      ref: "decisionreview/dec_dispose/respond",
    });
    expect(decisionTileTarget("review", rows)).toEqual({ kind: "view", view: "agenda" });
    expect(decisionTileTarget("reviewing", rows)).toEqual({ kind: "entity", ref: "decisionsessions/dec_running" });
    expect(decisionTileTarget("judge", rows)).toEqual({ kind: "entity", ref: "decisionreview/dec_judge/judge" });
    const many = decisionAgendaRows(
      agenda({ decisionReviewInProgress: [reviewingRow("dec_r1"), reviewingRow("dec_r2")] }),
    );
    expect(decisionTileTarget("reviewing", many)).toEqual({ kind: "view", view: "sessions" });
    expect(decisionTileTarget("dispose", many)).toEqual({ kind: "view", view: "agenda" });
  });
});

describe("议程页(S2 #agenda)", () => {
  it("左侧导航在「工作」之后有「议程」一项", () => {
    const items = NAV_GROUPS.find((group) => group.id === "workspace")!.items.map(({ id }) => id);
    expect(items.indexOf("agenda")).toBe(items.indexOf("work") + 1);
    expect(navLabel("agenda")).toBe("议程");
  });

  it("五个页签,全部页按四组列行;页签只改当前显示;查看按组落点", () => {
    const opened: string[] = [];
    const host = mount(
      createElement(AgendaView, { agenda: seeded, agendaError: null, onNavigateEntity: (ref) => opened.push(ref) }),
    );
    expect([...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      "全部",
      "待处置",
      "待评审",
      "评审中",
      "待裁决",
    ]);
    expect(groupIds(host)).toEqual(["dispose", "review", "reviewing", "judge"]);
    expect(host.querySelector('[data-testid="agenda-decision-group-review"]')?.textContent).toContain("2 项");

    click(host, "agenda-decision-tab-reviewing");
    expect(groupIds(host)).toEqual(["reviewing"]);

    click(host, "agenda-decision-open-dec_running");
    click(host, "agenda-decision-tab-all");
    for (const id of ["dec_dispose", "dec_review_a", "dec_judge"]) click(host, `agenda-decision-open-${id}`);
    expect(opened).toEqual([
      "decisionsessions/dec_running",
      "decisionreview/dec_dispose/respond",
      "decisionreview/dec_review_a/review",
      "decisionreview/dec_judge/judge",
    ]);
  });

  it("议程没读到、读失败、追赶中各自说明,不把空当成没有", () => {
    const loading = mount(
      createElement(AgendaView, { agenda: undefined, agendaError: null, onNavigateEntity: () => {} }),
    );
    expect(loading.textContent).toContain("正在读取议程");
    expect(groupIds(loading)).toEqual([]);
    act(() =>
      root!.render(createElement(AgendaView, { agenda: undefined, agendaError: "boom", onNavigateEntity: () => {} })),
    );
    expect(loading.textContent).toContain("议程读取失败：boom");
    act(() =>
      root!.render(
        createElement(AgendaView, {
          agenda: { ...seeded, status: "pending", page: { sourceLimit: 100, cursor: null, nextCursor: "c2" } },
          agendaError: null,
          onNavigateEntity: () => {},
        }),
      ),
    );
    expect(loading.textContent).toContain("正在追赶台账切面(r7)");
  });
});

describe("总览(S1):四格落点与「需要我的判断 / 正在发生」", () => {
  it("四格点击按格分流", () => {
    const targets: DecisionTileTarget[] = [];
    const host = mount(
      createElement(DecisionReviewTiles, { agenda: seeded, onOpen: (target) => targets.push(target) }),
    );
    for (const id of ["dispose", "review", "reviewing", "judge"]) click(host, `overview-decision-tile-${id}`);
    expect(targets).toEqual([
      { kind: "entity", ref: "decisionreview/dec_dispose/respond" },
      { kind: "view", view: "agenda" },
      { kind: "entity", ref: "decisionsessions/dec_running" },
      { kind: "entity", ref: "decisionreview/dec_judge/judge" },
    ]);
  });

  it("追赶中的半个切面不直达单条", () => {
    const targets: DecisionTileTarget[] = [];
    const host = mount(
      createElement(DecisionReviewTiles, {
        agenda: { ...seeded, status: "pending", page: { sourceLimit: 100, cursor: null, nextCursor: "c2" } },
        onOpen: (target) => targets.push(target),
      }),
    );
    click(host, "overview-decision-tile-dispose");
    click(host, "overview-decision-tile-reviewing");
    expect(targets).toEqual([
      { kind: "view", view: "agenda" },
      { kind: "view", view: "sessions" },
    ]);
  });

  it("需要我的判断 = 待处置 + 待裁决;正在发生 = 评审中,直达该 Decision 的评审会话", () => {
    const targets: DecisionTileTarget[] = [];
    const host = mount(createElement(DecisionReviewNow, { agenda: seeded, onOpen: (target) => targets.push(target) }));
    const judgment = host.querySelector('[data-testid="overview-judgment"]')!;
    const happening = host.querySelector('[data-testid="overview-happening"]')!;
    expect(judgment.textContent).toContain("需要我的判断");
    expect(judgment.textContent).toContain("提案 decision/dec_dispose");
    expect(judgment.textContent).toContain("打开提案");
    expect(judgment.textContent).toContain("决策 dec_judge");
    expect(judgment.textContent).toContain("看裁决依据");
    expect(judgment.textContent).not.toContain("dec_review_a");
    expect(happening.textContent).toContain("正在发生");
    expect(happening.textContent).toContain("决策 dec_running");
    // 原型 S1「独立评审乙提出 2 项意见」:评审人与意见数取议程读面;评审未登记时如实写进行中。
    expect(happening.textContent).toContain("独立评审乙 提出 2 项意见 · 独立评审甲 评审进行中");
    expect(happening.textContent).toContain("查看会话");
    for (const id of ["dec_dispose", "dec_judge", "dec_running"]) click(host, `overview-decision-open-${id}`);
    expect(targets).toEqual([
      { kind: "entity", ref: "decisionreview/dec_dispose/respond" },
      { kind: "entity", ref: "decisionreview/dec_judge/judge" },
      { kind: "entity", ref: "decisionsessions/dec_running" },
    ]);
  });

  it("超出首屏的行不静默截断:写出总数并去议程页 / 会话页", () => {
    const targets: DecisionTileTarget[] = [];
    const many = agenda({
      awaitingDecision: ["a", "b", "c", "d"].map((id) => decisionRow(`dec_${id}`)),
      decisionReviewInProgress: ["e", "f", "g", "h", "i"].map((id) => reviewingRow(`dec_${id}`)),
    });
    const host = mount(createElement(DecisionReviewNow, { agenda: many, onOpen: (target) => targets.push(target) }));
    const more = [...host.querySelectorAll("button")].filter((button) => button.textContent?.includes("全部"));
    expect(more.map((button) => button.textContent)).toEqual(["全部 4 项 · 去议程 →", "全部 5 项 · 去会话 →"]);
    for (const button of more) act(() => button.click());
    expect(targets).toEqual([
      { kind: "view", view: "agenda" },
      { kind: "view", view: "sessions" },
    ]);
  });

  it("议程没读到时两栏只写读取中", () => {
    const host = mount(createElement(DecisionReviewNow, { agenda: undefined, onOpen: () => {} }));
    expect(host.querySelectorAll("li")).toHaveLength(0);
    expect(host.textContent).toContain("正在读取议程");
  });
});
