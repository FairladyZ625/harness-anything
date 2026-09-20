// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import {
  CADENCE_EVENT_LIMIT,
  CADENCE_FRICTION_ALERT_THRESHOLD,
  CADENCE_MICRO_EVENTS,
  CADENCE_MODULE_TOP,
  CADENCE_RECENT_FACTS,
  cadenceEventOf,
  deriveCadenceSnapshot,
  deriveStageTiming,
  mergeCadenceEvents,
  type CadenceFeedEvent,
} from "../src/renderer/model/cadence.ts";
import { deriveFleetPulse } from "../src/renderer/model/cadence-fleet.ts";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";

/**
 * 研发态势纯聚合引擎的判据(输入是 observe.tail events item 的结构子集):
 *  - 阶段首达:bootstrap→wip→fact→gate→complete 各记首次时间,currentStage 取最新;
 *  - 阶段耗时漏斗:相邻阶段首达差推导区间耗时,占比最大者为瓶颈;
 *  - 微型事件链:任务事件按序携带摘要(statement/text/title 截断),封顶最新 N 条;
 *  - 摩擦:门禁 witness fail / 评审 changes_requested / 提交退回 / 任务重开四类计数,
 *    总数超过阈值(>2)标记高摩擦;
 *  - HUD:在飞/停滞/平均交付/今日收口/待人工(透传,议程未读为 null 不冒充);
 *  - 产出:今日 Fact、最近 Fact 倒序截断、决策计数、模块热度;
 *  - 窗口合并:eventId 去重、升序、封顶丢最旧、无新行返回原引用。
 */

const NOW = "2026-09-20T12:00:00.000Z",
  EARLIER_DAY = "2026-09-18T08:00:00.000Z";

function cadenceTask(overrides: Partial<TaskRow> & { readonly taskId: string }): TaskRow {
  return {
    title: overrides.taskId,
    projectId: "repo-a",
    coordinationStatus: "active",
    rawStatus: "active/implementation",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "kernel/task-lifecycle/v1",
    origin: "native",
    source: "local-document",
    module: "gui",
    lastKnownAt: NOW,
    gates: [],
    board: projectedTaskFields("active").board,
    visibility: projectedTaskFields("active").visibility,
    capabilities: projectedTaskFields("active").capabilities,
    risk: projectedTaskFields("active").risk,
    phase: projectedTaskFields("active").phase,
    docs: [],
    ...overrides,
  } as TaskRow;
}

interface EventSeed {
  readonly id: string;
  readonly type: string;
  readonly at?: string;
  readonly revision?: number;
  readonly taskId?: string;
  readonly factId?: string;
  readonly payload?: Record<string, unknown>;
}

function seedToItem(seed: EventSeed): Record<string, unknown> {
  return {
    schema: "task-event/v1",
    eventId: seed.id,
    workspaceRevision: seed.revision ?? 1,
    opId: "op-cadence",
    type: seed.type,
    actor: { kind: "agent", id: "agent_c" },
    source: { channel: "cli" },
    occurredAt: seed.at ?? NOW,
    ...(seed.taskId ? { taskId: seed.taskId } : {}),
    ...(seed.factId ? { factId: seed.factId } : {}),
    ...(seed.payload ? { payload: seed.payload } : {}),
  };
}

function feed(seeds: readonly EventSeed[]): CadenceFeedEvent[] {
  return mergeCadenceEvents(
    [],
    seeds.map((seed) => cadenceEventOf(seedToItem(seed))),
  );
}

