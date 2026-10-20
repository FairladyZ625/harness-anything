import { motion, useReducedMotion } from "motion/react";
import { Timer } from "@phosphor-icons/react";
import { formatDuration } from "../../model/time.ts";
import { t } from "../../i18n/index.tsx";

/**
 * Prompt Cache 剩余 TTL 倒计时胶囊(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 / Orca CacheTimer):
 * 大模型 Prompt Cache 有 5 分钟 TTL,击穿后下一轮按未缓存输入重发完整上下文(约 10x
 * 输入成本),让操作者在击穿前连贯提问。
 *
 * 纯受控展示组件(CEO 返工裁定 F1):TTL 窗口、剩余毫秒与三态判定全部由模型层
 * (W1-T1 `computePromptCacheTtlState` 同名同义形状)算好后传入,本组件只负责格式化、
 * 三态样式与过期成本对价提示;模型无 TTL 数据时调用方直接不渲染,不虚构倒计时。
 *
 * 三态:normal=中性灰剩余时长;warning=琥珀色 + 小圆点 opacity 脉冲(点级循环动效,
 * reduced-motion 时静止);expired=只留红色计时图标,不显示秒数,Tooltip 写明 10x
 * 成本对价。文字走 formatDuration(时长显示唯一实现),字号用 ui-micro 字阶 token
 * (视觉密度守护禁页面裸写 <=12px 字号),等宽表格数字 + 最小宽度预占,数字变化不
 * 挤压相邻元素。
 */

/** TTL 三态,与 W1-T1 computePromptCacheTtlState 的返回词同名同义;接线归 W2。 */
export type PromptCacheTtlState = "normal" | "warning" | "expired";

export function CacheTimer({
  remainingMs,
  state,
  testId,
}: {
  /** 模型层算好的剩余毫秒;expired 态不展示该值。 */
  readonly remainingMs: number;
  readonly state: PromptCacheTtlState;
  readonly testId?: string;
}) {
  const reducedMotion = useReducedMotion();
  const expiredTip = t("agentUi.cache.expiredTip");

  if (state === "expired") {
    return (
      <span
        data-testid={testId}
        data-cache-state="expired"
        data-tip={expiredTip}
        className="inline-flex shrink-0 items-center gap-1 rounded-xs border px-1.5 py-px font-mono tabular-nums ui-micro"
        style={{
          color: "var(--color-danger)",
          borderColor: "color-mix(in oklch, var(--color-danger) 36%, transparent)",
        }}
      >
        <Timer weight="bold" aria-hidden />
        <span className="sr-only">{expiredTip}</span>
      </span>
    );
  }

  const warning = state === "warning";
  const color = warning ? "var(--color-status-submitted)" : "var(--color-text-muted)";
  const remainingText = formatDuration(Math.max(0, remainingMs));
  return (
    <span
      role="timer"
      aria-live="off"
      aria-label={t("agentUi.cache.ariaRemaining", { duration: remainingText })}
      data-testid={testId}
      data-cache-state={state}
      className="inline-flex min-w-[7ch] shrink-0 items-center justify-center gap-1 rounded-xs border border-transparent px-1.5 py-px font-mono tabular-nums ui-micro"
      style={{ color }}
    >
      {warning && (
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
