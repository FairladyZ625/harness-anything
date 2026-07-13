import { GitBranch, MagnifyingGlass } from "@phosphor-icons/react";
import type { DecisionRow } from "../../model/types";
import { shortTime } from "./layout";
import { t } from "../../i18n/index.tsx";

/**
 * 左栏：参与谱系的决策列表（搜索框 + 焦点候选）。点选一项即把主区焦点切到它的演化史。
 */
export function ParticipantsSidebar({
  participants,
  focusId,
  lineageSize,
  query,
  onQueryChange,
  onFocus,
}: {
  participants: DecisionRow[];
  focusId: string | null;
  lineageSize: Map<string, number>;
  query: string;
  onQueryChange: (value: string) => void;
  onFocus: (decisionId: string) => void;
}) {
  return (
    <div className="flex w-[260px] shrink-0 flex-col border-r border-border bg-surface/60">
      <div className="border-b border-border px-2.5 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1">
          <MagnifyingGlass weight="bold" className="text-text-faint" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("views.participantsSidebar.searchDecisionIdTitle")}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-text-faint"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {participants.map((decision) => {
          const active = decision.decisionId === focusId;
          const size = lineageSize.get(decision.decisionId) ?? 0;
          return (
            <button
              key={decision.decisionId}
              onClick={() => onFocus(decision.decisionId)}
              className={`flex w-full flex-col gap-0.5 border-l-2 px-2.5 py-1.5 text-left transition-colors ${
                active
                  ? "border-accent bg-accent/10"
                  : "border-transparent hover:bg-surface-raised"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="truncate font-mono text-[10px] text-text-faint">{decision.decisionId}</span>
                <span className="ml-auto inline-flex items-center gap-0.5 font-mono text-[10px] text-text-faint">
                  <GitBranch weight="bold" />
                  {size}
                </span>
              </div>
              <span className={`truncate text-[12px] leading-snug ${active ? "text-text" : "text-text-muted"}`}>
                {decision.title}
              </span>
              <span className="font-mono text-[10px] text-text-faint">{shortTime(decision)}</span>
            </button>
          );
        })}
        {participants.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-text-faint">{t("views.participantsSidebar.noMatchingDecision")}</div>
        )}
      </div>
    </div>
  );
}
