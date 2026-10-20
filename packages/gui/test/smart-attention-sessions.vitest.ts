// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import {
  applyLifecycleEventsToSession,
  applyLifecycleEventsToSessionGroups,
  epochMsOf,
  needsYouRefs,
  sessionAttention,
  sessionCacheTouchesByTask,
  sessionEventTimeline,
  sessionGroupAttention,
  sessionGroupNeedsYou,
  sessionRoundAttention,
  type SessionGroup,
  type SessionLifecycleEvent,
  type SessionRound,
} from "../src/renderer/sessions-model.ts";

/**
 * 会话侧注意力投影与生命周期增量补丁(dec_C0AF8CBBFFECF71F4F34FB76F9/CH3):
 * needsYou 从 awaits 引用集命中;补丁只改事件能无歧义决定的字段,未命中保持原引用。
 */

const NOW = Date.parse("2026-10-20T12:00:00.000Z");

const group = (overrides: Partial<SessionGroup> = {}): SessionGroup => ({
  key: "task-a",
  kind: "task",
  label: "Task A",
  taskId: "task-a",
  latestStatus: "succeeded",
  latestActivityAt: "2026-10-20T11:59:30.000Z",
  runningCount: 0,
  sessionCount: 2,
  roundCount: 2,
  latestRound: null,
  ...overrides,
});

const session = (overrides: Partial<AgentRuntimeSessionDto> = {}): AgentRuntimeSessionDto => ({
  runtimeSessionId: "rs-1",
  providerSessionId: "p-1",
  instanceId: "inst-1",
  installationId: "install-1",
  kindId: "claude",
  definitionSnapshotRef: "artifact:runtime-definition/test",
  definitionSnapshot: null,
  definitionSnapshotPersisted: true,
  liveness: "live",
  semanticState: "running",
  attachCapability: "supported",
  streamCursor: null,
  associations: [{ taskId: "task-a", executionId: "exec-1", holder: null, lease: null }],
  activity: {
    lastObservedAt: "2026-10-20T11:59:00.000Z",
    outcome: null,
    exitCode: null,
    resultRef: null,
    missingEvidence: null,
  },
  ...overrides,
});

const event = (
  cursor: number,
  type: SessionLifecycleEvent["type"],
  occurredAt: string,
  runtimeSessionId = "rs-1",
): SessionLifecycleEvent => ({ cursor: `lifecycle:${cursor}`, runtimeSessionId, type, occurredAt });

const round = (overrides: Partial<SessionRound> = {}): SessionRound => ({
  kind: "round",
  roundIndex: 1,
  runtimeSessionId: "rs-1",
  dispatchId: "dispatch-1",
  agentId: null,
  agentName: null,
  squadId: null,
  instanceId: "inst-1",
  taskId: "task-a",
  taskTitle: "Task A",
  startedAt: "2026-10-20T11:50:00.000Z",
  endedAt: null,
  status: "running",
  classification: null,
  resume: null,
  nextAction: null,
  delegation: null,
  ...overrides,
});

describe("needsYou 引用集", () => {
  it("awaits 边源实体 + 待审批 decision 都进集合;组级按 task/decision 前缀命中", () => {
    const refs = needsYouRefs([{ sourceRef: "task/task-a" }], ["dec_9"]);
    expect(refs.has("task/task-a")).toBe(true);
    expect(refs.has("decision/dec_9")).toBe(true);
    expect(sessionGroupNeedsYou(group(), refs)).toBe(true);
    expect(sessionGroupNeedsYou(group({ taskId: "task-b", key: "task-b" }), refs)).toBe(false);
    const decisionGroup = group({ kind: "decision", key: "dec_9", decisionId: "dec_9", taskId: undefined });
    expect(sessionGroupNeedsYou(decisionGroup, refs)).toBe(true);
    // 未归属组不可能命中
    expect(sessionGroupNeedsYou(group({ kind: "unattributed", key: "u", taskId: undefined }), refs)).toBe(false);
  });
});

