// harness-test-tier: contract
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agendaQuery, readAgenda } from "../src/renderer/agenda-data.ts";
import { QUERY_PACING_MS } from "../src/renderer/query-pacing.ts";
import { harnessClient, type AgendaSuccess } from "../src/renderer/api-client.ts";
import type { AgendaRead } from "../src/api/renderer-dto.ts";

const AT = "2026-08-30T00:00:00.000Z";
const blocking = { state: "clear" as const, blockers: [], warnings: [] };
const row = (taskId: string, pinned = false) => ({
  taskId,
  title: `标题 ${taskId}`,
  status: "active" as const,
  pinned,
  updatedAt: AT,
  leaseExecutionId: null,
  activeExecutionIds: [],
  blockingAssessment: blocking,
});
const executionRow = (taskId: string, executionId: string) => ({
  taskId,
  title: `标题 ${taskId}`,
  pinned: false,
  executionId,
  submittedAt: AT,
  blockingAssessment: blocking,
});
const decisionRow = (decisionId: string) => ({
  decisionId,
  title: `决策 ${decisionId}`,
  riskTier: "medium" as const,
  urgency: "high" as const,
  proposedAt: AT,
});
const awaitsRow = (relationId: string, relationRevision = 1) => ({
  relationId,
  relationRevision,
  sourceRef: `task/task_${relationId}`,
  title: `等答复 ${relationId}`,
  status: "active",
  personId: "person_me",
  askKind: "question" as const,
  question: `问题 ${relationId}`,
  askedAt: AT,
  askedBy: "codex-sol",
});
const answeredRow = (relationId: string) => ({
  relationId,
  sourceRef: `task/task_${relationId}`,
  title: `答复 ${relationId}`,
  status: "active",
  personId: "person_me",
  askKind: "acceptance" as const,
  question: `问题 ${relationId}`,
  answer: "通过",
  answeredAt: AT,
  answeredBy: "person_me",
});

const page = (over: Partial<AgendaRead> = {}): AgendaSuccess => {
  const full = {
    schema: "daemon.agenda/v1",
    ok: true as const,
    command: "agenda",
    status: "ready" as const,
    inFlight: [],
    pinnedEntities: [],
    pinnedEntityOverflow: 0,
    awaitingYou: [],
    answeredForYou: [],
    awaitingRework: [],
    awaitingAdjudication: [],
    underReview: [],
    decisionReviewInProgress: [],
    awaitingDecisionReview: [],
    awaitingDecision: [],
    waitingOnOthers: [],
    dispatchable: [],
    summary: "在飞线 (0)",
    page: { sourceLimit: 100, cursor: null, nextCursor: null },
    watermark: 3,
    sourceRevision: 3,
    warnings: [],
    ...over,
  };
  return full as unknown as AgendaSuccess;
};

