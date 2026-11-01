import type { CloseoutReadiness, Freshness, DecisionState, RiskTier, Urgency } from "../model/types";
import {
  CircleNotch,
  PauseCircle,
  XCircle,
  Question,
  ClockCounterClockwise,
  WarningCircle,
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
import { t } from "../i18n/index.tsx";
import { localizedLabel } from "./primitives/status-meta.tsx";
import { formatTime } from "../model/time.ts";
import { StatusTag, type StatusTone } from "./primitives/StatusTag.tsx";

export { STATUS_META } from "./primitives/status-meta.tsx";

// 徽章的渲染形状已收敛到 primitives/StatusTag(C8,视觉基线 v2):本文件只保留
// 状态→{label,icon,tone} 的词表职责;STATUS_META 仍供图例、画布与筛选面板取色。

const CLOSEOUT_META: Record<
  Exclude<CloseoutReadiness, "not_required">,
  { label: string; icon: ReactNode; tone: StatusTone }
> = {
  missing: localizedLabel("components.badges.materialMissing", { icon: <Seal weight="duotone" />, tone: "bad" }),
  incomplete: localizedLabel("components.badges.notFinished", {
    icon: <HourglassMedium weight="duotone" />,
    tone: "wait",
  }),
  ready: localizedLabel("components.badges.readyArchiving", { icon: <SealCheck weight="fill" />, tone: "done" }),
  passed: localizedLabel("components.badges.passed", { icon: <SealCheck weight="duotone" />, tone: "done" }),
  failed: localizedLabel("components.badges.failed", { icon: <SealWarning weight="duotone" />, tone: "bad" }),
};

export function CloseoutBadge({ value }: { value: CloseoutReadiness }) {
  if (value === "not_required") return null;
  const meta = CLOSEOUT_META[value];
  return <StatusTag tone={meta.tone} icon={meta.icon} label={meta.label} />;
}

/** Agent attention is independent of the task lifecycle: asking must differ from working. */
export function AgentStateBadge({ state }: { readonly state: "question" | "awaits" | "working" }) {
  const working = state === "working";
  return (
    <StatusTag
      tone={working ? "agent-working" : "agent-question"}
      icon={working ? <CircleNotch weight="bold" /> : <ChatCircleDots weight="bold" />}
      label={t(working ? "views.settingsView.systemRunning" : "components.awaitsAnswer.title")}
    />
  );
}

const timeOf = (iso: string) => formatTime(iso, { style: "time" }) ?? "—";

export function FreshnessTag({ freshness, lastKnownAt }: { freshness: Freshness; lastKnownAt: string }) {
  if (freshness === "fresh") return null;
  if (freshness === "stale-but-usable") {
    return (
      <StatusTag
        tone="wait"
        icon={<ClockCounterClockwise weight="bold" />}
        label={`${t("components.badges.lastKnown")} ${timeOf(lastKnownAt)}`}
      />
    );
  }
  return (
    <StatusTag tone="bad" icon={<WarningCircle weight="bold" />} label={t("components.badges.agnosticNoCaching")} />
  );
}

/** freshness 的卡片边框语言：fresh 无装饰；stale 琥珀细边；unavailable 虚线 */
export function freshnessBorder(freshness: Freshness): string {
  if (freshness === "stale-but-usable") return "border border-stale/40";
  if (freshness === "unavailable-no-cache") return "border border-dashed border-border-strong";
  return "border border-border";
}

// ============ 三元语 badges：decision / riskTier / urgency ============

const DECISION_STATE_META: Record<DecisionState, { icon: ReactNode; tone: StatusTone; label: string }> = {
  proposed: localizedLabel("components.badges.pendingDecisionApproval", {
    icon: <ChatCircleDots weight="bold" />,
    tone: "wait",
  }),
  rejected: localizedLabel("components.badges.rejected", {
    icon: <XCircle weight="bold" />,
    tone: "bad",
  }),
  deferred: localizedLabel("components.badges.suspended", {
    icon: <PauseCircle weight="bold" />,
    tone: "wait",
  }),
  superseded: localizedLabel("components.badges.superseded", {
    icon: <ArrowArcRight weight="bold" />,
    tone: "cancel",
  }),
  in_effect: localizedLabel("components.badges.takingEffect", {
    icon: <SealCheck weight="bold" />,
    tone: "done",
  }),
  outcome_retired: localizedLabel("components.badges.retired", {
    icon: <Archive weight="bold" />,
    tone: "cancel",
  }),
  unknown: localizedLabel("components.badges.unknown", {
    icon: <Question weight="bold" />,
    tone: "neutral",
  }),
};

export function DecisionStateBadge({ state }: { state: DecisionState }) {
  const meta = DECISION_STATE_META[state];
  return <StatusTag tone={meta.tone} icon={meta.icon} label={meta.label} />;
}

/** 决策状态词的显示名(决策流状态切换钮与徽章共用同一标签源)。 */
export function decisionStateLabel(state: DecisionState): string {
  return DECISION_STATE_META[state].label;
}

/** daemon 给的字符串是否落在决策态词表内;词表外的词由调用方按原文显示。 */
export function isDecisionState(value: string): value is DecisionState {
  return Object.hasOwn(DECISION_STATE_META, value);
}

/**
 * 风险等级 → 语义色:低风险中性、中风险等待、高风险最高风险;受保护面按最高风险呈现。
 * 这是风险色的唯一映射,ApprovalCard 等消费方只引用 riskTone,不再自写一份。
 */
const RISK_TONE: Record<RiskTier | "protected", StatusTone> = {
  high: "bad",
  medium: "wait",
  low: "neutral",
  protected: "bad",
};

export function riskTone(tier: RiskTier | "protected"): StatusTone {
  return RISK_TONE[tier];
}

const RISK_META: Record<RiskTier, { label: string; tone: StatusTone }> = {
  high: localizedLabel("components.badges.highRisk", { tone: riskTone("high") }),
  medium: localizedLabel("components.badges.mediumRisk", { tone: riskTone("medium") }),
  low: localizedLabel("components.badges.lowRisk", { tone: riskTone("low") }),
};

export function RiskTierBadge({ tier }: { tier?: RiskTier }) {
  const m = tier ? RISK_META[tier] : { label: t("components.badges.unknown"), tone: "neutral" as StatusTone };
  return (
    <StatusTag
      tone={m.tone}
      mono
      icon={<Scales weight="bold" />}
      label={m.label}
      tip={t("components.badges.riskSignificanceDepthReview")}
    />
  );
}

const URGENCY_META: Record<Urgency, { label: string; tone: StatusTone }> = {
  high: localizedLabel("components.badges.urgent", { tone: "bad" }),
  medium: localizedLabel("components.badges.regular", { tone: "neutral" }),
  low: localizedLabel("components.badges.noRush", { tone: "plan" }),
};

export function UrgencyBadge({ urgency }: { urgency?: Urgency }) {
  const m = urgency ? URGENCY_META[urgency] : { label: t("components.badges.unknown"), tone: "neutral" as StatusTone };
  return (
    <StatusTag
      tone={m.tone}
      mono
      icon={<Lightning weight="bold" />}
      label={m.label}
      tip={t("components.badges.urgentQueueQueue")}
    />
  );
}
