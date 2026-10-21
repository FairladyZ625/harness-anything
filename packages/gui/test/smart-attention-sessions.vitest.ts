// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import {
  applyLifecycleEventsToSession,
  applyLifecycleEventsToSessionGroups,
  epochMsOf,
  needsYouRefs,
  sessionEventTimeline,
  sessionGroupNeedsYou,
  settledCacheTtl,
  type SessionGroup,
  type SessionLifecycleEvent,
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

describe("收口后的缓存倒计时 settledCacheTtl", () => {
  const TTL = 300_000;

  it("在跑会话(轮内)不显示:running/blocked/unknown 触达再新也返回 null", () => {
    // 无头 worker 整轮只在本轮内反复调模型,生命周期读面看不到触达推进;
    // 这正是修前「启动满 5 分钟全体判 expired」的误报面。
    for (const status of ["running", "blocked", "unknown", "lost", "unavailable"] as const) {
      expect(settledCacheTtl(status, NOW - 400_000, TTL, NOW)).toBeNull();
      expect(settledCacheTtl(status, NOW, TTL, NOW)).toBeNull();
    }
  });

  it("一轮结束后按真实 TTL 倒计时:终态 + 已知 TTL + 触达证据三者齐", () => {
    for (const status of ["succeeded", "failed", "cancelled", "stopped", "ended-indeterminate"] as const) {
      expect(settledCacheTtl(status, NOW - 240_000, TTL, NOW)).toEqual({
        kind: "warning",
        remainingMs: 60_000,
      });
    }
    expect(settledCacheTtl("succeeded", NOW - 120_000, TTL, NOW)).toEqual({
      kind: "normal",
      remainingMs: 180_000,
    });
    expect(settledCacheTtl("succeeded", NOW - TTL - 1, TTL, NOW)?.kind).toBe("expired");
  });

  it("未知 provider TTL 或无触达证据都不虚构:终态也返回 null", () => {
    expect(settledCacheTtl("succeeded", NOW - 60_000, null, NOW)).toBeNull();
    expect(settledCacheTtl("succeeded", null, TTL, NOW)).toBeNull();
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

  it("exited:与 kernel runtimeSessionSemanticState 对齐——outcome 缺失 → unavailable,unknown → ended-indeterminate", () => {
    const exitedMissing = applyLifecycleEventsToSession(session(), [
      event(2, "runtime_session_exited", "2026-10-20T12:02:00.000Z"),
    ]);
    expect(exitedMissing.liveness).toBe("exited");
    expect(exitedMissing.semanticState).toBe("unavailable");
    const exitedUnknown = applyLifecycleEventsToSession(
      session({ activity: { ...session().activity, outcome: "unknown" } }),
      [event(2, "runtime_session_exited", "2026-10-20T12:02:00.000Z")],
    );
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

  it("未命中的组保持同一引用;无组命中时数组也保持原引用(集合级,不触发无谓重渲)", () => {
    const untouched = group({ key: "task-b", taskId: "task-b" });
    const groups = [runningGroup, untouched];
    const patched = applyLifecycleEventsToSessionGroups(groups, [
      event(1, "runtime_session_started", "2026-10-20T12:00:00.000Z", "rs-other"),
    ]);
    expect(patched[0]).toBe(runningGroup); // 有 round 但事件不归属它:同一引用
    expect(patched[1]).toBe(untouched); // 无 round:同一引用
    expect(patched).toBe(groups);
  });
});