const pages: AgendaSuccess[] = [];
beforeEach(() => {
  pages.length = 0;
  vi.spyOn(harnessClient, "getAgenda").mockImplementation(async (payload) => {
    const requested = pages.shift();
    if (requested === undefined) throw new Error("unexpected agenda read");
    expect(payload.repoId).toBe("repo-a");
    return requested;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("agenda read discipline", () => {
  it("reads exactly one page per refresh and follows the composite cursor until it is exhausted", async () => {
    pages.push(
      page({
        status: "pending",
        dispatchable: [row("task_a"), row("task_b")],
        page: { sourceLimit: 100, cursor: null, nextCursor: "agenda-next" },
      }),
    );
    const first = await readAgenda("repo-a");
    expect(first.status).toBe("pending");
    expect(first.dispatchable.map(({ taskId }) => taskId)).toEqual(["task_a", "task_b"]);
    expect(first.page.nextCursor).toBe("agenda-next");

    pages.push(
      page({
        dispatchable: [row("task_b"), row("task_c")],
        page: { sourceLimit: 100, cursor: "agenda-next", nextCursor: null },
        watermark: 4,
        sourceRevision: 4,
      }),
    );
    const second = await readAgenda("repo-a", first);
    expect(second.status).toBe("ready");
    // 每 refresh 只发一个请求;合并且按 taskId 去重。
    expect(second.dispatchable.map(({ taskId }) => taskId)).toEqual(["task_a", "task_b", "task_c"]);
    expect(second.watermark).toBe(3);
    expect(second.sourceRevision).toBe(4);

    pages.push(page({ dispatchable: [row("task_z", true)] }));
    const restart = await readAgenda("repo-a", second);
    expect(restart.dispatchable.map(({ taskId }) => taskId)).toEqual(["task_z"]);
  });

  it("reports a pending facet while a page window is still open", async () => {
    pages.push(
      page({
        status: "pending",
        page: { sourceLimit: 100, cursor: null, nextCursor: "agenda-more" },
      }),
    );
    const pending = await readAgenda("repo-a");
    expect(pending.status).toBe("pending");
  });

  it("merges each awaiting group by its own entity key across cursor pages", async () => {
    pages.push(
      page({
        status: "pending",
        awaitingYou: [awaitsRow("rel_a")],
        answeredForYou: [answeredRow("rel_old")],
        awaitingRework: [row("task_rework")],
        awaitingAdjudication: [executionRow("task_sub", "exe_sub")],
        underReview: [executionRow("task_rev", "exe_rev")],
        decisionReviewInProgress: [decisionRow("dec_running")],
        awaitingDecisionReview: [decisionRow("dec_needs_review")],
        awaitingDecision: [decisionRow("dec_one")],
        page: { sourceLimit: 100, cursor: null, nextCursor: "agenda-next" },
      }),
    );
    const first = await readAgenda("repo-a");
    pages.push(
      page({
        awaitingYou: [awaitsRow("rel_a", 2), awaitsRow("rel_b")],
        answeredForYou: [answeredRow("rel_old"), answeredRow("rel_new")],
        awaitingRework: [row("task_rework")],
        awaitingAdjudication: [executionRow("task_sub2", "exe_sub2")],
        underReview: [executionRow("task_rev", "exe_rev")],
        decisionReviewInProgress: [decisionRow("dec_running")],
        awaitingDecisionReview: [decisionRow("dec_needs_review"), decisionRow("dec_needs_review_2")],
        awaitingDecision: [decisionRow("dec_one"), decisionRow("dec_two")],
        page: { sourceLimit: 100, cursor: "agenda-next", nextCursor: null },
      }),
    );
    const joined = await readAgenda("repo-a", first);
    // awaits 行按 relationId 去重,后读到的修订覆盖先前一页的同一条边。
    expect(joined.awaitingYou.map(({ relationId, relationRevision }) => [relationId, relationRevision])).toEqual([
      ["rel_a", 2],
      ["rel_b", 1],
    ]);
    expect(joined.answeredForYou.map(({ relationId }) => relationId)).toEqual(["rel_old", "rel_new"]);
    expect(joined.awaitingRework.map(({ taskId }) => taskId)).toEqual(["task_rework"]);
    expect(joined.awaitingAdjudication.map(({ executionId }) => executionId)).toEqual(["exe_sub", "exe_sub2"]);
    expect(joined.underReview.map(({ executionId }) => executionId)).toEqual(["exe_rev"]);
    expect(joined.awaitingDecision.map(({ decisionId }) => decisionId)).toEqual(["dec_one", "dec_two"]);
    // Decision 评审两组(PR #3053)同样按 decisionId 去重合并,不在前端重分组。
    expect(joined.decisionReviewInProgress.map(({ decisionId }) => decisionId)).toEqual(["dec_running"]);
    expect(joined.awaitingDecisionReview.map(({ decisionId }) => decisionId)).toEqual([
      "dec_needs_review",
      "dec_needs_review_2",
    ]);
  });
});

describe("agenda refresh cadence", () => {
  it("polls only to finish an open cursor window; a settled agenda waits for the ledger cut", () => {
    const interval = agendaQuery("repo-a").refetchInterval as (query: {
      readonly state: { readonly data?: Partial<AgendaSuccess> };
    }) => number | false;
    expect(interval({ state: { data: { page: { nextCursor: "c2" } } as Partial<AgendaSuccess> } })).toBe(
      QUERY_PACING_MS.agendaCatchUp,
    );
    expect(interval({ state: { data: { page: { nextCursor: null } } as Partial<AgendaSuccess> } })).toBe(false);
    expect(interval({ state: {} })).toBe(false);
  });
});

describe("agenda bridge validation", () => {
  it("passes the Decision review groups through and rejects a result that omits them", async () => {
    vi.restoreAllMocks();
    const wire = page({
      decisionReviewInProgress: [decisionRow("dec_running")],
      awaitingDecisionReview: [decisionRow("dec_needs_review")],
    });
    const request = vi.fn(async () => wire);
    vi.stubGlobal("window", { harness: { request } });
    try {
      const read = await harnessClient.getAgenda({ repoId: "repo-a" });
      expect(read.decisionReviewInProgress.map(({ decisionId }) => decisionId)).toEqual(["dec_running"]);
      expect(read.awaitingDecisionReview.map(({ decisionId }) => decisionId)).toEqual(["dec_needs_review"]);
      const { awaitingDecisionReview: _omitted, ...missing } = wire;
      request.mockResolvedValueOnce(missing as AgendaSuccess);
      await expect(harnessClient.getAgenda({ repoId: "repo-a" })).rejects.toThrow("Agenda bridge");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
