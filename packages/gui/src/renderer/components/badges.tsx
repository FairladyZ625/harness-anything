import type {
  SnapshotStatus,
  CloseoutReadiness,
  EngineId,
  Freshness,
  DecisionState,
  RiskTier,
  Urgency,
} from "../model/types";
import {
  Circle,
  CircleHalf,
  CircleNotch,
  PauseCircle,
  CheckCircle,
  XCircle,
  Question,
  Lock,
  ClockCounterClockwise,
  WarningCircle,
  MinusCircle,
  HourglassMedium,
  Seal,
  SealCheck,
  SealWarning,
  Scales,
  Lightning,
  ChatCircleDots,
  Archive,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";

export const STATUS_META: Record<
  SnapshotStatus,
  { label: string; color: string; icon: ReactNode }
> = {
  planned: {
    label: "Planned",
    color: "var(--color-status-planned)",
    icon: <Circle weight="duotone" />,
  },
  active: {
    label: "Active",
    color: "var(--color-status-active)",
    icon: <CircleNotch weight="bold" />,
  },
  blocked: {
    label: "Blocked",
    color: "var(--color-status-blocked)",
    icon: <PauseCircle weight="duotone" />,
  },
  in_review: {
    label: "In Review",
    color: "var(--color-status-in-review)",
    icon: <CircleHalf weight="duotone" />,
  },
  done: {
    label: "Done",
    color: "var(--color-status-done)",
    icon: <CheckCircle weight="duotone" />,
  },
  cancelled: {
    label: "Cancelled",
    color: "var(--color-status-cancelled)",
    icon: <XCircle weight="duotone" />,
  },
  unknown: {
    label: "Unknown",
    color: "var(--color-status-unknown)",
    icon: <Question weight="bold" />,
  },
};

export function StatusBadge({ status }: { status: SnapshotStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[13px] font-medium"
      style={{
        color: meta.color,
        background: `color-mix(in oklch, ${meta.color} 12%, transparent)`,
      }}
    >
      <span className="text-[14px]">{meta.icon}</span>
      {meta.label}
    </span>
  );
}

const CLOSEOUT_META: Record<
  CloseoutReadiness,
  { label: string; icon: ReactNode; accent?: boolean; tone?: "danger" }
> = {
  not_required: { label: "无需收口", icon: <MinusCircle weight="duotone" /> },
  missing: { label: "材料缺失", icon: <Seal weight="duotone" /> },
  incomplete: { label: "收口未齐", icon: <HourglassMedium weight="duotone" /> },
  ready: { label: "待审阅", icon: <SealCheck weight="fill" />, accent: true },
  passed: { label: "已通过", icon: <SealCheck weight="duotone" /> },
  failed: { label: "未通过", icon: <SealWarning weight="duotone" />, tone: "danger" },
};

export function CloseoutBadge({ value }: { value: CloseoutReadiness }) {
  const meta = CLOSEOUT_META[value];
  if (meta.accent) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-[13px] font-semibold text-accent-fg">
        <span className="text-[14px]">{meta.icon}</span>
        {meta.label}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-surface-raised px-2 py-0.5 text-[13px] font-medium"
      style={{ color: meta.tone === "danger" ? "var(--color-danger)" : "var(--color-text-muted)" }}
    >
      <span className="text-[14px]">{meta.icon}</span>
      {meta.label}
    </span>
  );
}

const ENGINE_LABEL: Record<EngineId, string> = {
  local: "local",
  multica: "multica",
  github: "github",
  linear: "linear",
};

export function EngineBadge({ engine, locked }: { engine: EngineId; locked: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-px font-mono text-[12px] text-text-muted">
      {locked && <Lock weight="bold" className="text-[12px]" />}
      {ENGINE_LABEL[engine]}
    </span>
  );
}

const timeOf = (iso: string) =>
  iso.slice(11, 16);

export function FreshnessTag({
  freshness,
  lastKnownAt,
}: {
  freshness: Freshness;
  lastKnownAt: string;
}) {
  if (freshness === "fresh") return null;
  if (freshness === "stale-but-usable") {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[12px] text-stale">
        <ClockCounterClockwise weight="bold" />
        最后已知 @ {timeOf(lastKnownAt)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] text-danger">
      <WarningCircle weight="bold" />
      不可知 · 无缓存
    </span>
  );
}