describe("事件时间线", () => {
  it("最后一条事件是最近活动;缓存触达只认 started/outcome_observed", () => {
    const timeline = sessionEventTimeline([
      event(1, "runtime_session_started", "2026-10-20T11:00:00.000Z"),
      event(2, "runtime_dispatch_requested", "2026-10-20T11:30:00.000Z"),
      event(3, "runtime_session_outcome_observed", "2026-10-20T11:45:00.000Z"),
      event(4, "runtime_session_liveness_changed", "2026-10-20T11:50:00.000Z"),
    ]);
    expect(timeline.lastTurnActivityAt).toBe(Date.parse("2026-10-20T11:50:00.000Z"));
    expect(timeline.lastCacheTouchAt).toBe(Date.parse("2026-10-20T11:45:00.000Z"));
  });

  it("空事件与不可解析时间戳都返回 null,不虚构", () => {
    expect(sessionEventTimeline([])).toEqual({ lastTurnActivityAt: null, lastCacheTouchAt: null });
    expect(epochMsOf("not-a-date")).toBeNull();
    expect(epochMsOf(null)).toBeNull();
  });
});

describe("注意力投影", () => {
  it("会话级:awaits 命中 → 1;事件时间线驱动 TTL", () => {
    const refs = needsYouRefs([{ sourceRef: "task/task-a" }]);
    const attention = sessionAttention(
      session(),
      refs,
      { lastTurnActivityAt: NOW - 60_000, lastCacheTouchAt: NOW - 240_000 },
      NOW,
    );
    expect(attention.smartClass).toBe(1);
    expect(attention.needsYou).toBe(true);
    expect(attention.lastCacheTouchAt).toBe(NOW - 240_000);
    expect(attention.cacheTtl).toEqual({ kind: "warning", remainingMs: 60_000 });
  });

  it("会话级:已收口且新鲜 → 2;时间线缺省时回退 lastObservedAt,缓存触达未知则 TTL 为 null", () => {
    const attention = sessionAttention(
      session({
        semanticState: "succeeded",
        liveness: "exited",
        activity: {
          lastObservedAt: "2026-10-20T11:59:00.000Z",
          outcome: "succeeded",
          exitCode: 0,
          resultRef: null,
          missingEvidence: null,
        },
      }),
      new Set(),
      undefined,
      NOW,
    );
    expect(attention.smartClass).toBe(2);
    expect(attention.lastTurnActivityAt).toBe(Date.parse("2026-10-20T11:59:00.000Z"));
    expect(attention.cacheTtl).toBeNull();
  });

  it("组级:终态以 latestActivityAt 近似收口;成员触达取最早失效", () => {
    const attention = sessionGroupAttention(group(), new Set(), [NOW - 100_000, NOW - 280_000], NOW);
    expect(attention.smartClass).toBe(2); // 30s 前收口,新鲜
    expect(attention.lastCacheTouchAt).toBe(NOW - 280_000);
    expect(attention.cacheTtl).toEqual({ kind: "warning", remainingMs: 20_000 });
  });

  it("组级:running 组无触达证据时 TTL 为 null;needsYou 命中优先", () => {
    const refs = needsYouRefs([{ sourceRef: "task/task-a" }]);
    const attention = sessionGroupAttention(group({ latestStatus: "running", runningCount: 1 }), refs, [], NOW);
    expect(attention.smartClass).toBe(1);
    expect(attention.cacheTtl).toBeNull();
  });

  it("轮次级:blocked → 1;新鲜 endedAt 的 succeeded → 2;无 endedAt 的终态 → 5", () => {
    expect(sessionRoundAttention(round({ status: "blocked" }), new Set(), NOW).smartClass).toBe(1);
    expect(
      sessionRoundAttention(round({ status: "succeeded", endedAt: "2026-10-20T11:59:30.000Z" }), new Set(), NOW)
        .smartClass,
    ).toBe(2);
    expect(sessionRoundAttention(round({ status: "succeeded" }), new Set(), NOW).smartClass).toBe(5);
    expect(sessionRoundAttention(round({ status: "running" }), new Set(), NOW).cacheTtl).toBeNull();
  });
});