describe("cadenceEventOf", () => {
  it("extracts task scoping, gate witness result and review verdict from the canonical payload", () => {
    const event = cadenceEventOf(
      seedToItem({
        id: "ev-gate",
        type: "completion_gate_verified",
        taskId: "task_a",
        revision: 7,
        payload: { witness: { gateId: "ci", result: "fail" } },
      }),
    );
    expect(event).toMatchObject({
      key: "ev-gate",
      type: "completion_gate_verified",
      taskId: "task_a",
      revision: 7,
      gateId: "ci",
      gateResult: "fail",
      reviewVerdict: null,
      at: NOW,
    });
  });

  it("reads the review verdict and payload.taskId fallback; unknown shapes keep null fields", () => {
    const review = cadenceEventOf({
      schema: "task-event/v1",
      eventId: "ev-review",
      type: "review_recorded",
      occurredAt: NOW,
      payload: { taskId: "task_b", review: { verdict: "changes_requested" } },
    });
    expect(review.taskId).toBe("task_b");
    expect(review.reviewVerdict).toBe("changes_requested");
    const opaque = cadenceEventOf({ nope: 1 });
    expect(opaque.type).toBe("event");
    expect(opaque.taskId).toBeNull();
    expect(opaque.key).not.toBe("");
  });

  it("extracts a clipped summary from statement/text/title for the micro event chain", () => {
    const fact = cadenceEventOf(
      seedToItem({
        id: "ev-fact",
        type: "fact_recorded",
        taskId: "task_a",
        factId: "F-aaaaaaaa",
        payload: { statement: "聚合窗口按 5 秒追尾一次,封顶 4096 条" },
      }),
    );
    expect(fact.summary).toBe("聚合窗口按 5 秒追尾一次,封顶 4096 条");
    const progress = cadenceEventOf(
      seedToItem({ id: "ev-progress", type: "task_progress_appended", payload: { text: "已收口" } }),
    );
    expect(progress.summary).toBe("已收口");
    const long = cadenceEventOf(
      seedToItem({ id: "ev-long", type: "fact_recorded", payload: { statement: "长".repeat(200) } }),
    );
    expect(long.summary).toHaveLength(140);
    expect(long.summary!.endsWith("…")).toBe(true);
    expect(cadenceEventOf(seedToItem({ id: "ev-bare", type: "lease_renewed" })).summary).toBeNull();
  });
});

