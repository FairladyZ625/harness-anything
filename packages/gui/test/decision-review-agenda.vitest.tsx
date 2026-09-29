// harness-test-tier: integration
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import type { AgendaAwaitsRow, AgendaDecisionRow } from "../src/api/renderer-dto.ts";
import { decisionAgendaCounts } from "../src/renderer/model/decision-review.ts";
import { attentionItemsOf, ATTENTION_GROUP_ORDER } from "../src/renderer/model/overview-next.ts";
import { DecisionReviewTiles } from "../src/renderer/components/overview/DecisionReviewTiles.tsx";

/**
 * Decision 评审在总览(S1)与议程(S2)上的呈现(task_8ffe94dd):计数与分组全部取议程读面
 * (PR #3053 的 decisionReviewInProgress / awaitingDecisionReview,加 awaitingDecision 与
 * 「等你处理」里的 Decision 行),不逐条补读 Decision、不在前端重新分组。
 */
const AT = "2026-09-29T01:00:00.000Z";
const decisionRow = (decisionId: string): AgendaDecisionRow => ({
  decisionId,
  title: `决策 ${decisionId}`,
  riskTier: "high",
  urgency: "medium",
  proposedAt: AT,
});
const awaitsRow = (relationId: string, sourceRef: string): AgendaAwaitsRow => ({
  relationId,
  relationRevision: 1,
  sourceRef,
  title: `等你 ${relationId}`,
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
  awaitingYou: [awaitsRow("rel_dec", "decision/dec_dispose"), awaitsRow("rel_task", "task/task_x")],
  awaitingDecisionReview: [decisionRow("dec_review_a"), decisionRow("dec_review_b")],
  decisionReviewInProgress: [decisionRow("dec_running")],
  awaitingDecision: [decisionRow("dec_judge")],
});

describe("总览四格(S1):计数是议程分组的长度", () => {
  it("待处置 = 等你处理里的 Decision 行;待评审/评审中/待裁决 = 议程三组", () => {
    expect(decisionAgendaCounts(seeded)).toEqual({ dispose: 1, review: 2, reviewing: 1, judge: 1 });
  });

  it("四格按原型顺序渲染计数;点击走决策收件箱出口", () => {
    const html = renderToStaticMarkup(createElement(DecisionReviewTiles, { agenda: seeded, onOpen: vi.fn() }));
    const tile = (id: string) =>
      html.match(new RegExp(`data-testid="overview-decision-tile-${id}"[^>]*>(.*?)</button>`))?.[1];
    expect(
      ["dispose", "review", "reviewing", "judge"].map((id) =>
        tile(id)
          ?.replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    ).toEqual(["1 待处置 →", "2 待评审 →", "1 评审中 →", "1 待裁决 →"]);
  });

  it("议程还没读到或还在追赶时不冒充总数", () => {
    const missing = renderToStaticMarkup(createElement(DecisionReviewTiles, { agenda: undefined, onOpen: vi.fn() }));
    expect(missing).not.toMatch(/>\d+</);
    expect(missing).toContain("—");
    const pending = renderToStaticMarkup(
      createElement(DecisionReviewTiles, {
        agenda: { ...seeded, status: "pending", page: { sourceLimit: 100, cursor: null, nextCursor: "c2" } },
        onOpen: vi.fn(),
      }),
    );
    expect(pending).not.toMatch(/>\d+</);
    expect(pending).toContain("正在追赶台账切面(r7)");
  });
});

describe("议程(S2):Decision 按议程读面分组", () => {
  it("评审中、待评审、待裁各成一组,顺序照设计 Q5,行不重复", () => {
    const items = attentionItemsOf(seeded)!;
    const groupOf = (ref: string) => items.filter((item) => item.ref === ref).map(({ group }) => group);
    expect(groupOf("decision/dec_running")).toEqual(["decisionReviewing"]);
    expect(groupOf("decision/dec_review_a")).toEqual(["decisionReview"]);
    expect(groupOf("decision/dec_judge")).toEqual(["decision"]);
    // 待处置只经「等你处理」的 awaits 行出现,不再复制到 Decision 组。
    expect(groupOf("decision/dec_dispose")).toEqual(["awaitingYou"]);
    const order = ATTENTION_GROUP_ORDER.filter((group) => group.startsWith("decision"));
    expect(order).toEqual(["decisionReviewing", "decisionReview", "decision"]);
  });
});
