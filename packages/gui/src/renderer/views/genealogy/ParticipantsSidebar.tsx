import { useState } from "react";
import { ListChecks, MagnifyingGlass } from "@phosphor-icons/react";
import type { DecisionRow } from "../../model/types";
import { DecisionStateBadge } from "../../components/badges";
import { DenseRow } from "../../components/primitives/DenseRow";
import { StatusTag } from "../../components/primitives/StatusTag";
import { decisionDayKeyOf } from "../../graph/genealogy";

/**
 * 谱系参与者侧栏(REQ-GUI-05):列焦点谱系内所有 decision,可搜索换焦点。
 * 行用 DenseRow(视觉基线 v1):状态标签 + 标题(经 TitleText 冒号拆分)+ 等宽日期;
 * 终态决策(superseded/outcome_retired/rejected)沉底折叠成一行「已沉底 N · 展开」,
 * 搜索时全量参与(搜索语义不许变:过滤发生在全量 participants 上,命中终态也直接显示)。
 * 完整渲染,不分批(2026-08-25 泽宇裁决:性能顾虑用按需渲染解决,不转嫁给用户点击):
 * 规模不是常数——participants 是「出现在任意谱系边端点上的决策」去重,随台账谱系边
 * 被动累积;标题计数报真实总数,搜索始终在**全量** participants 上过滤。
 */

/** 决策终态(§1.4 收束):谱系里已被取代/撤档/否决的线,默认折叠沉底。 */
const TERMINAL_STATES: ReadonlySet<DecisionRow["state"]> = new Set(["rejected", "superseded", "outcome_retired"]);

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
  const [showTerminal, setShowTerminal] = useState(false);
  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;
  const matches = (d: DecisionRow) =>
    d.title.toLowerCase().includes(needle) || d.decisionId.toLowerCase().includes(needle);
  const live = participants.filter((d) => !TERMINAL_STATES.has(d.state));
  const sunk = participants.filter((d) => TERMINAL_STATES.has(d.state));
  const visibleLive = searching ? live.filter(matches) : live;
  const visibleSunk = searching ? sunk.filter(matches) : showTerminal ? sunk : [];

  const row = (d: DecisionRow) => {
    const size = lineageSize.get(d.decisionId) ?? 0;
    return (
      <DenseRow
        key={d.decisionId}
        tag={<DecisionStateBadge state={d.state} />}
        title={d.title}
        reason={size > 0 ? `±${size}` : undefined}
        time={decisionDayKeyOf(d)}
        selected={d.decisionId === focusId}
        onClick={() => onFocus(d.decisionId)}
      />
    );
  };

  return (
    <aside className="flex basis-1/5 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ListChecks weight="duotone" className="text-text-muted" />
        <span className="font-mono ui-micro font-semibold text-text">参与者</span>
        <span className="ml-auto font-mono ui-micro text-text-faint">{participants.length}</span>
      </div>
      <div className="border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-xs border border-border bg-surface-raised px-2 py-1">
          <MagnifyingGlass weight="bold" className="ui-micro text-text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索换焦点…"
            className="flex-1 bg-transparent ui-micro text-text outline-none placeholder:text-text-faint"
          />
        </div>
      </div>
      <div data-testid="genealogy-participants-rows" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-1">
        {visibleLive.map(row)}
        {!searching && sunk.length > 0 && (
          <DenseRow
            tag={<StatusTag tone="neutral" label="终态" />}
            title={showTerminal ? `已沉底 ${sunk.length} 个 · 收起` : `已沉底 ${sunk.length} 个 · 展开`}
            onClick={() => setShowTerminal((v) => !v)}
          />
        )}
        {visibleSunk.map(row)}
        {visibleLive.length + visibleSunk.length === 0 && (
          <span className="px-2 py-4 text-center ui-micro text-text-faint">无匹配</span>
        )}
      </div>
    </aside>
  );
}
