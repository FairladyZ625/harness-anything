import type { AgentRuntimeSessionGroupStatus } from "@harness-anything/daemon/protocol";

/**
 * Orca 五级序数智能注意力模型(dec_C0AF8CBBFFECF71F4F34FB76F9/CH3):多 Agent 并发时,
 * 列表排序的第一主键是「用户急迫性」而不是时间戳。全部是纯函数:时间一律由调用方注入
 * nowMs,模型内不读系统时钟,同输入同输出、测试可复现。
 */

/** 序数越小越需要注意力:1 Needs you > 2 Done > 3 Working > 4 Unverifiable > 5 Idle。 */
export type SmartClass = 1 | 2 | 3 | 4 | 5;

/** 会话状态词表与 sessions-model 的 SessionStatus 同源(daemon 投影词表),不另立枚举。 */
export type SmartAttentionStatus = AgentRuntimeSessionGroupStatus;

/** 分类的输入投影:全部字段来自 daemon 读面,时间戳是 epoch ms、未知为 null。 */
export interface SmartAttentionSignal {
  /** daemon 会话状态词表(running/succeeded/…/blocked/lost/unknown)。 */
  readonly status: SmartAttentionStatus;
  /**
   * 会话进程活性(session DTO 的 liveness)。组/轮次级读面没有该字段,省略按 live 处理:
   * 缺证据不是失联,只有显式 stale/unknown/exited 才把 running 降为不可验证。
   */
  readonly liveness?: "live" | "stale" | "unknown" | "exited";
  /**
   * 存在未决 awaits 关系、待审批决策或阻塞待输入。由调用方从 agenda awaitingYou
   * (dec_DF67F23066BAFE444190A191B5)等读面按源实体派生,模型不重复判断。
   */
  readonly needsYou?: boolean;
  /** 最近一轮活动(epoch ms,未知 null):同级排序新→旧,null 殿后。 */
  readonly lastTurnActivityAt?: number | null;
  /** 会话收口(进入终态)的时间(epoch ms,未知 null):Done 新鲜度窗口的判据。 */
  readonly settledAt?: number | null;
}

/**
 * 各 runtime kind 的 Prompt Cache TTL,只收 provider 公开口径给出确定值的条目:
 * Anthropic 官方文档为默认 5 分钟、每次命中刷新(platform.claude.com/docs/en/build-with-claude/
 * prompt-caching),claude 与 claude-acp 都是其官方端点。其余 provider 没有确定口径——
 * OpenAI 为「通常 5–10 分钟、闲时至多 1 小时」的浮动区间,DeepSeek 为「数小时到数天」,
 * GLM 未公布——一律不进表,查表得 null 就不显示倒计时,绝不套默认窗口。
 */
const PROMPT_CACHE_TTL_MS_BY_KIND: Readonly<Record<string, number>> = {
  claude: 300_000,
  "claude-acp": 300_000,
};
/** 剩余不足该值进入告警态:60 秒(UI 紧迫档,与 provider 无关)。 */
export const PROMPT_CACHE_TTL_WARNING_MS = 60_000;

/**
 * 该 runtime kind 的 Prompt Cache TTL;查不到返回 null。claude 走 baseUrl 第三方端点覆盖
 * (如 GLM 适配)时端点不是 Anthropic,其口径不成立,同样返回 null。
 */
export function promptCacheTtlMsForKind(kindId: string | null | undefined, baseUrl?: string | null): number | null {
  if (kindId == null || baseUrl) return null;
  const ttlMs = PROMPT_CACHE_TTL_MS_BY_KIND[kindId];
  return ttlMs === undefined ? null : ttlMs;
}
/** class 2「刚完成待收口」的新鲜度窗口;收口时间未知或超窗的终态沉为 Idle。 */
export const DONE_FRESHNESS_MS = 300_000;

/**
 * 五级分类。HA 状态词表 → 序数的映射(词表语义见 dispatch-read.ts 的 blocked 派生与
 * kernel runtimeSessionSemanticState):
 * - 1 Needs you:未决 awaits / 待审批(needsYou),或 status=blocked(结构化阻塞=提问/审批阻断);
 * - 2 Done:succeeded/failed/ended-indeterminate 且 settledAt 在新鲜度窗口内;
 *   cancelled/stopped 是被打断的完成,Orca 归 Idle 不归 Done;
 * - 3 Working:running 且 liveness live(或省略);
 * - 4 Unverifiable:进程应在但心跳超时/状态陈旧:running + stale/unknown/exited,或 lost(失联,进程可能还在);
 * - 5 Idle:其余——闲置、被打断、超龄完成、无收口时间戳的终态(不虚构新鲜度)。
 */
