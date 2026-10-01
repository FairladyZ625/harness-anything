import { useState, type ReactNode } from "react";
import { DenseRow } from "../../components/primitives/DenseRow";
import { Drawer } from "../../components/primitives/Drawer";
import { Section } from "../../components/primitives/Section";
import { StatusTag, type StatusTone } from "../../components/primitives/StatusTag";
import { decisionStateLabel } from "../../components/badges.tsx";
import { entryTitle, highlightText, metaLine } from "./entry-lines.tsx";
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
import type { DecisionRow, DecisionState, FactRef, RelationEdge } from "../../model/types.ts";
import type { MessageKey } from "../../i18n/core.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 决策与事实页(业主 2026-09-30 收束重做;v2 铺开 2026-10-01):事实按所属任务分组、
 * 每条只露结论句(完整原文、取证与关联决策进抽屉),组全部铺开不折「更早 N 组」;
 * 决策按状态分段——待裁决(评审分组)在前、生效中平铺、已退场沉到自己的分区照常显示。
 * 条目两行(§2.4):第一行冒号前的标题;第二行弱色报最近变化与标题补充。同一分区里
 * 取值相同的状态不进行,只有已退场分区(取代/否决/暂缓混排)才带状态标签。
 */

/** 已退场决策的状态色档:否决红,其余退场态暗灰。 */
const RETIRED_TONE: Partial<Record<DecisionState, StatusTone>> = { rejected: "bad" };

function DecisionEntry({
  row,
  needle,
  tag,
  change,
  onOpen,
}: {
  readonly row: DecisionRow;
  readonly needle: string;
  readonly tag?: ReactNode;
  /** 最近变化一句(哪天裁决 / 提出 / 退场);读面没给时间就不报。 */
  readonly change: string | undefined;
  readonly onOpen: () => void;
}) {
  const { focus, supplement } = entryTitle(row.title, needle);
  return <DenseRow relaxed tag={tag} title={focus} reason={metaLine([change, supplement])} onClick={onOpen} />;
}

/** 「{date} 裁决」这类最近变化句:时间缺失返回 undefined。 */
function changeLine(key: MessageKey, at: string | undefined): string | undefined {
  return at === undefined ? undefined : t(key, { date: at.slice(0, 10) });
}

const REVIEW_HINTS: Readonly<Record<DecisionReviewSignal, MessageKey>> = {
  changesRequested: "views.workspace.decisionReviewHintChangesRequested",
  unansweredFindings: "views.workspace.decisionReviewHintUnansweredFindings",
  reviewing: "views.workspace.decisionReviewHintReviewing",
  reviewRequired: "views.workspace.decisionReviewHintReviewRequired",
  approved: "views.workspace.decisionReviewHintApproved",
  policyUnreviewed: "views.workspace.decisionReviewHintPolicyUnreviewed",
  unreviewed: "views.workspace.decisionReviewHintPolicyUnreviewed",
};

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
    <div className="min-w-0 space-y-[26px]">
      <WorkDecisionReview decisions={segments.pending} onNavigateEntity={onNavigateEntity} />
      {segments.inEffect.length > 0 ? (
        <Section title={t("views.workspace.decisionsInEffect")} count={segments.inEffect.length}>
          {segments.inEffect.map((row) => (
            <DecisionEntry
              key={row.decisionId}
              row={row}
              needle={query.trim().toLowerCase()}
              change={changeLine("views.workspace.decisionLine.decided", row.decidedAt ?? row.lastChangedAt)}
              onOpen={() => onNavigateEntity?.(`decision/${row.decisionId}`)}
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
 * 已退场的决策(已取代 / 已否决 / 已暂缓):终态沉底(标准 §1.4 v2),在自己的
 * 分区里照常平铺——分区标题带计数即分隔,不折叠成「展开」;搜索时同样只显示命中行。
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
  const needle = query.trim().toLowerCase();
  if (rows.length === 0) return null;
  const visible = needle === "" ? rows : rows.filter((row) => row.title.toLowerCase().includes(needle));
  return (
    <Section title={t("views.workspace.decisionsRetired")} count={rows.length}>
      {visible.map((row) => (
        <DecisionEntry
          key={row.decisionId}
          row={row}
          needle={needle}
          tag={<StatusTag tone={RETIRED_TONE[row.state] ?? "cancel"} label={decisionStateLabel(row.state)} />}
          change={changeLine("views.workspace.decisionLine.changed", row.lastChangedAt ?? row.decidedAt)}
          onOpen={() => onNavigateEntity?.(`decision/${row.decisionId}`)}
        />
      ))}
    </Section>
  );
}

/** 事实区:一行摘要 + 按任务分组全部铺开(标准 §1.8 v2,不折「更早 N 组」)+ 点行进抽屉看全文。
 * 条目两行:第一行结论句;第二行弱色报置信度(或已替代/已归档)、记录日期与取证来源。 */
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
  const [drawerAnchor, setDrawerAnchor] = useState<string | null>(null);
  const needle = query.trim().toLowerCase(),
    // 搜索命中事实原文(全文,不只结论句)。
    matched = needle === "" ? facts : facts.filter(({ text }) => text.toLowerCase().includes(needle)),
    groups = workFactGroups({ facts: matched, titles }),
    taskCount = new Set(facts.flatMap(({ taskId }) => (taskId === undefined ? [] : [taskId]))).size,
    latestAt = facts.reduce((latest, { at }) => (at.localeCompare(latest) > 0 ? at : latest), facts[0]?.at ?? ""),
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
      {groups.map((group) => (
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
                relaxed
                title={highlightText(shortenShas(factConclusion(fact.text)), needle)}
                reason={metaLine([
                  fact.invalidated
                    ? t("views.workspace.superseded")
                    : fact.archived
                      ? t("views.workspace.archived")
                      : `${t("views.workspace.factConfidence")} ${fact.confidence}`,
                  fact.at ? fact.at.slice(0, 10) : undefined,
                  fact.source === undefined ? undefined : shortenShas(fact.source),
                ])}
                onClick={() => setDrawerAnchor(fact.anchor)}
              />
            </div>
          ))}
        </div>
      ))}
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
          <DecisionEntry
            key={row.decisionId}
            row={row}
            needle=""
            change={changeLine("views.workspace.decisionLine.proposed", row.proposedAt)}
            onOpen={() => onNavigateEntity?.(`decision/${row.decisionId}`)}
          />
        ))}
    </section>
  );
}
