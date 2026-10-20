import { compactTokens, percentText } from "../../token-format.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 上下文窗口填充水位条(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 / Affect UI ContextWindow):
 * 已用/上限 Token + 分段占用比例 + 高水位预警色。分段色取统计图定序分类 token
 * (--color-viz-*),不与状态色共用;数字走 token-format.ts 的统一格式。
 *
 * 纯展示组件,无计时器:读数完全由 props 决定,实时刷新由调用方的响应式数据流驱动
 * (W1-T1)。role=meter + 键盘可达,分段明细以可见图例行同时作为无障碍读数。
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
  /** 上下文窗口上限(Token)。 */
  readonly limitTokens: number;
  readonly highWaterRatio?: number;
  readonly dangerRatio?: number;
  readonly testId?: string;
}) {
  const used = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const ratio = limitTokens > 0 ? used / limitTokens : 0;
  const level = ratio >= dangerRatio ? "danger" : ratio >= highWaterRatio ? "warn" : "ok";
  const levelColor =
    level === "danger"
      ? "var(--color-danger)"
      : level === "warn"
        ? "var(--color-status-submitted)"
        : "var(--color-text-muted)";
  const visible = segments.filter((segment) => segment.tokens > 0);

  return (
    <div data-testid={testId} data-context-level={level} className="flex min-w-0 flex-col gap-1">
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limitTokens}
        aria-valuenow={used}
        aria-valuetext={
          t("agentUi.context.usedOf", {
            used: compactTokens(used),
            limit: compactTokens(limitTokens),
            percent: percentText(ratio),
          }) +
          (level === "danger" ? t("agentUi.context.nearLimit") : level === "warn" ? t("agentUi.context.highWater") : "")
        }
        aria-label={t("agentUi.context.ariaLabel")}
        tabIndex={0}
        className="flex min-w-0 items-baseline justify-between gap-2 font-mono tabular-nums ui-micro"
      >
        <span style={{ color: levelColor }}>
          {compactTokens(used)} / {compactTokens(limitTokens)} · {percentText(ratio)}
        </span>
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
                percent: percentText(limitTokens > 0 ? segment.tokens / limitTokens : 0),
              })}
              className="h-full min-w-[1px]"
              style={{
                width: `${limitTokens > 0 ? (segment.tokens / limitTokens) * 100 : 0}%`,
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