export function classifySmartAttention(signal: SmartAttentionSignal, nowMs: number): SmartClass {
  if (signal.needsYou === true || signal.status === "blocked") return 1;
  if (signal.status === "succeeded" || signal.status === "failed" || signal.status === "ended-indeterminate") {
    const settledAt = signal.settledAt ?? null;
    return settledAt !== null && nowMs - settledAt <= DONE_FRESHNESS_MS ? 2 : 5;
  }
  if (signal.status === "cancelled" || signal.status === "stopped") return 5;
  if (signal.status === "lost") return 4;
  if (signal.status === "running") return signal.liveness === "live" || signal.liveness === undefined ? 3 : 4;
  return 5;
}

/** 同级内先按最近活动新→旧,再按状态词,保证全序确定(排序器不许返回 0 以外的摇摆)。 */
export function compareBySmartAttention(
  left: SmartAttentionSignal,
  right: SmartAttentionSignal,
  nowMs: number,
): number {
  const byClass = classifySmartAttention(left, nowMs) - classifySmartAttention(right, nowMs);
  if (byClass !== 0) return byClass;
  const leftAt = left.lastTurnActivityAt ?? null,
    rightAt = right.lastTurnActivityAt ?? null;
  if (leftAt !== null && rightAt !== null && leftAt !== rightAt) return rightAt - leftAt;
  if (leftAt !== null && rightAt === null) return -1;
  if (leftAt === null && rightAt !== null) return 1;
  return left.status < right.status ? -1 : left.status > right.status ? 1 : 0;
}

/** 纯排序:返回新数组,不改动入参。 */
export function sortBySmartAttention<T>(
  items: readonly T[],
  signalOf: (item: T) => SmartAttentionSignal,
  nowMs: number,
): readonly T[] {
  return [...items].sort((left, right) => compareBySmartAttention(signalOf(left), signalOf(right), nowMs));
}

/** 分组聚合计数:总览/侧栏三段徽章(Needs you / Running / Done)的数据源。 */
export interface SmartAttentionCounts {
  readonly needsYou: number;
  readonly running: number;
  readonly done: number;
}
export function countSmartAttention(signals: readonly SmartAttentionSignal[], nowMs: number): SmartAttentionCounts {
  let needsYou = 0,
    running = 0,
    done = 0;
  for (const signal of signals) {
    const smartClass = classifySmartAttention(signal, nowMs);
    if (smartClass === 1) needsYou += 1;
    else if (smartClass === 2) done += 1;
    else if (smartClass === 3) running += 1;
  }
  return { needsYou, running, done };
}

/** TTL 剩余状态三态;null 表示隐藏(无已知触达时间,不虚构倒计时)。 */
export type PromptCacheTtlState =
  | { readonly kind: "normal"; readonly remainingMs: number }
  | { readonly kind: "warning"; readonly remainingMs: number }
  | { readonly kind: "expired"; readonly remainingMs: number };

/**
 * 单会话 Prompt Cache TTL 剩余:remainingMs = lastCacheTouchAt + ttlMs - nowMs。
 * lastCacheTouchAt 未知(null/非有限)或该 provider 无确定 TTL(ttlMs null/非有限)都返回
 * null——缓存击穿的代价提示只建立在真实观测到的触达时间与真实 provider 口径上。
 * 阈值:≤0 过期、≤60s 告警、其余正常。
 */
export function computePromptCacheTtlState(
  lastCacheTouchAt: number | null,
  nowMs: number,
  ttlMs: number | null,
): PromptCacheTtlState | null {
  if (
    lastCacheTouchAt === null ||
    !Number.isFinite(lastCacheTouchAt) ||
    !Number.isFinite(nowMs) ||
    ttlMs === null ||
    !Number.isFinite(ttlMs)
  )
    return null;
  const remainingMs = lastCacheTouchAt + ttlMs - nowMs;
  if (remainingMs <= 0) return { kind: "expired", remainingMs };
  if (remainingMs <= PROMPT_CACHE_TTL_WARNING_MS) return { kind: "warning", remainingMs };
  return { kind: "normal", remainingMs };
}

/** 视图用的级别文案 key(与 sessions-model 的 sessionStatusKey 同一模式,词条落在 i18n 目录)。 */
export const smartClassLabelKey: Readonly<Record<SmartClass, string>> = {
  1: "agentRuntime.smartClassNeedsYou",
  2: "agentRuntime.smartClassDone",
  3: "agentRuntime.smartClassWorking",
  4: "agentRuntime.smartClassUnverifiable",
  5: "agentRuntime.smartClassIdle",
};
