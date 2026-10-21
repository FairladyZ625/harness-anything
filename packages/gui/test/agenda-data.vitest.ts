// harness-test-tier: contract
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { agendaQuery, readAgenda } from "../src/renderer/agenda-data.ts";
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
const reviewingRow = (decisionId: string) => ({
  ...decisionRow(decisionId),
  reviewers: [{ dispatchId: "dispatch_a", reviewer: "独立评审甲", findingCount: null }],
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
    attentionItems: [],
    regionWeights: { mine: 1.5, stuck: 3, run: 3, review: 3, queue: 0, recent: 4, works: 8 },
    inFlight: [],
    stalled: [],
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
    attentionItems: [],
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
  it("drains more than 50 valid pages before publishing the complete agenda", async () => {
    for (let index = 0; index < 56; index += 1)
      pages.push(
        page({
          inFlight: [row(`task-${index}`)],
          page: {
            sourceLimit: 100,
            cursor: index === 0 ? null : String(index),
            nextCursor: index === 55 ? null : String(index + 1),
          },
        }),
      );
    const result = await readAgenda("repo-a");
    expect(result.inFlight).toHaveLength(56);
    expect(result.inFlight.at(-1)?.taskId).toBe("task-55");
    expect(result.status).toBe("ready");
    expect(result.page.nextCursor).toBeNull();
    expect(harnessClient.getAgenda).toHaveBeenCalledTimes(56);
    expect(harnessClient.getAgenda).toHaveBeenLastCalledWith({ repoId: "repo-a", limit: 100, cursor: "55" });
  });

  it("drains the whole cursor window inside one read and joins it into the settled aspect", async () => {
    pages.push(
      page({
        status: "pending",
        dispatchable: [row("task_a"), row("task_b")],
        page: { sourceLimit: 100, cursor: null, nextCursor: "agenda-next" },
      }),
      page({
        dispatchable: [row("task_b"), row("task_c")],
        page: { sourceLimit: 100, cursor: "agenda-next", nextCursor: null },
        watermark: 4,
        sourceRevision: 4,
      }),
    );
    const settled = await readAgenda("repo-a");
    // 排空在这一次读取内完成:两页背靠背消费,中间不等任何节拍定时器。
    expect(harnessClient.getAgenda).toHaveBeenCalledTimes(2);
    expect(settled.status).toBe("ready");
    expect(settled.page.nextCursor).toBeNull();
    // 合并按 taskId 去重;watermark 取 min、sourceRevision 取 max。
    expect(settled.dispatchable.map(({ taskId }) => taskId)).toEqual(["task_a", "task_b", "task_c"]);
    expect(settled.watermark).toBe(3);
    expect(settled.sourceRevision).toBe(4);
  });

  it("passes the daemon's own pending status through on a settled read", async () => {
    // cut 追赶中:daemon 在最后一页(nextCursor 为空)仍可报 pending,原样透传给视图。
    pages.push(page({ status: "pending" }));
    const settled = await readAgenda("repo-a");
    expect(settled.status).toBe("pending");
    expect(settled.page.nextCursor).toBeNull();
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
        decisionReviewInProgress: [reviewingRow("dec_running")],
        awaitingDecisionReview: [decisionRow("dec_needs_review")],
        awaitingDecision: [decisionRow("dec_one")],
        attentionItems: [
          {
            ref: "relation/rel_a",
            title: "等答复 rel_a",
            kind: "awaiting-you",
            region: "mine",
            workTaskId: "task_a",
            attention: { score: 100, reasons: [] },
          },
          {
            ref: "task/task_stuck",
            title: "停滞",
            kind: "stalled",
            region: "stuck",
            workTaskId: "task_a",
            attention: { score: 55, reasons: [] },
          },
        ],
        page: { sourceLimit: 100, cursor: null, nextCursor: "agenda-next" },
      }),
      page({
        awaitingYou: [awaitsRow("rel_a", 2), awaitsRow("rel_b")],
        answeredForYou: [answeredRow("rel_old"), answeredRow("rel_new")],
        awaitingRework: [row("task_rework")],
        awaitingAdjudication: [executionRow("task_sub2", "exe_sub2")],
        underReview: [executionRow("task_rev", "exe_rev")],
        decisionReviewInProgress: [reviewingRow("dec_running")],
        awaitingDecisionReview: [decisionRow("dec_needs_review"), decisionRow("dec_needs_review_2")],
        awaitingDecision: [decisionRow("dec_one"), decisionRow("dec_two")],
        attentionItems: [
          {
            ref: "relation/rel_a",
            title: "等答复 rel_a",
            kind: "awaiting-you",
            region: "mine",
            workTaskId: "task_a",
            attention: { score: 130, reasons: [] },
          },
        ],
        page: { sourceLimit: 100, cursor: "agenda-next", nextCursor: null },
      }),
    );
    const joined = await readAgenda("repo-a");
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
    // 注意力条目按 ref 去重,后读到的分数覆盖先前一页的同一条。
    expect(joined.attentionItems.map(({ ref, attention }) => [ref, attention.score])).toEqual([
      ["relation/rel_a", 130],
      ["task/task_stuck", 55],
    ]);
    expect(joined.awaitingDecisionReview.map(({ decisionId }) => decisionId)).toEqual([
      "dec_needs_review",
      "dec_needs_review_2",
    ]);
  });

  it("merges attention items by ref keeping the higher score and recomputes region weights over the joined cut", async () => {
    const attention = (ref: string, score: number, region: "mine" | "stuck", workTaskId: string | null = null) => ({
      ref,
      title: `条目 ${ref}`,
      kind: region === "mine" ? "awaiting-you" : "stalled",
      region,
      workTaskId,
      attention: { score, reasons: [{ label: "等你答复", contribution: score }] },
    });
    pages.push(
      page({
        status: "pending",
        inFlight: [row("task_live")],
        attentionItems: [attention("relation/rel_a", 90, "mine", "task_w"), attention("task/task_s", 44, "stuck")],
        regionWeights: { mine: 6.4, stuck: 3.9, run: 3, review: 3, queue: 0, recent: 4, works: 8 },
        page: { sourceLimit: 100, cursor: null, nextCursor: "agenda-next" },
      }),
      page({
        attentionItems: [
          attention("relation/rel_a", 130, "mine", "task_w"),
          attention("relation/rel_b", 60, "mine"),
          attention("task/task_s", 44, "stuck"),
        ],
        regionWeights: { mine: 6.4, stuck: 3, run: 3, review: 3, queue: 0, recent: 4, works: 8 },
        page: { sourceLimit: 100, cursor: "agenda-next", nextCursor: null },
      }),
    );
    const joined = await readAgenda("repo-a");
    // 同 ref 两页都出现时保分高者(与 daemon buildAttentionItems 的 highest 同判据),全局按分数排序。
    expect(joined.attentionItems.map(({ ref, attention }) => [ref, attention.score])).toEqual([
      ["relation/rel_a", 130],
      ["relation/rel_b", 60],
      ["task/task_s", 44],
    ]);
    // 权重用 daemon 同一函数在合并切面上重算:mine = 6 + (130+60)/14,stuck = 3 + 44/45,
    // run = 3 + 1×2.5(合并后 inFlight=1),works = 8 + 1×0.8(唯一一个有事的工作)。
    expect(joined.regionWeights.mine).toBeCloseTo(6 + 190 / 14, 5);
    expect(joined.regionWeights.stuck).toBeCloseTo(3 + 44 / 45, 5);
    expect(joined.regionWeights.run).toBeCloseTo(5.5, 5);
    expect(joined.regionWeights.works).toBeCloseTo(8.8, 5);
  });
});

