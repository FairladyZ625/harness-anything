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
import { t } from "../i18n/index.tsx";

export const STATUS_META: Record<
  SnapshotStatus,
  { label: string; color: string; icon: ReactNode }
> = {
  planned: {
    get label() { return t("components.badges.planned"); },
    color: "var(--color-status-planned)",
    icon: <Circle weight="duotone" />,
  },
  active: {
    get label() { return t("components.badges.active"); },
    color: "var(--color-status-active)",
    icon: <CircleNotch weight="bold" />,
  },
  blocked: {
    get label() { return t("components.badges.blocked"); },
    color: "var(--color-status-blocked)",
    icon: <PauseCircle weight="duotone" />,
  },
  in_review: {
    get label() { return t("components.badges.finalizing"); },
    color: "var(--color-status-in-review)",
    icon: <CircleHalf weight="duotone" />,
  },
  done: {
    get label() { return t("components.badges.done"); },
    color: "var(--color-status-done)",
    icon: <CheckCircle weight="duotone" />,
  },
  cancelled: {
    get label() { return t("components.badges.cancelled"); },
    color: "var(--color-status-cancelled)",
    icon: <XCircle weight="duotone" />,
  },
  unknown: {
    get label() { return t("components.badges.unknown"); },
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
  not_required: { get label() { return t("components.badges.noNeedCloseUp"); }, icon: <MinusCircle weight="duotone" /> },
  missing: { get label() { return t("components.badges.materialMissing"); }, icon: <Seal weight="duotone" /> },
  incomplete: { get label() { return t("components.badges.notFinished"); }, icon: <HourglassMedium weight="duotone" /> },
  ready: { get label() { return t("components.badges.readyArchiving"); }, icon: <SealCheck weight="fill" />, accent: true },
  passed: { get label() { return t("components.badges.passed"); }, icon: <SealCheck weight="duotone" /> },
  failed: { get label() { return t("components.badges.failed"); }, icon: <SealWarning weight="duotone" />, tone: "danger" },
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
        {t("components.badges.lastKnown")}{timeOf(lastKnownAt)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] text-danger">
      <WarningCircle weight="bold" />
      {t("components.badges.agnosticNoCaching")}</span>
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
  proposed: { icon: <ChatCircleDots weight="bold" />, cls: "bg-accent text-accent-fg", get label() { return t("components.badges.pendingDecisionApproval"); } },
  rejected: { icon: <XCircle weight="bold" />, cls: "bg-danger/20 text-danger", get label() { return t("components.badges.rejected"); } },
  deferred: { icon: <PauseCircle weight="bold" />, cls: "bg-stale/20 text-stale", get label() { return t("components.badges.suspended"); } },
  active: { icon: <SealCheck weight="bold" />, cls: "bg-success/15 text-success", get label() { return t("components.badges.takingEffect"); } },
  retired: { icon: <Archive weight="bold" />, cls: "bg-surface-raised text-text-faint", get label() { return t("components.badges.retired"); } },
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
  high: { get label() { return t("components.badges.highRisk"); }, cls: "text-danger" },
  medium: { get label() { return t("components.badges.mediumRisk"); }, cls: "text-stale" },
  low: { get label() { return t("components.badges.lowRisk"); }, cls: "text-text-muted" },
};

export function RiskTierBadge({ tier }: { tier?: RiskTier }) {
  const m = tier ? RISK_META[tier] : { label: t("components.badges.unknown"), cls: "text-text-faint" };
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[12px] ${m.cls}`} title={t("components.badges.riskSignificanceDepthReview")}>
      <Scales weight="bold" className="text-[12px]" />
      {m.label}
    </span>
  );
}

const URGENCY_META: Record<Urgency, { label: string; cls: string }> = {
  high: { get label() { return t("components.badges.urgent"); }, cls: "text-danger" },
  medium: { get label() { return t("components.badges.regular"); }, cls: "text-text-muted" },
  low: { get label() { return t("components.badges.noRush"); }, cls: "text-text-faint" },
};

export function UrgencyBadge({ urgency }: { urgency?: Urgency }) {
  const m = urgency ? URGENCY_META[urgency] : { label: t("components.badges.unknown"), cls: "text-text-faint" };
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[12px] ${m.cls}`} title={t("components.badges.urgentQueueQueue")}>
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
  const tooltip = title ? t("components.badges.derivedFromDecisionIdTitle", { decisionId: decisionId, title: title }) : t("components.badges.derivedFromDecisionId", { decisionId: decisionId });
  // 活链接:有 onNavigate 时渲染 button,否则保持原 span(向后兼容 BoardView/ListView 等)
  if (onNavigate) {
    return (
      <button
        type="button"
        onClick={onNavigate}
        title={t("components.badges.tooltipClickJump", { tooltip: tooltip })}
        className={className}
      >
        <Scales weight="bold" className={compact ? "text-[10px]" : "text-[12px]"} />
        {t("components.badges.derivedFrom")}{decisionId}
      </button>
    );
  }
  return (
    <span title={tooltip} className={className}>
      <Scales weight="bold" className={compact ? "text-[10px]" : "text-[12px]"} />
      {t("components.badges.derivedFrom2")}{decisionId}
    </span>
  );
}
