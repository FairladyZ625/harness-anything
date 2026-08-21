import { useMemo, useState } from "react";
import { Scales } from "@phosphor-icons/react";
import type { DecisionRow, DecisionState } from "../../model/types";
import { sortDecisionQueue } from "../../model/triadic";
import { RiskTierBadge, UrgencyBadge } from "../badges.tsx";
import { t } from "../../i18n/index.tsx";
import { StreamBody, StreamEmpty, StreamExitButton, StreamTabs, streamTime } from "./streamParts.tsx";

/** 决策流的状态切换词表:kernel decisionStates 六词全列,不隐藏任何状态。 */
export const DECISION_STREAM_STATES: readonly DecisionState[] = [
  "proposed",
  "in_effect",
  "deferred",
  "rejected",
  "superseded",
  "outcome_retired",
];

/**
 * 总览「决策流」:等裁决的决策以行式紧凑列表给出,按状态就地切换。
 * 排序 = sortDecisionQueue(风险 → 紧急度 → 提案时间倒序,见 model/triadic.ts)。
 * 行点击只开抽屉(onOpenPreview),路由不动。
 */
export function DecisionStream({
  decisions,
  stateLabel,
  onOpenPreview,
  onOpenInbox,
}: {
  decisions: ReadonlyArray<DecisionRow>;
  stateLabel: (state: DecisionState) => string;
  onOpenPreview: (decisionId: string) => void;
  onOpenInbox: () => void;
}) {
  const [state, setState] = useState<DecisionState>("proposed");
  const counts = useMemo(() => {
    const map = new Map<DecisionState, number>();
    for (const decision of decisions) map.set(decision.state, (map.get(decision.state) ?? 0) + 1);
    return map;
  }, [decisions]);
  const rows = useMemo(
    () => sortDecisionQueue(decisions.filter((decision) => decision.state === state)),
    [decisions, state],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <StreamTabs
          options={DECISION_STREAM_STATES.map((key) => ({ key, label: stateLabel(key), count: counts.get(key) ?? 0 }))}
          value={state}
          onChange={setState}
          testIdOf={(key) => `overview-decision-state-${key}`}
        />
        <StreamExitButton
          label={t("views.overviewView.goInbox")}
          title={t("views.overviewView.goInboxTitle")}
          onClick={onOpenInbox}
        />
      </div>
      {rows.length === 0 ? (
        <StreamEmpty>{t("views.overviewView.decisionEmpty")}</StreamEmpty>
      ) : (
        <StreamBody testId="decision-stream-rows">
          {rows.map((decision) => (
            <button
              key={decision.decisionId}
              type="button"
              onClick={() => onOpenPreview(decision.decisionId)}
              title={`${decision.decisionId} · ${decision.title}`}
              className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left transition-colors duration-100 [contain-intrinsic-size:auto_1.75rem] [content-visibility:auto] hover:border-accent/60"
            >
              <Scales weight="bold" className="shrink-0 text-accent" />
              <RiskTierBadge tier={decision.riskTier} />
              <UrgencyBadge urgency={decision.urgency} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{decision.title}</span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-faint">{streamTime(decision.proposedAt)}</span>
            </button>
          ))}
        </StreamBody>
      )}
    </div>
  );
}
