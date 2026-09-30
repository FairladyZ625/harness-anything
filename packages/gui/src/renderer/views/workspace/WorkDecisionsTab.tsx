import { useState, type ReactNode } from "react";
import { DenseRow } from "../../components/primitives/DenseRow";
import { Drawer } from "../../components/primitives/Drawer";
import { Section } from "../../components/primitives/Section";
import { highlightText } from "./WorkTasksTab.tsx";
import { DECISION_REVIEW_GROUPS, DecisionReviewGroups } from "../../components/decisionReview/DecisionReviewGroups.tsx";
import { decisionReviewGroup, decisionReviewSignal, type DecisionReviewSignal } from "../../model/decision-review.ts";
import { decisionReviewRef } from "../../navigation/decisionReviewRoutes.ts";
import {
  decisionSegmentOf,
  factConclusion,
  factDecisionLinks,
  LOOSE_FACT_GROUP,
  shortenShas,
  workFactGroups,
  type DecisionSegment,
} from "../../model/work-facts-digest.ts";
import type { DecisionRow, FactRef, RelationEdge } from "../../model/types.ts";
import type { MessageKey } from "../../i18n/core.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 决策与事实页(业主 2026-09-30 收束重做):事实按所属任务分组、每条只露结论句
 * (完整原文、取证与关联决策进抽屉),默认只展开最近 3 组;决策按状态分段——
 * 待裁决(评审分组)在前、生效中平铺、已退场折叠成一行计数。
 */

const REVIEW_HINTS: Readonly<Record<DecisionReviewSignal, MessageKey>> = {
  changesRequested: "views.workspace.decisionReviewHintChangesRequested",
  unansweredFindings: "views.workspace.decisionReviewHintUnansweredFindings",
  reviewing: "views.workspace.decisionReviewHintReviewing",
  reviewRequired: "views.workspace.decisionReviewHintReviewRequired",
  approved: "views.workspace.decisionReviewHintApproved",
  policyUnreviewed: "views.workspace.decisionReviewHintPolicyUnreviewed",
  unreviewed: "views.workspace.decisionReviewHintPolicyUnreviewed",
};

/** 事实分组默认展开的最近组数;更早的组折叠成一行计数(标准 §1.4 收束)。 */
const OPEN_FACT_GROUPS = 3;

export interface WorkDecisionsTabProps {
  readonly decisions: readonly DecisionRow[];
  readonly facts: readonly FactRef[];
  readonly missingRefs: readonly string[];
  /** 关系边(事实 → 引用它的决策)与标题查表都来自页面已挂载的投影。 */
  readonly relations: readonly RelationEdge[];
  readonly titles: ReadonlyMap<string, string>;
  /** 页内搜索(``/``)的关键字,命中事实原文与决策标题。 */
  readonly query: string;
  readonly agoOf: (iso: string) => string;
  readonly onNavigateEntity?: (ref: string) => void;
}

export function WorkDecisionsTab({
  decisions,
  facts,
  missingRefs,
  relations,
  titles,
  query,
  agoOf,
  onNavigateEntity,
}: WorkDecisionsTabProps) {
  const segments = segmentDecisions(decisions, query);
  return (
    <div className="min-w-0 max-w-[900px] space-y-[26px]">
      <WorkDecisionReview decisions={segments.pending} onNavigateEntity={onNavigateEntity} />
      {segments.inEffect.length > 0 ? (
        <Section title={t("views.workspace.decisionsInEffect")} count={segments.inEffect.length}>
          {segments.inEffect.map((row) => (
            <DenseRow
              key={row.decisionId}
              title={highlightText(row.title, query.trim().toLowerCase())}
              time={(row.decidedAt ?? row.lastChangedAt)?.slice(0, 10)}
              onClick={() => onNavigateEntity?.(`decision/${row.decisionId}`)}
            />
          ))}
        </Section>
      ) : null}
      <RetiredDecisions rows={segments.retired} query={query} onNavigateEntity={onNavigateEntity} />
      <WorkFactDigest
        facts={facts}
        relations={relations}
        decisions={decisions}
        titles={titles}
        query={query}
        agoOf={agoOf}
        onNavigateEntity={onNavigateEntity}
      />
      {missingRefs.length > 0 ? (
        <p className="break-words text-warning ui-body">
          {t("views.workspace.missingRefs", { refs: missingRefs.join("、") })}
        </p>
      ) : null}
    </div>
  );
}

/** 决策按状态分三段;搜索时同时按标题过滤,三段都只留命中行。 */
function segmentDecisions(
  decisions: readonly DecisionRow[],
  query: string,
): Record<DecisionSegment, readonly DecisionRow[]> {
  const needle = query.trim().toLowerCase(),
    segments: Record<DecisionSegment, DecisionRow[]> = { pending: [], inEffect: [], retired: [] };
  for (const row of decisions) {
    if (needle !== "" && !row.title.toLowerCase().includes(needle)) continue;
    segments[decisionSegmentOf(row.state)].push(row);
  }
  return segments;
}

/**
 * 已退场的决策(已取代 / 已否决 / 已暂缓):折叠成一行计数,点开才平铺;
 * 搜索时如实展开,只显示命中行。
 */
