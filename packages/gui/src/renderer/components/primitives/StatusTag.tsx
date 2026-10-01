import type { ReactNode } from "react";
import type { SnapshotStatus } from "../../model/types";
import { STATUS_META } from "../badges";

/**
 * 视觉基线 v1 的状态呈现档(gui-visual-language-standard §3):
 * 完成=绿、在做=青蓝、等人裁决/评审中=琥珀、待开工=灰蓝、取消=暗灰、阻塞/失败=红。
 * 「默认就该如此」的正常值(可用、已附着、运行中等)用 neutral,不上状态色。
 * 颜色通道承载注意力类别,具体状态靠文字区分;同一状态在所有页面同一颜色。
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

type StatusTagProps =
  | { readonly status: SnapshotStatus; readonly tone?: never; readonly label?: never }
  | { readonly tone: StatusTone; readonly label: ReactNode; readonly status?: never };

/** 状态标签:有底色的小块,底色为状态色 token 的低透明度混合(标准 §3/§4)。 */
export function StatusTag(props: StatusTagProps) {
  const tone = props.status !== undefined ? STATUS_TONE[props.status] : props.tone;
  const color = TONE_COLOR[tone];
  const label = props.status !== undefined ? STATUS_META[props.status].label : props.label;
  return (
    <span
      data-status-tone={tone}
      className="inline-flex items-center whitespace-nowrap rounded-xs px-1.5 py-px font-semibold ui-meta"
      style={{ color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}
    >
      {label}
    </span>
  );
}
