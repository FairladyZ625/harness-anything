import { useEffect, useMemo, useState } from "react";
import { Scales } from "@phosphor-icons/react";
import type { DecisionRow, DecisionState } from "../../model/types";
import type { WorkspaceSummaryRead } from "../../../api/renderer-dto.ts";
import { sortDecisionQueue } from "../../model/triadic";
import { RiskTierBadge, UrgencyBadge } from "../badges.tsx";
import { t } from "../../i18n/index.tsx";
import { StreamBody, StreamEmpty, StreamExitButton, StreamTabs, streamTime } from "./streamParts.tsx";

/** 决策流的状态切换词表:kernel decisionStates 六词全列,不隐藏任何状态。 */
export const DECISION_STREAM_STATES = [
  "proposed",
  "in_effect",
  "deferred",
  "rejected",
  "superseded",
  "outcome_retired",
] as const satisfies readonly DecisionState[];
type DecisionStreamState = (typeof DECISION_STREAM_STATES)[number];

/**
 * 主行集一次渲染这么多行,剩下的靠批量按钮显形——照抄本仓 BoardView 与 TaskStream 的做法。
 *
 * 这一段的规模不是常数:它是选中状态的全部决策,本仓实测最大一档 in_effect 598 行。
 * 分批渲染把 DOM 节点数与决策总量脱钩;状态页签计数照抄 daemon census 报出真实总数,
 * 按钮报出剩余条数,所以被推迟渲染的行是显形的、不是被吞掉的。
 */
const ROW_BATCH_SIZE = 12;

/**
 * 总览「决策流」:等裁决的决策以行式紧凑列表给出,按状态就地切换。
 * 排序 = sortDecisionQueue(风险 → 紧急度 → 提案时间倒序,见 model/triadic.ts)。
 * 行点击只开抽屉(onOpenPreview),路由不动。
 */
export function DecisionStream({
  decisions,
  summary,
  stateLabel,
  onOpenPreview,
  onOpenInbox,
}: {
  decisions: ReadonlyArray<DecisionRow>;
  summary: WorkspaceSummaryRead["decisions"];
  stateLabel: (state: DecisionState) => string;
  onOpenPreview: (decisionId: string) => void;
  onOpenInbox: () => void;
}) {
  const [state, setState] = useState<DecisionStreamState>("proposed");
  const rows = useMemo(
    () => sortDecisionQueue(decisions.filter((decision) => decision.state === state)),
    [decisions, state],
  );
  const [rowsVisible, setRowsVisible] = useState(ROW_BATCH_SIZE);
  // 切换状态会换掉主行集的全部组员,展开状态不能跟着过去。
  useEffect(() => {
    setRowsVisible(ROW_BATCH_SIZE);
  }, [state]);
  const rowsShown = useMemo(() => rows.slice(0, rowsVisible), [rows, rowsVisible]);
  const rowsHidden = rows.length - rowsShown.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <StreamTabs
          options={DECISION_STREAM_STATES.map((key) => ({ key, label: stateLabel(key), count: summary.byState[key] }))}
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
          {rowsShown.map((decision) => (
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
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-faint">
                {streamTime(decision.proposedAt)}
              </span>
            </button>
          ))}
          {rowsHidden > 0 && (
            <button
              type="button"
              data-testid="decision-stream-more"
              onClick={() => setRowsVisible((count) => Math.min(count + ROW_BATCH_SIZE, rows.length))}
              className="w-full px-1 py-1 text-center font-mono text-[11px] text-text-muted hover:text-text"
            >
              {t("views.overviewView.decisionShowMore", {
                count: Math.min(ROW_BATCH_SIZE, rowsHidden),
                remaining: rowsHidden,
              })}
            </button>
          )}
        </StreamBody>
      )}
    </div>
  );
}
