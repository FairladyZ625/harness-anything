import { useState } from "react";
import { ListChecks, MagnifyingGlass } from "@phosphor-icons/react";
import type { DecisionRow } from "../../model/types";
import { DecisionStateBadge } from "../../components/badges";
import { dayKeyOf } from "../../graph/genealogy";

/**
 * 谱系参与者侧栏(REQ-GUI-05):列焦点谱系内所有 decision,可搜索换焦点。
 */
export function ParticipantsSidebar({
  participants,
  focusId,
  lineageSize,
  onFocus,
}: {
  participants: ReadonlyArray<DecisionRow>;
  focusId: string | null;
  lineageSize: ReadonlyMap<string, number>;
  onFocus: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? participants.filter(
        (d) => d.title.toLowerCase().includes(needle) || d.decisionId.toLowerCase().includes(needle),
      )
    : participants;

  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ListChecks weight="duotone" className="text-text-muted" />
        <span className="font-mono text-[11px] font-semibold text-text">参与者</span>
        <span className="ml-auto font-mono text-[10px] text-text-faint">
          {participants.length}
        </span>
      </div>
      <div className="border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded border border-border bg-surface-raised px-2 py-1">
          <MagnifyingGlass weight="bold" className="text-[11px] text-text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索换焦点…"
            className="flex-1 bg-transparent text-[11px] text-text outline-none placeholder:text-text-faint"
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 py-1.5">
        {filtered.map((d) => {
          const active = d.decisionId === focusId;
          const size = lineageSize.get(d.decisionId) ?? 0;
          return (
            <button
              key={d.decisionId}
              onClick={() => onFocus(d.decisionId)}
              className={`flex flex-col gap-1 rounded px-2 py-1.5 text-left ${
                active ? "bg-surface-raised ring-1 ring-accent/40" : "hover:bg-surface-raised"
              }`}
            >
              <span className="line-clamp-2 text-[11px] font-medium text-text">{d.title}</span>
              <div className="flex items-center gap-1.5">
                <DecisionStateBadge state={d.state} />
                <span className="font-mono text-[9px] text-text-faint">{dayKeyOf(d)}</span>
                {size > 0 && (
                  <span className="ml-auto rounded bg-surface px-1 font-mono text-[9px] text-text-faint">
                    ±{size}
                  </span>
                )}
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <span className="px-2 py-4 text-center text-[11px] text-text-faint">无匹配</span>
        )}
      </div>
    </aside>
  );
}