describe("agenda read cadence", () => {
  it("finishes a multi-page agenda inside the first query round without a pacing timer", async () => {
    // 时钟推进是独立字面量 6_000(越过旧 agendaCatchUp 的 5_000 节拍),不引用生产
    // 常量:续读节拍若以任何形式复活,这里必红。
    vi.useFakeTimers();
    pages.push(
      page({
        status: "pending",
        dispatchable: [row("task_a")],
        page: { sourceLimit: 100, cursor: null, nextCursor: "agenda-next" },
      }),
      page({
        dispatchable: [row("task_b")],
        page: { sourceLimit: 100, cursor: "agenda-next", nextCursor: null },
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      observer = new QueryObserver(client, agendaQuery("repo-a")),
      unsubscribe = observer.subscribe(() => undefined);
    client.mount();
    try {
      const settled = await observer.refetch();
      // 首轮查询即终态:排空两页,不残留游标,不需要任何定时器推进。
      expect(settled.data?.status).toBe("ready");
      expect(settled.data?.page.nextCursor).toBeNull();
      expect(harnessClient.getAgenda).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(harnessClient.getAgenda).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      client.unmount();
      client.clear();
      vi.useRealTimers();
    }
  });
});

describe("agenda bridge validation", () => {
  it("passes the Decision review groups through and rejects a result that omits them", async () => {
    vi.restoreAllMocks();
    const wire = page({
      decisionReviewInProgress: [reviewingRow("dec_running")],
      awaitingDecisionReview: [decisionRow("dec_needs_review")],
    });
    const request = vi.fn(async () => wire);
    vi.stubGlobal("window", { harness: { request } });
    try {
      const read = await harnessClient.getAgenda({ repoId: "repo-a" });
      expect(read.decisionReviewInProgress.map(({ decisionId }) => decisionId)).toEqual(["dec_running"]);
      expect(read.awaitingDecisionReview.map(({ decisionId }) => decisionId)).toEqual(["dec_needs_review"]);
      expect(read.decisionReviewInProgress[0]?.reviewers).toEqual([
        { dispatchId: "dispatch_a", reviewer: "独立评审甲", findingCount: null },
      ]);
      // 评审中的行缺评审人列表时整份读面被拒,不把缺字段读成没有评审人。
      request.mockResolvedValueOnce({ ...wire, decisionReviewInProgress: [decisionRow("dec_running")] });
      await expect(harnessClient.getAgenda({ repoId: "repo-a" })).rejects.toThrow("Agenda bridge");
      const { awaitingDecisionReview: _omitted, ...missing } = wire;
      request.mockResolvedValueOnce(missing as AgendaSuccess);
      await expect(harnessClient.getAgenda({ repoId: "repo-a" })).rejects.toThrow("Agenda bridge");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
