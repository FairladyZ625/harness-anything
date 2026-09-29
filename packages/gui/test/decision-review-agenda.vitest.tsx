// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import type { AgendaAwaitsRow, AgendaDecisionRow } from "../src/api/renderer-dto.ts";
import { decisionAgendaCounts, taskAwaitsRows } from "../src/renderer/model/decision-review.ts";

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
  decisionReviewInProgress: [{ ...decisionRow("dec_running"), reviewers: [] }],
  awaitingDecision: [decisionRow("dec_judge")],
});

describe("议程分组计数(S1):计数是议程分组的长度", () => {
  it("待处置 = 等你处理里的 Decision 行 + task 源等你处理;待评审/评审中/待裁决 = 议程三组", () => {
    expect(decisionAgendaCounts(seeded)).toEqual({ dispose: 2, review: 2, reviewing: 1, judge: 1 });
  });
});

describe("等你处理的 task 源行(dec_DC3A1BB9 CH2)", () => {
  it("来源不是 Decision 的 awaits 行原样保留,Decision 源的不重复列入", () => {
    expect(taskAwaitsRows(seeded).map(({ relationId }) => relationId)).toEqual(["rel_task"]);
    expect(taskAwaitsRows(agenda())).toEqual([]);
  });
});