describe("deriveFleetPulse", () => {
  it("separates flow states and detects multiple active leases on one task", () => {
    const session = (id: string, taskId: string, liveness: "live" | "exited"): AgentRuntimeSessionDto =>
      ({
        runtimeSessionId: id,
        instanceId: id,
        kindId: "codex",
        liveness,
        definitionSnapshot: null,
        associations: [{ taskId, executionId: `exe_${id}`, holder: null, lease: { phase: "held", expiresAt: NOW } }],
        activity: { lastObservedAt: NOW, outcome: null, exitCode: null, resultRef: null, missingEvidence: null },
      }) as AgentRuntimeSessionDto;
    const snapshot = deriveFleetPulse({
      sessions: [session("runtime_a", "task_flight", "live"), session("runtime_b", "task_flight", "live")],
      tasks: [
        cadenceTask({ taskId: "task_claimed" }),
        cadenceTask({ taskId: "task_flight" }),
        cadenceTask({ taskId: "task_settled", coordinationStatus: "done" }),
      ],
      events: feed([]),
    });
    expect(snapshot.flow).toEqual({ claimed: 1, inFlight: 1, settled: 1 });
    expect(snapshot.collisions).toEqual([{ taskId: "task_flight", workerCount: 2 }]);
    expect(snapshot.activeCount).toBe(2);
  });

  it("filters workers by time window and computes active count accurately", () => {
    const makeSession = (
      id: string,
      liveness: "live" | "exited",
      observedAt: string,
      outcome: "succeeded" | "failed" | null = null,
      tokens?: { input: number; output: number; tools: number },
    ): AgentRuntimeSessionDto =>
      ({
        runtimeSessionId: id,
        instanceId: id,
        kindId: "codex",
        liveness,
        definitionSnapshot: { kindId: "codex", model: "claude-3-5-sonnet" },
        associations: [{ taskId: "t1", executionId: `exe_${id}`, holder: null, lease: null }],
        activity: {
          lastObservedAt: observedAt,
          outcome,
          exitCode: outcome === "failed" ? 1 : 0,
          resultRef: null,
          missingEvidence: null,
        },
        ...(tokens
          ? {
              metrics: {
                inputTokens: tokens.input,
                cacheReadTokens: 0,
                outputTokens: tokens.output,
                totalTokens: tokens.input + tokens.output,
                toolCallCount: tokens.tools,
                compacted: false,
                usageUnavailable: false,
              },
            }
          : {}),
      }) as AgentRuntimeSessionDto;

    const baseNow = "2026-09-20T12:00:00.000Z";
    const halfHourAgo = "2026-09-20T11:30:00.000Z";
    const fiveHoursAgo = "2026-09-20T07:00:00.000Z";
    const twoDaysAgo = "2026-09-18T12:00:00.000Z";
    const eightDaysAgo = "2026-09-12T12:00:00.000Z";

    const sessions = [
      makeSession("live_1", "live", halfHourAgo),
      makeSession("exited_1h", "exited", halfHourAgo, "succeeded", { input: 1000, output: 200, tools: 5 }),
      makeSession("exited_5h", "exited", fiveHoursAgo, "failed"),
      makeSession("exited_2d", "exited", twoDaysAgo, "succeeded"),
      makeSession("exited_8d", "exited", eightDaysAgo, "cancelled"),
    ];

    const activeSnap = deriveFleetPulse({
      sessions,
      tasks: [],
      events: [],
      window: "active",
      now: baseNow,
    });
    expect(activeSnap.activeCount).toBe(1);
    expect(activeSnap.workers.map((w) => w.runtimeSessionId)).toEqual(["live_1"]);

    const snap1h = deriveFleetPulse({
      sessions,
      tasks: [],
      events: [],
      window: "1h",
      now: baseNow,
    });
    expect(snap1h.workers.map((w) => w.runtimeSessionId)).toEqual(["live_1", "exited_1h"]);
    expect(snap1h.workers[1]!.metrics?.totalTokens).toBe(1200);
    expect(snap1h.workers[1]!.metrics?.toolCalls).toBe(5);
    expect(snap1h.workers[1]!.outcome).toBe("succeeded");

    const snap24h = deriveFleetPulse({
      sessions,
      tasks: [],
      events: [],
      window: "24h",
      now: baseNow,
    });
    expect(snap24h.workers.map((w) => w.runtimeSessionId)).toEqual(["live_1", "exited_1h", "exited_5h"]);

    const snap7d = deriveFleetPulse({
      sessions,
      tasks: [],
      events: [],
      window: "7d",
      now: baseNow,
    });
    expect(snap7d.workers.map((w) => w.runtimeSessionId)).toEqual(["live_1", "exited_1h", "exited_5h", "exited_2d"]);

    const snapAll = deriveFleetPulse({
      sessions,
      tasks: [],
      events: [],
      window: "all",
      now: baseNow,
    });
    expect(snapAll.workers).toHaveLength(5);
  });

  it("sorts workers by status priority (live > idle > exited) and descending lastActiveAt", () => {
    const makeSession = (
      id: string,
      liveness: "live" | "stale" | "exited",
      observedAt: string,
    ): AgentRuntimeSessionDto =>
      ({
        runtimeSessionId: id,
        instanceId: id,
        kindId: "codex",
        liveness: liveness === "stale" ? "stale" : liveness,
        definitionSnapshot: null,
        associations: [],
        activity: { lastObservedAt: observedAt, outcome: null, exitCode: null, resultRef: null, missingEvidence: null },
      }) as AgentRuntimeSessionDto;

    const baseNow = "2026-09-20T12:00:00.000Z";
    const sessions = [
      makeSession("exited_recent", "exited", "2026-09-20T11:50:00.000Z"),
      makeSession("live_older", "live", "2026-09-20T10:00:00.000Z"),
      makeSession("live_newer", "live", "2026-09-20T11:55:00.000Z"),
      makeSession("exited_older", "exited", "2026-09-20T08:00:00.000Z"),
    ];

    const snapshot = deriveFleetPulse({
      sessions,
      tasks: [],
      events: [],
      window: "24h",
      now: baseNow,
    });

    expect(snapshot.workers.map((w) => w.runtimeSessionId)).toEqual([
      "live_newer",
      "live_older",
      "exited_recent",
      "exited_older",
    ]);
  });
});

