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
  ArrowArcRight,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { t, type MessageKey } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";

function localizedLabel(key: MessageKey): { readonly label: string } {
  return {
    get label() {
      return t(key);
    },
  };
}

export const STATUS_META: Record<SnapshotStatus, { label: string; color: string; icon: ReactNode }> = {
  planned: {
    ...localizedLabel("components.badges.planned"),
    color: "var(--color-status-planned)",
    icon: <Circle weight="duotone" />,
  },
  active: {
    ...localizedLabel("components.badges.active"),
    color: "var(--color-status-active)",
    icon: <CircleNotch weight="bold" />,
  },
  blocked: {
    ...localizedLabel("components.badges.blocked"),
    color: "var(--color-status-blocked)",
    icon: <PauseCircle weight="duotone" />,
  },
  in_review: {
    ...localizedLabel("components.badges.finalizing"),
    color: "var(--color-status-in-review)",
    icon: <CircleHalf weight="duotone" />,
  },
  done: {
    ...localizedLabel("components.badges.done"),
    color: "var(--color-status-done)",
    icon: <CheckCircle weight="duotone" />,
  },
  cancelled: {
    ...localizedLabel("components.badges.cancelled"),
    color: "var(--color-status-cancelled)",
    icon: <XCircle weight="duotone" />,
  },
  unknown: {
    ...localizedLabel("components.badges.unknown"),
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

const CLOSEOUT_META: Record<CloseoutReadiness, { label: string; icon: ReactNode; accent?: boolean; tone?: "danger" }> =
  {
    not_required: { ...localizedLabel("components.badges.noNeedCloseUp"), icon: <MinusCircle weight="duotone" /> },
    missing: { ...localizedLabel("components.badges.materialMissing"), icon: <Seal weight="duotone" /> },
    incomplete: { ...localizedLabel("components.badges.notFinished"), icon: <HourglassMedium weight="duotone" /> },
    ready: { ...localizedLabel("components.badges.readyArchiving"), icon: <SealCheck weight="fill" />, accent: true },
    passed: { ...localizedLabel("components.badges.passed"), icon: <SealCheck weight="duotone" /> },
    failed: { ...localizedLabel("components.badges.failed"), icon: <SealWarning weight="duotone" />, tone: "danger" },
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

const ENGINE_LABEL: Record<string, string> = {
  local: "local",
  multica: "multica",
  github: "github",
  linear: "linear",
};

export function EngineBadge({ engine, locked }: { engine: EngineId; locked: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-px font-mono text-[12px] text-text-muted">
      {locked && <Lock weight="bold" className="text-[12px]" />}
      {ENGINE_LABEL[engine] ?? engine}
    </span>
  );
}

const timeOf = (iso: string) => formatTime(iso, { style: "time" }) ?? "—";

export function FreshnessTag({ freshness, lastKnownAt }: { freshness: Freshness; lastKnownAt: string }) {
  if (freshness === "fresh") return null;
  if (freshness === "stale-but-usable") {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[12px] text-stale">
        <ClockCounterClockwise weight="bold" />
        {t("components.badges.lastKnown")} {timeOf(lastKnownAt)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] text-danger">
      <WarningCircle weight="bold" />
      {t("components.badges.agnosticNoCaching")}
    </span>
  );
}

/** freshness 的卡片边框语言：fresh 无装饰；stale 琥珀细边；unavailable 虚线 */
export function freshnessBorder(freshness: Freshness): string {
  if (freshness === "stale-but-usable") return "border border-stale/40";
  if (freshness === "unavailable-no-cache") return "border border-dashed border-border-strong";
  return "border border-border";
}

// ============ 三元语 badges：decision / riskTier / urgency ============

const DECISION_STATE_META: Record<DecisionState, { icon: ReactNode; cls: string; label: string }> = {
  proposed: {
    ...localizedLabel("components.badges.pendingDecisionApproval"),
    icon: <ChatCircleDots weight="bold" />,
    cls: "bg-accent text-accent-fg",
  },
  rejected: {
    ...localizedLabel("components.badges.rejected"),
    icon: <XCircle weight="bold" />,
    cls: "bg-danger/20 text-danger",
  },
  deferred: {
    ...localizedLabel("components.badges.suspended"),
    icon: <PauseCircle weight="bold" />,
    cls: "bg-stale/20 text-stale",
  },
  superseded: {
    ...localizedLabel("components.badges.superseded"),
    icon: <ArrowArcRight weight="bold" />,
    cls: "bg-stale/20 text-stale",
  },
  in_effect: {
    ...localizedLabel("components.badges.takingEffect"),
    icon: <SealCheck weight="bold" />,
    cls: "bg-success/15 text-success",
  },
  outcome_retired: {
    ...localizedLabel("components.badges.retired"),
    icon: <Archive weight="bold" />,
    cls: "bg-surface-raised text-text-faint",
  },
  unknown: {
    ...localizedLabel("components.badges.unknown"),
    icon: <Question weight="bold" />,
    cls: "bg-surface-raised text-text-faint",
  },
};

export function DecisionStateBadge({ state }: { state: DecisionState }) {
  const meta = DECISION_STATE_META[state];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-semibold ${meta.cls}`}>
      <span className="text-[13px]">{meta.icon}</span>
      {meta.label}
    </span>
  );
}

/** 决策状态词的显示名(决策流状态切换钮与徽章共用同一标签源)。 */
export function decisionStateLabel(state: DecisionState): string {
  return DECISION_STATE_META[state].label;
}

const RISK_META: Record<RiskTier, { label: string; cls: string }> = {
  high: { ...localizedLabel("components.badges.highRisk"), cls: "text-danger" },
  medium: { ...localizedLabel("components.badges.mediumRisk"), cls: "text-stale" },
  low: { ...localizedLabel("components.badges.lowRisk"), cls: "text-text-muted" },
};

export function RiskTierBadge({ tier }: { tier?: RiskTier }) {
  const m = tier ? RISK_META[tier] : { ...localizedLabel("components.badges.unknown"), cls: "text-text-faint" };
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[12px] ${m.cls}`}
      title={t("components.badges.riskSignificanceDepthReview")}
    >
      <Scales weight="bold" className="text-[12px]" />
      {m.label}
    </span>
  );
}

const URGENCY_META: Record<Urgency, { label: string; cls: string }> = {
  high: { ...localizedLabel("components.badges.urgent"), cls: "text-danger" },
  medium: { ...localizedLabel("components.badges.regular"), cls: "text-text-muted" },
  low: { ...localizedLabel("components.badges.noRush"), cls: "text-text-faint" },
};

export function UrgencyBadge({ urgency }: { urgency?: Urgency }) {
  const m = urgency
    ? URGENCY_META[urgency]
    : { ...localizedLabel("components.badges.unknown"), cls: "text-text-faint" };
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[12px] ${m.cls}`}
      title={t("components.badges.urgentQueueQueue")}
    >
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
    compact ? "px-1.5 py-px text-[11px]" : "px-2 py-0.5 text-[12px]"
  }${onNavigate ? " cursor-pointer hover:border-accent/60 hover:bg-accent/15" : ""}`;
  const tooltip = title
    ? t("components.badges.derivedFromDecisionIdTitle", { decisionId, title })
    : t("components.badges.derivedFromDecisionId", { decisionId });
  // 活链接:有 onNavigate 时渲染 button,否则保持原 span(向后兼容 BoardView/ListView 等)
  if (onNavigate) {
    return (
      <button
        type="button"
        onClick={onNavigate}
        title={t("components.badges.tooltipClickJump", { tooltip })}
        className={className}
      >
        <Scales weight="bold" className={compact ? "text-[11px]" : "text-[12px]"} />
        {t("components.badges.derivedFrom2")} {decisionId}
      </button>
    );
  }
  return (
    <span title={tooltip} className={className}>
      <Scales weight="bold" className={compact ? "text-[11px]" : "text-[12px]"} />
      {t("components.badges.derivedFrom")} {decisionId}
    </span>
  );
}