function RetiredDecisions({
  rows,
  query,
  onNavigateEntity,
}: {
  readonly rows: readonly DecisionRow[];
  readonly query: string;
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const needle = query.trim().toLowerCase();
  return (
    <Section title={t("views.workspace.decisionsRetired")} count={rows.length}>
      {open || needle !== "" ? (
        rows.map((row) => (
          <DenseRow
            key={row.decisionId}
            title={highlightText(row.title, needle)}
            time={(row.lastChangedAt ?? row.decidedAt)?.slice(0, 10)}
            onClick={() => onNavigateEntity?.(`decision/${row.decisionId}`)}
          />
        ))
      ) : (
        <button
          type="button"
          data-testid="work-decisions-retired-toggle"
          onClick={() => setOpen(true)}
          className="grid w-full grid-cols-[minmax(3rem,auto)_minmax(0,1fr)_auto] items-center gap-[7px] border-t border-border px-3 text-left text-text-faint ui-meta h-[25px]"
        >
          <span />
          <span className="truncate">{t("views.workspace.decisionsRetiredCollapsed", { count: rows.length })}</span>
        </button>
      )}
    </Section>
  );
}

/** 事实区:一行摘要 + 按任务分组(默认展开最近 3 组)+ 点行进抽屉看全文。 */
function WorkFactDigest({
  facts,
  relations,
  decisions,
  titles,
  query,
  agoOf,
  onNavigateEntity,
}: {
  readonly facts: readonly FactRef[];
  readonly relations: readonly RelationEdge[];
  readonly decisions: readonly DecisionRow[];
  readonly titles: ReadonlyMap<string, string>;
  readonly query: string;
  readonly agoOf: (iso: string) => string;
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const [expandedOlder, setExpandedOlder] = useState(false);
  const [drawerAnchor, setDrawerAnchor] = useState<string | null>(null);
  const needle = query.trim().toLowerCase(),
    // 搜索命中事实原文(全文,不只结论句),命中行所在的组全部可见。
    matched = needle === "" ? facts : facts.filter(({ text }) => text.toLowerCase().includes(needle)),
    groups = workFactGroups({ facts: matched, titles }),
    taskCount = new Set(facts.flatMap(({ taskId }) => (taskId === undefined ? [] : [taskId]))).size,
    latestAt = facts.reduce((latest, { at }) => (at.localeCompare(latest) > 0 ? at : latest), facts[0]?.at ?? ""),
    older = needle === "" && !expandedOlder ? Math.max(0, groups.length - OPEN_FACT_GROUPS) : 0,
    visibleGroups = older > 0 ? groups.slice(0, OPEN_FACT_GROUPS) : groups,
    decisionLinks = factDecisionLinks({ relations, decisions }),
    drawerFact = drawerAnchor === null ? null : (facts.find(({ anchor }) => anchor === drawerAnchor) ?? null);
  if (facts.length === 0) return null;
  return (
    <Section
      title={t("views.workspace.facts")}
      count={facts.length}
      note={t("views.workspace.factsSummary", {
        count: facts.length,
        tasks: taskCount,
        ago: agoOf(latestAt),
      })}
    >
      {visibleGroups.map((group) => (
        <div key={group.key} data-fact-group={group.key}>
          <div className="flex items-baseline gap-2.5 border-t border-border py-2">
            <h3 className="min-w-0 truncate font-semibold text-text ui-body">
              {group.key === LOOSE_FACT_GROUP ? t("views.workspace.factsLoose") : (group.title ?? group.key)}
            </h3>
            <span className="ml-auto flex items-center gap-1 font-mono tabular-nums text-text-muted ui-meta">
              {t("views.workspace.factGroupMeta", { count: group.facts.length, ago: agoOf(group.latestAt) })}
            </span>
          </div>
          {group.facts.map((fact) => (
            <div key={fact.anchor} data-fact-row={fact.anchor}>
              <DenseRow
                title={highlightText(shortenShas(factConclusion(fact.text)), needle)}
                reason={
                  fact.invalidated
                    ? t("views.workspace.superseded")
                    : fact.archived
                      ? t("views.workspace.archived")
                      : fact.confidence
                }
                time={fact.at ? fact.at.slice(0, 10) : undefined}
                onClick={() => setDrawerAnchor(fact.anchor)}
              />
            </div>
          ))}
        </div>
      ))}
      {older > 0 ? (
        <button
          type="button"
          data-testid="work-facts-older-toggle"
          onClick={() => setExpandedOlder(true)}
          className="grid w-full grid-cols-[minmax(3rem,auto)_minmax(0,1fr)_auto] items-center gap-[7px] border-t border-border px-3 text-left text-text-faint ui-meta h-[25px]"
        >
          <span />
          <span className="truncate">{t("views.workspace.factsOlder", { count: older })}</span>
        </button>
      ) : null}
      <Drawer
        open={drawerFact !== null}
        onClose={() => setDrawerAnchor(null)}
        ariaLabel={t("views.workspace.factDrawerTitle")}
      >
        {drawerFact !== null ? (
          <FactDetail
            fact={drawerFact}
            titles={titles}
            decisionLinks={decisionLinks.get(drawerFact.anchor) ?? []}
            onNavigateEntity={(ref) => {
              setDrawerAnchor(null);
              onNavigateEntity?.(ref);
            }}
          />
        ) : null}
      </Drawer>
    </Section>
  );
}

/** 抽屉里的单条事实:完整原文、取证来源、置信度、所属任务与关联决策。 */
function FactDetail({
  fact,
  titles,
  decisionLinks,
  onNavigateEntity,
}: {
  readonly fact: FactRef;
  readonly titles: ReadonlyMap<string, string>;
  readonly decisionLinks: readonly { readonly decisionId: string; readonly title: string }[];
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const rows: readonly { readonly label: string; readonly body: ReactNode }[] = [
    {
      label: t("views.workspace.factStatement"),
      body: <p className="whitespace-pre-line break-words text-text ui-body">{fact.text}</p>,
    },
    ...(fact.source !== undefined
      ? [
          {
            label: t("views.workspace.factEvidenceSource"),
            body: <p className="break-words font-mono text-text-muted ui-meta">{fact.source}</p>,
          },
        ]
      : []),
    { label: t("views.workspace.factConfidence"), body: <p className="ui-meta text-text">{fact.confidence}</p> },
    ...(fact.taskId !== undefined
      ? [
          {
            label: t("views.workspace.factTask"),
            body: (
              <button
                type="button"
                onClick={() => onNavigateEntity?.(`task/${fact.taskId}`)}
                className="text-left text-accent hover:underline ui-meta"
              >
                {titles.get(`task/${fact.taskId}`) ?? fact.taskId}
              </button>
            ),
          },
        ]
      : []),
    ...(decisionLinks.length > 0
      ? [
          {
            label: t("views.workspace.factDecisions"),
            body: decisionLinks.map(({ decisionId, title }) => (
              <button
                key={decisionId}
                type="button"
                onClick={() => onNavigateEntity?.(decisionReviewRef(decisionId, "review"))}
                className="block text-left text-accent hover:underline ui-meta"
              >
                {title}
              </button>
            )),
          },
        ]
      : []),
  ];
  return (
    <div className="flex flex-col gap-4" data-testid="work-fact-detail">
      <header className="flex items-baseline gap-2.5">
        <h2 className="font-semibold text-text ui-title">{t("views.workspace.factDrawerTitle")}</h2>
        <span className="font-mono text-text-faint ui-meta">{fact.anchor}</span>
        <span className="ml-auto font-mono tabular-nums text-text-muted ui-meta">{fact.at.slice(0, 10)}</span>
      </header>
      {rows.map(({ label, body }) => (
        <section key={label} className="space-y-1">
          <h3 className="text-text-faint ui-meta">{label}</h3>
          {body}
        </section>
      ))}
      <button
        type="button"
        data-testid="work-fact-open-detail"
        onClick={() => onNavigateEntity?.(fact.anchor)}
        className="self-start rounded-xs border border-border bg-text/5 px-2.5 py-1 ui-meta text-text hover:bg-text/10"
      >
        {t("views.workspace.factOpenDetail")}
      </button>
    </div>
  );
}

/**
 * 工作内 Decision 按评审下一步分组:组由读面 readiness 与评审派工映射,不另立判据;
 * 查看直达该 Decision 的评审页签。没有就绪判定的待裁决行如实平铺,不静默丢失。
 */
function WorkDecisionReview({
  decisions,
  onNavigateEntity,
}: {
  readonly decisions: readonly DecisionRow[];
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const rows = decisions.flatMap((row) => {
    const signal = decisionReviewSignal(row.review);
    return signal === null
      ? []
      : [
          {
            id: row.decisionId,
            title: row.title,
            hint: t(REVIEW_HINTS[signal]),
            group: decisionReviewGroup(signal),
          },
        ];
  });
  if (rows.length === 0 && decisions.length === 0) return null;
  return (
    <section data-testid="work-decision-review" aria-labelledby="work-decision-review-title" className="space-y-4">
      <div className="space-y-1">
        <h2 id="work-decision-review-title" className="font-semibold text-text ui-body">
          {t("views.workspace.decisionReviewTitle")}
        </h2>
        <p className="text-text-muted ui-meta">{t("views.workspace.decisionReviewNote")}</p>
      </div>
      {rows.length > 0 ? (
        <DecisionReviewGroups
          rows={rows}
          groups={DECISION_REVIEW_GROUPS}
          label={t("views.workspace.decisionReviewTitle")}
          testIdPrefix="work-decision-review"
          onOpen={(row) => onNavigateEntity?.(decisionReviewRef(row.id, "review"))}
        />
      ) : (
        <p className="text-sm text-text-muted">{t("views.workspace.none")}</p>
      )}
      {decisions
        .filter((row) => decisionReviewSignal(row.review) === null)
        .map((row) => (
          <DenseRow
            key={row.decisionId}
            title={row.title}
            time={row.proposedAt?.slice(0, 10)}
            onClick={() => onNavigateEntity?.(`decision/${row.decisionId}`)}
          />
        ))}
    </section>
  );
}