/** freshness 的卡片边框语言：fresh 无装饰；stale 琥珀细边；unavailable 虚线 */
export function freshnessBorder(freshness: Freshness): string {
  if (freshness === "stale-but-usable")
    return "border border-stale/40";
  if (freshness === "unavailable-no-cache")
    return "border border-dashed border-border-strong";
  return "border border-border";
}

// ============ 三元语 badges：decision / riskTier / urgency ============

const DECISION_STATE_META: Record<
  DecisionState,
  { icon: ReactNode; cls: string; label: string }
> = {
  proposed: { icon: <ChatCircleDots weight="bold" />, cls: "bg-accent text-accent-fg", label: "待裁决" },
  rejected: { icon: <XCircle weight="bold" />, cls: "bg-danger/20 text-danger", label: "已否决" },
  deferred: { icon: <PauseCircle weight="bold" />, cls: "bg-stale/20 text-stale", label: "暂缓" },
  active: { icon: <SealCheck weight="bold" />, cls: "bg-success/15 text-success", label: "生效中" },
  retired: { icon: <Archive weight="bold" />, cls: "bg-surface-raised text-text-faint", label: "已退役" },
};

export function DecisionStateBadge({ state }: { state: DecisionState }) {
  const meta = DECISION_STATE_META[state];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-semibold ${meta.cls}`}
    >
      <span className="text-[13px]">{meta.icon}</span>
      {meta.label}
    </span>
  );
}

const RISK_META: Record<RiskTier, { label: string; cls: string }> = {
  high: { label: "高风险", cls: "text-danger" },
  medium: { label: "中风险", cls: "text-stale" },
  low: { label: "低风险", cls: "text-text-muted" },
};

export function RiskTierBadge({ tier }: { tier: RiskTier }) {
  const m = RISK_META[tier];
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[12px] ${m.cls}`} title="风险/重要性 → 评审深度">
      <Scales weight="bold" className="text-[12px]" />
      {m.label}
    </span>
  );
}

const URGENCY_META: Record<Urgency, { label: string; cls: string }> = {
  high: { label: "紧急", cls: "text-danger" },
  medium: { label: "常规", cls: "text-text-muted" },
  low: { label: "不急", cls: "text-text-faint" },
};

export function UrgencyBadge({ urgency }: { urgency: Urgency }) {
  const m = URGENCY_META[urgency];
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[12px] ${m.cls}`} title="紧急 → 队列排队">
      <Lightning weight="bold" className="text-[12px]" />
      {m.label}
    </span>
  );
}

export function DecisionSourceBadge({
  decisionId,
  title,
  compact = false,
  onNavigate,
}: {
  decisionId: string;
  title?: string;
  compact?: boolean;
  /** W2B 活链接:传入则变可点 button,跳转到该 decision 视图 */
  onNavigate?: () => void;
}) {
  const className = `inline-flex max-w-full items-center gap-1 rounded border border-accent/30 bg-accent/10 font-mono font-semibold text-accent ${
    compact ? "px-1.5 py-px text-[10px]" : "px-2 py-0.5 text-[12px]"
  }${onNavigate ? " cursor-pointer hover:border-accent/60 hover:bg-accent/15" : ""}`;
  const tooltip = title ? `派生自 ${decisionId}: ${title}` : `派生自 ${decisionId}`;
  // 活链接:有 onNavigate 时渲染 button,否则保持原 span(向后兼容 BoardView/ListView 等)
  if (onNavigate) {
    return (
      <button
        type="button"
        onClick={onNavigate}
        title={`${tooltip} — 点击跳转`}
        className={className}
      >
        <Scales weight="bold" className={compact ? "text-[10px]" : "text-[12px]"} />
        派生自 {decisionId}
      </button>
    );
  }
  return (
    <span title={tooltip} className={className}>
      <Scales weight="bold" className={compact ? "text-[10px]" : "text-[12px]"} />
      派生自 {decisionId}
    </span>
  );
}
