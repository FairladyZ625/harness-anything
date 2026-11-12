// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
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