describe("mergeCadenceEvents", () => {
  it("dedupes by event id, sorts ascending and caps the window by dropping the oldest end", () => {
    const older = cadenceEventOf(seedToItem({ id: "e1", type: "task_created", revision: 1 })),
      newer = cadenceEventOf(seedToItem({ id: "e2", type: "task_created", revision: 2 })),
      replay = cadenceEventOf(seedToItem({ id: "e2", type: "task_created", revision: 2 })),
      merged = mergeCadenceEvents([newer], [older, replay]);
    expect(merged.map((event) => event.key)).toEqual(["e1", "e2"]);
    expect(mergeCadenceEvents(merged, [replay])).toBe(merged);
    expect(mergeCadenceEvents(merged, [])).toBe(merged);
    const flood = Array.from({ length: CADENCE_EVENT_LIMIT + 10 }, (_, index) =>
      cadenceEventOf(seedToItem({ id: `f${index}`, type: "lease_renewed", revision: index })),
    );
    expect(mergeCadenceEvents([], flood)).toHaveLength(CADENCE_EVENT_LIMIT);
  });
});

describe("deriveCadenceSnapshot", () => {
  it("records first arrival per stage and the latest reached stage as currentStage", () => {
    const events = feed([
      { id: "a1", type: "task_created", taskId: "task_a", at: "2026-09-20T01:00:00.000Z", revision: 1 },
      { id: "a2", type: "execution_started", taskId: "task_a", at: "2026-09-20T02:00:00.000Z", revision: 2 },
      {
        id: "a3",
        type: "fact_recorded",
        taskId: "task_a",
        factId: "F-aaaaaaaa",
        at: "2026-09-20T03:00:00.000Z",
        revision: 3,
      },
      { id: "a4", type: "completion_gate_verified", taskId: "task_a", at: "2026-09-20T04:00:00.000Z", revision: 4 },
      { id: "a2b", type: "lease_renewed", taskId: "task_a", at: "2026-09-20T05:00:00.000Z", revision: 5 },
    ]);
    const snapshot = deriveCadenceSnapshot({
      events,
      tasks: [cadenceTask({ taskId: "task_a" })],
      decisions: [],
      awaitingHuman: 0,
      now: NOW,
    });
    const entry = snapshot.rhythm.find((row) => row.taskId === "task_a")!;
    expect(entry.stages.bootstrap).toBe("2026-09-20T01:00:00.000Z");
    expect(entry.stages.wip).toBe("2026-09-20T02:00:00.000Z");
    expect(entry.stages.fact).toBe("2026-09-20T03:00:00.000Z");
    expect(entry.stages.gate).toBe("2026-09-20T04:00:00.000Z");
    expect(entry.stages.complete).toBeNull();
    expect(entry.currentStage).toBe("wip");
    expect(entry.eventCount).toBe(5);
    expect(entry.known).toBe(true);
  });

  it("derives the stage timing funnel from first arrivals and names the max-share bottleneck", () => {
    const events = feed([
      { id: "t1", type: "task_created", taskId: "task_t", at: "2026-09-20T01:00:00.000Z", revision: 1 },
      { id: "t2", type: "execution_started", taskId: "task_t", at: "2026-09-20T02:00:00.000Z", revision: 2 },
      {
        id: "t3",
        type: "fact_recorded",
        taskId: "task_t",
        factId: "F-tttttttt",
        at: "2026-09-20T03:00:00.000Z",
        revision: 3,
      },
      { id: "t4", type: "completion_gate_verified", taskId: "task_t", at: "2026-09-20T06:00:00.000Z", revision: 4 },
      { id: "t5", type: "task_completed", taskId: "task_t", at: "2026-09-20T07:00:00.000Z", revision: 5 },
    ]);
    const snapshot = deriveCadenceSnapshot({
      events,
      tasks: [cadenceTask({ taskId: "task_t", coordinationStatus: "done" })],
      decisions: [],
      awaitingHuman: 0,
      now: NOW,
    });
    const entry = snapshot.rhythm.find((row) => row.taskId === "task_t")!;
    expect(entry.timing.segments).toEqual({
      toWip: 3_600_000,
      toFact: 3_600_000,
      toGate: 3 * 3_600_000,
      toComplete: 3_600_000,
    });
    expect(entry.timing.measuredMs).toBe(6 * 3_600_000);
    expect(entry.timing.bottleneck).toBe("toGate");
    expect(entry.timing.bottleneckShare).toBe(0.5);
    expect(entry.deliveryMs).toBe(6 * 3_600_000);
  });

  it("keeps funnel segments null when the window misses a stage endpoint", () => {
    const timing = deriveStageTiming({
      bootstrap: "2026-09-20T01:00:00.000Z",
      wip: "2026-09-20T04:00:00.000Z",
      fact: null,
      gate: null,
      complete: "2026-09-20T05:00:00.000Z",
    });
    expect(timing.segments).toEqual({ toWip: 3 * 3_600_000, toFact: null, toGate: null, toComplete: null });
    expect(timing.bottleneck).toBe("toWip");
    expect(timing.bottleneckShare).toBe(1);
    expect(
      deriveStageTiming({ bootstrap: null, wip: null, fact: null, gate: null, complete: null }).bottleneck,
    ).toBeNull();
  });

  it("exposes elapsed duration to completion or to the aggregation clock for in-flight tasks", () => {
    const snapshot = deriveCadenceSnapshot({
      events: feed([
        { id: "e1", type: "task_created", taskId: "task_open", at: "2026-09-20T10:00:00.000Z", revision: 1 },
        { id: "e2", type: "lease_renewed", taskId: "task_open", at: "2026-09-20T11:00:00.000Z", revision: 2 },
        { id: "e3", type: "task_created", taskId: "task_closed", at: "2026-09-20T08:00:00.000Z", revision: 3 },
        { id: "e4", type: "task_completed", taskId: "task_closed", at: "2026-09-20T09:00:00.000Z", revision: 4 },
      ]),
      tasks: [cadenceTask({ taskId: "task_open" }), cadenceTask({ taskId: "task_closed", coordinationStatus: "done" })],
      decisions: [],
      awaitingHuman: 0,
      now: NOW,
    });
    const open = snapshot.rhythm.find((row) => row.taskId === "task_open")!,
      closed = snapshot.rhythm.find((row) => row.taskId === "task_closed")!;
    expect(open.elapsedMs).toBe(2 * 3_600_000);
    expect(closed.elapsedMs).toBe(3_600_000);
    const quiet = deriveCadenceSnapshot({
      events: [],
      tasks: [cadenceTask({ taskId: "task_quiet" })],
      decisions: [],
      awaitingHuman: 0,
      now: NOW,
    });
    expect(quiet.rhythm.find((row) => row.taskId === "task_quiet")!.elapsedMs).toBeNull();
  });

  it("carries the per-task micro event chain in order, capped at the latest CADENCE_MICRO_EVENTS", () => {
    const total = CADENCE_MICRO_EVENTS + 9;
    const events = feed(
      Array.from({ length: total }, (_, index) => ({
        id: `m${index}`,
        type: index === 0 ? "task_created" : "lease_renewed",
        taskId: "task_m",
        at: `2026-09-20T0${index % 10}:30:00.000Z`,
        revision: index,
      })),
    );
    const snapshot = deriveCadenceSnapshot({
      events,
      tasks: [cadenceTask({ taskId: "task_m" })],
      decisions: [],
      awaitingHuman: 0,
      now: NOW,
    });
    const entry = snapshot.rhythm.find((row) => row.taskId === "task_m")!;
    expect(entry.microEvents).toHaveLength(CADENCE_MICRO_EVENTS);
    expect(entry.microTruncated).toBe(9);
    // 截断保最新端:链首是被丢掉的第 10 条,链尾是最后一条。
    expect(entry.microEvents[0]!.key).toBe("m9");
    expect(entry.microEvents.at(-1)!.key).toBe(`m${total - 1}`);
    expect(entry.microEvents.every((event) => event.taskId === "task_m")).toBe(true);
  });

  it("counts the four friction kinds and marks totals above the threshold as high friction", () => {
    const events = feed([
      {
        id: "f1",
        type: "completion_gate_verified",
        taskId: "task_hot",
        revision: 1,
        payload: { witness: { gateId: "ci", result: "fail" } },
      },
      {
        id: "f2",
        type: "completion_gate_verified",
        taskId: "task_hot",
        revision: 2,
        payload: { witness: { gateId: "lint", result: "fail" } },
      },
      {
        id: "f3",
        type: "review_recorded",
        taskId: "task_hot",
        revision: 3,
        payload: { review: { verdict: "changes_requested" } },
      },
      {
        id: "f4",
        type: "review_recorded",
        taskId: "task_warm",
        revision: 4,
        payload: { review: { verdict: "approved" } },
      },
      { id: "f5", type: "submission_returned", taskId: "task_warm", revision: 5 },
      { id: "f6", type: "task_reopened", taskId: "task_warm", revision: 6 },
      {
        id: "f7",
        type: "completion_gate_verified",
        taskId: "task_warm",
        revision: 7,
        payload: { witness: { gateId: "ci", result: "pass" } },
      },
    ]);
    const snapshot = deriveCadenceSnapshot({
      events,
      tasks: [cadenceTask({ taskId: "task_hot" }), cadenceTask({ taskId: "task_warm" })],
      decisions: [],
      awaitingHuman: null,
      now: NOW,
    });
    expect(snapshot.friction.byKind).toEqual({ gateFail: 2, reviewChanges: 1, returned: 1, reopened: 1 });
    const hot = snapshot.friction.tasks.find((task) => task.taskId === "task_hot")!;
    const warm = snapshot.friction.tasks.find((task) => task.taskId === "task_warm")!;
    expect(hot.total).toBe(3);
    expect(hot.high).toBe(true);
    expect(warm.total).toBe(2);
    expect(warm.high).toBe(false);
    expect(snapshot.friction.highFrictionCount).toBe(1);
    expect(snapshot.friction.tasks[0]!.taskId).toBe("task_hot");
    expect(CADENCE_FRICTION_ALERT_THRESHOLD).toBe(2);
  });

  it("derives HUD delivery/throughput numbers and passes awaiting through without faking", () => {
    const events = feed([
      { id: "d1", type: "task_created", taskId: "task_done", at: "2026-09-20T00:00:00.000Z", revision: 1 },
      { id: "d2", type: "task_completed", taskId: "task_done", at: "2026-09-20T02:00:00.000Z", revision: 2 },
      { id: "d3", type: "task_completed", taskId: "task_old", at: EARLIER_DAY, revision: 3 },
    ]);
    const snapshot = deriveCadenceSnapshot({
      events,
      tasks: [
        cadenceTask({ taskId: "task_done", coordinationStatus: "done" }),
        cadenceTask({ taskId: "task_old", coordinationStatus: "done" }),
        cadenceTask({ taskId: "task_live" }),
        cadenceTask({ taskId: "task_archived", packageDisposition: "archived" }),
      ],
      decisions: [],
      awaitingHuman: null,
      now: NOW,
    });
    expect(snapshot.hud.activeTasks).toBe(1);
    expect(snapshot.hud.completedToday).toBe(1);
    expect(snapshot.hud.completedInWindow).toBe(2);
    expect(snapshot.hud.avgDeliveryMs).toBe(2 * 3_600_000);
    expect(snapshot.hud.awaitingHuman).toBeNull();
  });

  it("flags stalled non-terminal tasks by last activity and keeps quiet tasks visible", () => {
    const snapshot = deriveCadenceSnapshot({
      events: [],
      tasks: [
        cadenceTask({ taskId: "task_stale", lastKnownAt: EARLIER_DAY }),
        cadenceTask({ taskId: "task_fresh", lastKnownAt: NOW }),
        cadenceTask({ taskId: "task_closed", coordinationStatus: "done", lastKnownAt: EARLIER_DAY }),
      ],
      decisions: [],
      awaitingHuman: 3,
      now: NOW,
    });
    expect(snapshot.hud.activeTasks).toBe(2);
    expect(snapshot.hud.stalledActive).toBe(1);
    expect(snapshot.friction.stalled.map((task) => task.taskId)).toEqual(["task_stale"]);
    expect(snapshot.hud.awaitingHuman).toBe(3);
    const quiet = snapshot.rhythm.find((row) => row.taskId === "task_stale")!;
    expect(quiet.eventCount).toBe(0);
    expect(quiet.currentStage).toBeNull();
    expect(quiet.stalled).toBe(true);
    expect(snapshot.rhythm.some((row) => row.taskId === "task_closed")).toBe(false);
  });

  it("aggregates yield: facts today, newest-first recent facts, decision states, module heat", () => {
    const factSeeds = Array.from({ length: CADENCE_RECENT_FACTS + 2 }, (_, index) => ({
      id: `fact-${index}`,
      type: "fact_recorded",
      taskId: "task_a",
      factId: `F-${index}`,
      at: `2026-09-20T0${index}:00:00.000Z`,
      revision: index + 1,
    }));
    const events = feed([
      ...factSeeds,
      { id: "old-fact", type: "fact_recorded", taskId: "task_a", factId: "F-old", at: EARLIER_DAY, revision: 0 },
    ]);
    const snapshot = deriveCadenceSnapshot({
      events,
      tasks: [
        cadenceTask({ taskId: "task_a", module: "gui" }),
        cadenceTask({ taskId: "task_b", module: "daemon" }),
        cadenceTask({ taskId: "task_c", module: "gui" }),
      ],
      decisions: [{ state: "proposed" }, { state: "proposed" }, { state: "in_effect" }, { state: "superseded" }],
      awaitingHuman: 0,
      now: NOW,
    });
    expect(snapshot.yield.factsToday).toBe(CADENCE_RECENT_FACTS + 2);
    expect(snapshot.yield.recentFacts).toHaveLength(CADENCE_RECENT_FACTS);
    expect(snapshot.yield.recentFacts[0]!.factId).toBe(`F-${CADENCE_RECENT_FACTS + 1}`);
    expect(snapshot.yield.decisionsProposed).toBe(2);
    expect(snapshot.yield.decisionsInEffect).toBe(1);
    expect(snapshot.yield.moduleHeat[0]).toMatchObject({ module: "gui", events: factSeeds.length + 1, tasks: 1 });
  });

  it("keeps event-only tasks honest as unknown rows outside the projection", () => {
    const snapshot = deriveCadenceSnapshot({
      events: feed([{ id: "x1", type: "task_created", taskId: "task_ghost", revision: 1 }]),
      tasks: [],
      decisions: [],
      awaitingHuman: 0,
      now: NOW,
    });
    const ghost = snapshot.rhythm.find((row) => row.taskId === "task_ghost")!;
    expect(ghost.known).toBe(false);
    expect(ghost.status).toBe("unknown");
    expect(ghost.module).toBeNull();
  });

  it("caps module heat at the configured top list size", () => {
    const modules = Array.from({ length: CADENCE_MODULE_TOP + 3 }, (_, index) => `m${index}`);
    const events = feed(
      modules.flatMap((module, taskIndex) => [
        { id: `t${taskIndex}`, type: "task_created", taskId: `task_${taskIndex}`, revision: taskIndex + 1 },
      ]),
    );
    const snapshot = deriveCadenceSnapshot({
      events,
      tasks: modules.map((module, index) => cadenceTask({ taskId: `task_${index}`, module })),
      decisions: [],
      awaitingHuman: 0,
      now: NOW,
    });
    expect(snapshot.yield.moduleHeat).toHaveLength(CADENCE_MODULE_TOP);
  });
});

