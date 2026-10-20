import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Timer } from "@phosphor-icons/react";
import { formatDuration } from "../../model/time.ts";

/**
 * Prompt Cache 剩余 TTL 倒计时胶囊(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 / Orca CacheTimer):
 * 大模型 Prompt Cache 有 5 分钟 TTL,击穿后下一轮按未缓存输入重发完整上下文(约 10x
 * 输入成本),让操作者在击穿前连贯提问。
 *
 * 三态色梯:剩余 >60s 中性灰;<=60s 琥珀预警 + 小圆点 opacity 脉冲(点级循环动效,
 * reduced-motion 时静止);过期只留红色计时图标,不显示负数秒,Tooltip 写明成本对价。
 * 时间戳缺失渲染 null——不虚构倒计时(Orca 调研:无准确 lastCacheTouch 时不得伪造)。
 *
 * 计时器纪律:注入 nowMs(单测/确定性场景)时完全不建 interval;未注入时 1s tick,
 * 卸载或已过期即清理。倒计时文字走 formatDuration(时长显示唯一实现);字号用
 * ui-micro 字阶 token(11px 等宽档,视觉密度守护禁页面裸写 <=12px 字号),等宽表格
 * 数字 + 最小宽度预占,数字变化不挤压相邻元素。
 */

/** 临近过期的预警阈值(秒):Orca 同款 60s 黄灯窗口。 */
export const CACHE_WARN_SECONDS = 60;

/** 过期态 Tooltip 的成本对价说明(拒收条件:过期态必须写明 10x 对价)。 */
export const CACHE_EXPIRED_TIP = "缓存已过期：下一轮将重发未缓存完整上下文（10x 成本）";

export function CacheTimer({
  lastCacheTouchAt,
  ttlMs = 300_000,
  nowMs,
  testId,
}: {
  /** 最近一次 LLM 缓存触达时间(ms epoch);null=未知,渲染 null。多会话由调用方取最短 TTL。 */
  readonly lastCacheTouchAt: number | null;
  /** 缓存 TTL;Anthropic Prompt Cache 为 5 分钟。 */
  readonly ttlMs?: number;
  /** 测试注入的基准时间;给出时不建 interval,读数完全确定。 */
  readonly nowMs?: number;
  readonly testId?: string;
}) {
  const reducedMotion = useReducedMotion();
  const [liveNow, setLiveNow] = useState(() => nowMs ?? Date.now());
  const expiresAt = lastCacheTouchAt === null ? null : lastCacheTouchAt + ttlMs;
  const remainingMs = expiresAt === null ? 0 : expiresAt - (nowMs ?? liveNow);

  useEffect(() => {
    if (nowMs !== undefined || expiresAt === null || remainingMs <= 0) return;
    const timer = setInterval(() => setLiveNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [nowMs, expiresAt, remainingMs]);

  if (lastCacheTouchAt === null || expiresAt === null) return null;

  if (remainingMs <= 0) {
    return (
      <span
        data-testid={testId}
        data-cache-state="expired"
        data-tip={CACHE_EXPIRED_TIP}
        className="inline-flex shrink-0 items-center gap-1 rounded-xs border px-1.5 py-px font-mono tabular-nums ui-micro"
        style={{
          color: "var(--color-danger)",
          borderColor: "color-mix(in oklch, var(--color-danger) 36%, transparent)",
        }}
      >
        <Timer weight="bold" aria-hidden />
        <span className="sr-only">{CACHE_EXPIRED_TIP}</span>
      </span>
    );
  }

  const warn = remainingMs <= CACHE_WARN_SECONDS * 1_000;
  const color = warn ? "var(--color-status-submitted)" : "var(--color-text-muted)";
  const remainingText = formatDuration(remainingMs);
  return (
    <span
      role="timer"
      aria-live="off"
      aria-label={`Prompt 缓存剩余 ${remainingText}`}
      data-testid={testId}
      data-cache-state={warn ? "warn" : "ok"}
      className="inline-flex min-w-[7ch] shrink-0 items-center justify-center gap-1 rounded-xs border border-transparent px-1.5 py-px font-mono tabular-nums ui-micro"
      style={{ color }}
    >
      {warn && (
        <motion.span
          aria-hidden
          className="inline-block size-[5px] shrink-0 rounded-full"
          style={{ background: color }}
          animate={reducedMotion ? undefined : { opacity: [0.45, 1, 0.45] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      {remainingText}
    </span>
  );
}
