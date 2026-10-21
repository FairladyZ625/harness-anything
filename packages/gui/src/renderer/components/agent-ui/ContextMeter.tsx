import { compactTokens, percentText } from "../../token-format.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 上下文水位条(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 / Affect UI ContextWindow):分段占用比例
 * 与高水位预警色。分段色取统计图定序分类 token(--color-viz-*),不与状态色共用;数字走
 * token-format.ts 的统一格式。
 *
 * 两种口径,由 `limitTokens` 是否存在区分,不互相冒充:
 * - 给上限(窗口填充):role=meter + 「已用 / 上限 · 百分比」+ warn/danger 水位档。上限必须
 *   来自 provider 自报的窗口(见 daemon 的 context 投影),调用方不得给默认值。
 * - 不给上限(组成占比):累计消耗按总量占比画分段,读数是总量,没有 meter 角色、没有百分比、
 *   没有水位档——累计 token 不是上下文窗口占用。
 *
 * 纯展示组件,无计时器:读数完全由 props 决定,实时刷新由调用方的响应式数据流驱动
 * (W1-T1)。
 */

/** 分段种类:与 Token 消耗页的四类 token 口径一致,另有 reserve(预留/系统占用)。 */
export type ContextSegmentKind = "cache" | "cache-write" | "input" | "output" | "reserve";

export interface ContextSegment {
  readonly kind: ContextSegmentKind;
  /** 人话分段名(如「缓存上下文」「本轮输入」),同时用于图例与 data-tip。 */
  readonly label: string;
  readonly tokens: number;
}

const SEGMENT_COLOR: Record<ContextSegmentKind, string> = {
  cache: "var(--color-viz-cache)",
  "cache-write": "var(--color-viz-cache-write)",
  input: "var(--color-viz-input)",
  output: "var(--color-viz-output)",
  reserve: "var(--color-viz-rest)",
};

/** 高水位两档:warn 起琥珀(并保留所有分段),danger 起红色并提示逼近上限。 */
export const CONTEXT_HIGH_WATER = 0.8;
export const CONTEXT_DANGER = 0.92;

export function ContextMeter({
  segments,
  limitTokens,
  highWaterRatio = CONTEXT_HIGH_WATER,
  dangerRatio = CONTEXT_DANGER,
  testId,
}: {
  readonly segments: readonly ContextSegment[];
  /** 上下文窗口上限(Token),只接受 provider 自报值;省略即组成占比口径。 */
  readonly limitTokens?: number;
  readonly highWaterRatio?: number;
  readonly dangerRatio?: number;
  readonly testId?: string;
}) {
  const used = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  // 口径由是否给了上限决定,不由上限是否为正决定:provider 报 0 仍是窗口口径(只是分母退化),
  // 而累计消耗根本没有上限可谈。
  const windowed = limitTokens !== undefined;
  // 组成口径的分母是总量本身:没有任何 token 时没有可画的比例。
  const denominator = windowed ? limitTokens : used;
  const ratio = denominator > 0 ? used / denominator : 0;
  const bounded = denominator > 0;
  const level = !windowed ? null : ratio >= dangerRatio ? "danger" : ratio >= highWaterRatio ? "warn" : "ok";
  const levelColor =
    level === "danger"
      ? "var(--color-danger)"
      : level === "warn"
        ? "var(--color-status-submitted)"
        : "var(--color-text-muted)";
  const visible = segments.filter((segment) => segment.tokens > 0);
  const readout = windowed
    ? `${compactTokens(used)} / ${compactTokens(denominator)} · ${percentText(ratio)}`
    : compactTokens(used);

  return (
    <div data-testid={testId} data-context-level={level ?? undefined} className="flex min-w-0 flex-col gap-1">
      <div
        // 无窗口就没有可报的水位:meter 角色会谎称一个 0-100% 的刻度,故只在窗口口径下出现。
        {...(windowed
          ? {
              role: "meter" as const,
              "aria-valuemin": 0,
              "aria-valuemax": denominator,
              "aria-valuenow": used,
              "aria-valuetext":
                t("agentUi.context.usedOf", {
                  used: compactTokens(used),
                  limit: compactTokens(denominator),
                  percent: percentText(ratio),
                }) +
                (level === "danger"
                  ? t("agentUi.context.nearLimit")
                  : level === "warn"
                    ? t("agentUi.context.highWater")
                    : ""),
              "aria-label": t("agentUi.context.ariaLabel"),
              tabIndex: 0,
            }
          : {})}
        className="flex min-w-0 items-baseline justify-between gap-2 font-mono tabular-nums ui-micro"
      >
        <span style={{ color: levelColor }}>{readout}</span>
      </div>
      <div
        aria-hidden
        className="h-1.5 w-full overflow-hidden rounded-xs border border-border"
        style={{ background: "var(--color-surface-raised)" }}
      >
        <div className="flex h-full w-full">
          {visible.map((segment) => (
            <div
              key={segment.kind}
              data-tip={t("agentUi.context.segmentTip", {
                label: segment.label,
                tokens: compactTokens(segment.tokens),
                percent: percentText(bounded ? segment.tokens / denominator : 0),
              })}
              className="h-full min-w-[1px]"
              style={{
                width: `${bounded ? (segment.tokens / denominator) * 100 : 0}%`,
                background: SEGMENT_COLOR[segment.kind],
              }}
            />
          ))}
        </div>
      </div>
      {visible.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 ui-micro text-text-faint">
          {visible.map((segment) => (
            <span key={segment.kind} className="inline-flex items-center gap-1">
              <i
                aria-hidden
                className="inline-block size-2 shrink-0 rounded-xs"
                style={{ background: SEGMENT_COLOR[segment.kind] }}
              />
              {segment.label} {compactTokens(segment.tokens)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
