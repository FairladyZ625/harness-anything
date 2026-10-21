// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  classifySmartAttention,
  compareBySmartAttention,
  computePromptCacheTtlState,
  countSmartAttention,
  DONE_FRESHNESS_MS,
  promptCacheTtlMsForKind,
  PROMPT_CACHE_TTL_WARNING_MS,
  sortBySmartAttention,
  type SmartAttentionSignal,
} from "../src/renderer/model/smart-attention.ts";

/**
 * 五级序数注意力与 Prompt Cache TTL 的纯函数契约(dec_C0AF8CBBFFECF71F4F34FB76F9/CH3):
 * - Needs you 永远排在 Working 之前(Reviewer 拒收条件);
 * - 无时间戳或无 provider 确定口径都不虚构倒计时(null);
 * - 时钟全部注入 nowMs,同输入同输出。
 */

const NOW = 1_700_000_000_000;
/** Anthropic 官方口径的 TTL(5 分钟),与 TTL 表同值,用于构造触达时间。 */
const ANTHROPIC_TTL_MS = 300_000;
const signal = (overrides: Partial<SmartAttentionSignal>): SmartAttentionSignal => ({
  status: "unknown",
  ...overrides,
});
/** 让剩余 TTL 恰好等于 desiredMs 的触达时间。 */
const touchForRemaining = (desiredMs: number): number => NOW + desiredMs - ANTHROPIC_TTL_MS;

describe("五级注意力分类", () => {
  it("1 Needs you:未决 awaits 证据或 blocked 状态,优先于一切", () => {
    expect(classifySmartAttention(signal({ status: "succeeded", settledAt: NOW - 1, needsYou: true }), NOW)).toBe(1);
    expect(classifySmartAttention(signal({ status: "blocked" }), NOW)).toBe(1);
    // lost/unverifiable 与 working 让位给 needs you
    expect(classifySmartAttention(signal({ status: "running", liveness: "live", needsYou: true }), NOW)).toBe(1);
  });

  it("2 Done:succeeded/failed/ended-indeterminate 且收口在新鲜度窗口内", () => {
    for (const status of ["succeeded", "failed", "ended-indeterminate"] as const) {
      expect(classifySmartAttention(signal({ status, settledAt: NOW - 1 }), NOW)).toBe(2);
      // 窗口边界:恰好 DONE_FRESHNESS_MS 仍算新鲜,超出 1ms 沉为 Idle
      expect(classifySmartAttention(signal({ status, settledAt: NOW - DONE_FRESHNESS_MS }), NOW)).toBe(2);
      expect(classifySmartAttention(signal({ status, settledAt: NOW - DONE_FRESHNESS_MS - 1 }), NOW)).toBe(5);
    }
  });

  it("被打断的完成(cancelled/stopped)与无收口时间的终态不进 Done", () => {
    expect(classifySmartAttention(signal({ status: "cancelled", settledAt: NOW - 1 }), NOW)).toBe(5);
    expect(classifySmartAttention(signal({ status: "stopped", settledAt: NOW - 1 }), NOW)).toBe(5);
    expect(classifySmartAttention(signal({ status: "succeeded", settledAt: null }), NOW)).toBe(5);
  });

  it("3 Working:running 且进程活性 live(组/轮次级读面省略 liveness 按 live)", () => {
    expect(classifySmartAttention(signal({ status: "running", liveness: "live" }), NOW)).toBe(3);
    expect(classifySmartAttention(signal({ status: "running" }), NOW)).toBe(3);
  });

  it("4 Unverifiable:进程应在但心跳超时/状态陈旧,以及 lost", () => {
    expect(classifySmartAttention(signal({ status: "running", liveness: "stale" }), NOW)).toBe(4);
    expect(classifySmartAttention(signal({ status: "running", liveness: "unknown" }), NOW)).toBe(4);
    expect(classifySmartAttention(signal({ status: "running", liveness: "exited" }), NOW)).toBe(4);
    expect(classifySmartAttention(signal({ status: "lost" }), NOW)).toBe(4);
  });

  it("5 Idle:闲置、unknown/unavailable、超龄完成", () => {
    expect(classifySmartAttention(signal({ status: "unknown" }), NOW)).toBe(5);
    expect(classifySmartAttention(signal({ status: "unavailable" }), NOW)).toBe(5);
    expect(classifySmartAttention(signal({ status: "succeeded", settledAt: NOW - DONE_FRESHNESS_MS - 1 }), NOW)).toBe(
      5,
    );
  });
});

describe("五级排序", () => {
  it("Needs you 排在 Working 之前,时间戳再新也不抢位", () => {
    const needsYou = signal({ status: "succeeded", settledAt: NOW, needsYou: true, lastTurnActivityAt: 1 }),
      working = signal({ status: "running", liveness: "live", lastTurnActivityAt: NOW });
    expect(compareBySmartAttention(needsYou, working, NOW)).toBeLessThan(0);
    expect(compareBySmartAttention(working, needsYou, NOW)).toBeGreaterThan(0);
  });

  it("全序按 1→5 排列,同级内最近活动新→旧,无时间戳殿后,再按状态词保证确定", () => {
    const idle = signal({ status: "unknown", lastTurnActivityAt: NOW }),
      working = signal({ status: "running", lastTurnActivityAt: NOW - 10 }),
      done = signal({ status: "succeeded", settledAt: NOW - 5, lastTurnActivityAt: NOW - 5 }),
      needsYou = signal({ status: "running", needsYou: true, lastTurnActivityAt: 1 }),
      staleWorking = signal({ status: "running", liveness: "stale", lastTurnActivityAt: NOW - 1 }),
      idleNoTimestamp = signal({ status: "unknown", lastTurnActivityAt: null });
    const ordered = sortBySmartAttention(
      [idle, working, done, needsYou, staleWorking, idleNoTimestamp],
      (item) => item,
      NOW,
    );
    expect(ordered.map((item) => classifySmartAttention(item, NOW))).toEqual([1, 2, 3, 4, 5, 5]);
    // 同为 5 级:有活动时间的新(unknown@NOW)在无时间戳的之前
    expect(ordered[4]).toBe(idle);
    expect(ordered[5]).toBe(idleNoTimestamp);
  });

  it("sortBySmartAttention 是纯函数:不改入参数组", () => {
    const items = [signal({ status: "unknown" }), signal({ status: "blocked" })],
      snapshot = [...items];
    sortBySmartAttention(items, (item) => item, NOW);
    expect(items).toEqual(snapshot);
  });
});