describe("cadence aggregation cost (数量级证据,非回归门槛)", () => {
  it("derives a full 4096-event window over 300 projected tasks well under the 50ms budget", () => {
    const events = mergeCadenceEvents(
      [],
      Array.from({ length: CADENCE_EVENT_LIMIT }, (_, index) =>
        cadenceEventOf(
          seedToItem({
            id: `perf-${index}`,
            type: [
              "task_created",
              "lease_renewed",
              "task_progress_appended",
              "fact_recorded",
              "completion_gate_verified",
            ][index % 5]!,
            taskId: `task_${index % 300}`,
            factId: index % 5 === 3 ? `F-${index}` : undefined,
            revision: index,
            at: new Date(Date.parse(NOW) - (CADENCE_EVENT_LIMIT - index) * 1_000).toISOString(),
          }),
        ),
      ),
    );
    const tasks = Array.from({ length: 300 }, (_, index) => cadenceTask({ taskId: `task_${index}` }));
    const started = performance.now();
    const snapshot = deriveCadenceSnapshot({ events, tasks, decisions: [], awaitingHuman: 0, now: NOW });
    const elapsed = performance.now() - started;
    expect(snapshot.rhythm).toHaveLength(300);
    expect(snapshot.hud.completedInWindow + snapshot.yield.factsToday).toBeGreaterThan(0);
    console.log(
      `[cadence-perf] deriveCadenceSnapshot over ${events.length} events / ${tasks.length} tasks: ${elapsed.toFixed(1)}ms`,
    );
    expect(elapsed).toBeLessThan(50);
  });
});