describe("缓存触达按任务分桶", () => {
  it("只收有事件证据的会话;无证据的会话不进桶(不虚构)", () => {
    const touches = sessionCacheTouchesByTask(
      [
        session(),
        session({
          runtimeSessionId: "rs-2",
          associations: [{ taskId: "task-b", executionId: "e2", holder: null, lease: null }],
        }),
      ],
      new Map([["rs-1", NOW - 100_000]]),
    );
    expect(touches.get("task-a")).toEqual([NOW - 100_000]);
    expect(touches.has("task-b")).toBe(false);
  });
});

describe("生命周期增量补丁:会话", () => {
  it("无命中事件原样返回同一引用", () => {
    const before = session();
    expect(
      applyLifecycleEventsToSession(before, [
        event(9, "runtime_session_started", "2026-10-20T12:00:00.000Z", "rs-other"),
      ]),
    ).toBe(before);
  });

  it("started → running/live 并推进 lastObservedAt;cancelled → 终态 cancelled", () => {
    const started = applyLifecycleEventsToSession(session({ semanticState: "unavailable", liveness: "unknown" }), [
      event(1, "runtime_session_started", "2026-10-20T12:00:00.000Z"),
    ]);
    expect(started.semanticState).toBe("running");
    expect(started.liveness).toBe("live");
    expect(started.activity.lastObservedAt).toBe("2026-10-20T12:00:00.000Z");
    const cancelled = applyLifecycleEventsToSession(started, [
      event(2, "runtime_session_cancelled", "2026-10-20T12:01:00.000Z"),
    ]);
    expect(cancelled.semanticState).toBe("cancelled");
    expect(cancelled.activity.outcome).toBe("cancelled");
  });

  it("exited:outcome 未知 → ended-indeterminate;已有 outcome 保留其词", () => {
    const exitedUnknown = applyLifecycleEventsToSession(session(), [
      event(2, "runtime_session_exited", "2026-10-20T12:02:00.000Z"),
    ]);
    expect(exitedUnknown.liveness).toBe("exited");
    expect(exitedUnknown.semanticState).toBe("ended-indeterminate");
    const exitedKnown = applyLifecycleEventsToSession(
      session({
        activity: {
          lastObservedAt: "2026-10-20T11:59:00.000Z",
          outcome: "failed",
          exitCode: 1,
          resultRef: null,
          missingEvidence: null,
        },
      }),
      [event(2, "runtime_session_exited", "2026-10-20T12:02:00.000Z")],
    );
    expect(exitedKnown.semanticState).toBe("failed");
  });

  it("outcome_observed 不猜终态词,只推进时间戳", () => {
    const patched = applyLifecycleEventsToSession(session(), [
      event(5, "runtime_session_outcome_observed", "2026-10-20T12:03:00.000Z"),
    ]);
    expect(patched.semanticState).toBe("running");
    expect(patched.activity.lastObservedAt).toBe("2026-10-20T12:03:00.000Z");
  });
});

describe("生命周期增量补丁:组", () => {
  const runningGroup = group({
    latestStatus: "running",
    runningCount: 1,
    latestActivityAt: "2026-10-20T11:58:00.000Z",
    latestRound: {
      runtimeSessionId: "rs-1",
      dispatchId: "dispatch-1",
      agentName: null,
      instanceId: "inst-1",
      status: "running",
      startedAt: "2026-10-20T11:58:00.000Z",
    },
  });

  it("latestRound 命中的组:时间戳推进 + 无歧义状态翻转 + runningCount 重算", () => {
    const patched = applyLifecycleEventsToSessionGroups(
      [runningGroup],
      [event(3, "runtime_session_exited", "2026-10-20T12:04:00.000Z")],
    )[0]!;
    expect(patched.latestActivityAt).toBe("2026-10-20T12:04:00.000Z");
    expect(patched.latestStatus).toBe("ended-indeterminate");
    expect(patched.runningCount).toBe(0);
    expect(patched.latestRound?.status).toBe("ended-indeterminate");
  });

  it("未命中的组保持同一引用(不触发无谓重渲)", () => {
    const untouched = group({ key: "task-b", taskId: "task-b" });
    expect(
      applyLifecycleEventsToSessionGroups(
        [untouched],
        [event(1, "runtime_session_started", "2026-10-20T12:00:00.000Z")],
      )[0],
    ).toBe(untouched);
  });
});