describe("分组聚合计数", () => {
  it("只数 Needs you / Running / Done 三段,其余级别不进任何段", () => {
    const counts = countSmartAttention(
      [
        signal({ status: "blocked" }),
        signal({ status: "running", liveness: "live" }),
        signal({ status: "succeeded", settledAt: NOW - 1 }),
        signal({ status: "running", liveness: "stale" }),
        signal({ status: "unknown" }),
        signal({ status: "succeeded", settledAt: NOW - DONE_FRESHNESS_MS - 1 }),
      ],
      NOW,
    );
    expect(counts).toEqual({ needsYou: 1, running: 1, done: 1 });
  });
});

describe("Prompt Cache TTL", () => {
  it("阈值:大于 60s 正常、1-60s 告警、<=0 过期、无/非法时间戳隐藏(null)", () => {
    expect(computePromptCacheTtlState(touchForRemaining(120_000), NOW, ANTHROPIC_TTL_MS)).toEqual({
      kind: "normal",
      remainingMs: 120_000,
    });
    expect(computePromptCacheTtlState(touchForRemaining(60_001), NOW, ANTHROPIC_TTL_MS)?.kind).toBe("normal");
    expect(computePromptCacheTtlState(touchForRemaining(60_000), NOW, ANTHROPIC_TTL_MS)).toEqual({
      kind: "warning",
      remainingMs: 60_000,
    });
    expect(computePromptCacheTtlState(touchForRemaining(1), NOW, ANTHROPIC_TTL_MS)?.kind).toBe("warning");
    expect(computePromptCacheTtlState(touchForRemaining(0), NOW, ANTHROPIC_TTL_MS)).toEqual({
      kind: "expired",
      remainingMs: 0,
    });
    expect(computePromptCacheTtlState(touchForRemaining(-5_000), NOW, ANTHROPIC_TTL_MS)?.kind).toBe("expired");
    expect(computePromptCacheTtlState(null, NOW, ANTHROPIC_TTL_MS)).toBeNull();
    expect(computePromptCacheTtlState(Number.NaN, NOW, ANTHROPIC_TTL_MS)).toBeNull();
  });

  it("TTL 表:只有公开确定口径的 runtime 有条目(Anthropic 5 分钟),其余 kind 一律 null", () => {
    expect(promptCacheTtlMsForKind("claude")).toBe(300_000);
    expect(promptCacheTtlMsForKind("claude-acp")).toBe(300_000);
    // 无确定口径的 provider 不套默认窗口:OpenAI 浮动区间、DeepSeek 数小时到数天、GLM 未公布。
    expect(promptCacheTtlMsForKind("codex")).toBeNull();
    expect(promptCacheTtlMsForKind("codex-acp")).toBeNull();
    expect(promptCacheTtlMsForKind("deepseek-harness")).toBeNull();
    expect(promptCacheTtlMsForKind("zcode")).toBeNull();
    expect(promptCacheTtlMsForKind("glm-acp")).toBeNull();
    expect(promptCacheTtlMsForKind("agy")).toBeNull();
    expect(promptCacheTtlMsForKind("kimi")).toBeNull();
    // 未知/缺失 kind 与 baseUrl 第三方端点覆盖(claude 适配 GLM 等)都不成立 Anthropic 口径。
    expect(promptCacheTtlMsForKind("does-not-exist")).toBeNull();
    expect(promptCacheTtlMsForKind(null)).toBeNull();
    expect(promptCacheTtlMsForKind(undefined)).toBeNull();
    expect(promptCacheTtlMsForKind("claude", "https://third-party.example")).toBeNull();
    expect(promptCacheTtlMsForKind("claude", null)).toBe(300_000);
  });

  it("未知 provider TTL 不虚构:触达时间再新鲜,ttlMs=null 也返回 null", () => {
    expect(computePromptCacheTtlState(NOW - 10_000, NOW, null)).toBeNull();
    expect(computePromptCacheTtlState(NOW - 10_000, NOW, promptCacheTtlMsForKind("deepseek-harness"))).toBeNull();
  });

  it("告警阈值是 UI 紧迫档常量,与 provider 无关", () => {
    expect(PROMPT_CACHE_TTL_WARNING_MS).toBe(60_000);
  });

  it("同输入同输出:时钟注入下重复计算结果一致(不读系统时钟)", () => {
    const touch = touchForRemaining(90_000);
    expect(computePromptCacheTtlState(touch, NOW, ANTHROPIC_TTL_MS)).toEqual(
      computePromptCacheTtlState(touch, NOW, ANTHROPIC_TTL_MS),
    );
    expect(classifySmartAttention(signal({ status: "succeeded", settledAt: NOW - 1 }), NOW)).toBe(
      classifySmartAttention(signal({ status: "succeeded", settledAt: NOW - 1 }), NOW),
    );
  });
});
