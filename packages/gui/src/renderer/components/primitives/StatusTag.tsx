import type { ReactNode } from "react";
import type { SnapshotStatus } from "../../model/types";
import { STATUS_META } from "../badges";

/**
 * 视觉基线 v1 的状态呈现档(gui-visual-language-standard §3):
 * 完成=绿、在做=青蓝、等人裁决/评审中=琥珀、待开工=灰蓝、取消=暗灰、阻塞/失败=红。
 * 「默认就该如此」的正常值(可用、已附着、运行中等)用 neutral,不上状态色。
 * 颜色通道承载注意力类别,具体状态靠文字区分;同一状态在所有页面同一颜色。
 *
 * 唯一的标签形状(C8 收敛):状态词、运行域状态徽章、决策/收口/引擎/新鲜度徽章都由
 * 本组件渲染。多档能力在同一组件内,不派生新组件:
 * - `icon` 前置图标、`count` 尾部计数、`mono` 等宽小档(机器词/ID);
 * - `status` 给状态词(默认标签取 STATUS_META),`tone`+`label` 给状态词表之外的自定义标签。
 */
export type StatusTone = "done" | "active" | "wait" | "plan" | "cancel" | "bad" | "neutral";

/** tone → token:原语内部唯一的状态色来源,调用点不写状态色数值。 */
export const TONE_COLOR: Record<StatusTone, string> = {
  done: "var(--color-status-done)",
  active: "var(--color-status-active)",
  wait: "var(--color-status-submitted)",
  plan: "var(--color-status-planned)",
  cancel: "var(--color-status-cancelled)",
  bad: "var(--color-status-blocked)",
  neutral: "var(--color-text-muted)",
};

/** 状态词 → tone:分段条、区域竖线等所有按状态着色的原语共用这一份映射。 */
export const STATUS_TONE: Record<SnapshotStatus, StatusTone> = {
  planned: "plan",
  active: "active",
  submitted: "wait",
  in_review: "wait",
  blocked: "bad",
  done: "done",
  cancelled: "cancel",
  unknown: "neutral",
  archived: "neutral",
};

export function statusToneOf(status: SnapshotStatus): StatusTone {
  return STATUS_TONE[status];
}

export function StatusTag({
  status,
  tone,
  label,
  icon,
  count,
  mono = false,
  tip,
  testId,
}: {
  /** 状态词(标签默认取 STATUS_META,可被 label 覆盖)。 */
  readonly status?: SnapshotStatus;
  /** 显式 tone:状态词表之外的标签必给;与 status 同给时以 tone 为准。 */
  readonly tone?: StatusTone;
  /** 自定义标签(状态词表之外,或对状态词换措辞)。 */
  readonly label?: ReactNode;
  /** 前置图标:随标签同色。 */
  readonly icon?: ReactNode;
  /** 尾部计数(等宽表格数字)。 */
  readonly count?: number | string;
  /** 等宽小档:机器词/ID 类标签。 */
  readonly mono?: boolean;
  readonly tip?: string;
  readonly testId?: string;
}) {
  const resolvedTone = tone ?? (status !== undefined ? STATUS_TONE[status] : "neutral");
  const color = TONE_COLOR[resolvedTone];
  const text = label ?? (status !== undefined ? STATUS_META[status].label : null);
  return (
    <span
      data-status-tone={resolvedTone}
      data-tip={tip}
      data-testid={testId}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-xs px-1.5 py-px font-semibold ui-meta ${mono ? "font-mono" : ""}`}
      style={{ color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}
    >
      {icon}
      {text}
      {count !== undefined && <b className="font-mono font-semibold tabular-nums">{count}</b>}
    </span>
  );
}
