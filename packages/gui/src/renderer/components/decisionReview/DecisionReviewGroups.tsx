import { useState } from "react";
import type { MessageKey } from "../../i18n/core.ts";
import { t } from "../../i18n/index.tsx";
import type { DecisionReviewGroup } from "../../model/decision-review.ts";

const REVIEW_GROUPS: readonly (readonly [DecisionReviewGroup, MessageKey])[] = [
  ["dispose", "views.workspace.decisionReviewGroupDispose"],
  ["review", "views.workspace.decisionReviewGroupReview"],
  ["reviewing", "views.workspace.decisionReviewGroupReviewing"],
  ["judge", "views.workspace.decisionReviewGroupJudge"],
];

export type DecisionReviewGroupRow = {
  readonly decisionId: string;
  readonly title: string;
  readonly hint: string;
  readonly group: DecisionReviewGroup;
};

/**
 * Decision 按评审下一步分组的列表(原型 S2):全部 / 待处置 / 待评审 / 评审中 / 待裁决五个页签,
 * 页签只改当前显示。工作页与议程页共用,组由调用方从各自读面映射好传入,这里不另立判据。
 */
export function DecisionReviewGroups({
  rows,
  label,
  testIdPrefix,
  onOpen,
}: {
  readonly rows: readonly DecisionReviewGroupRow[];
  readonly label: string;
  readonly testIdPrefix: string;
  readonly onOpen: (row: DecisionReviewGroupRow) => void;
}) {
  const [filter, setFilter] = useState<DecisionReviewGroup | "all">("all");
  const tabs: readonly (readonly [DecisionReviewGroup | "all", MessageKey])[] = [
    ["all", "views.workspace.decisionReviewAll"],
    ...REVIEW_GROUPS,
  ];
  return (
    <>
      <div role="tablist" aria-label={label} className="flex gap-5 border-b border-border">
        {tabs.map(([id, tabLabel]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            data-testid={`${testIdPrefix}-tab-${id}`}
            onClick={() => setFilter(id)}
            className={`shrink-0 border-b-2 pb-2 text-sm ${filter === id ? "border-accent text-accent" : "border-transparent text-text-muted"}`}
          >
            {t(tabLabel)}
          </button>
        ))}
      </div>
      {REVIEW_GROUPS.filter(([id]) => filter === "all" || filter === id).map(([id, groupLabel]) => {
        const groupRows = rows.filter(({ group }) => group === id);
        if (groupRows.length === 0 && filter === "all") return null;
        return (
          <section key={id} data-testid={`${testIdPrefix}-group-${id}`} className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold text-text">{t(groupLabel)}</h3>
              <span className="ui-meta text-text-muted">
                {t("views.workspace.decisionReviewCount", { count: groupRows.length })}
              </span>
            </div>
            {groupRows.length === 0 ? (
              <p className="text-sm text-text-muted">{t("views.workspace.none")}</p>
            ) : (
              <ul className="space-y-2">
                {groupRows.map((row) => (
                  <li
                    key={row.decisionId}
                    className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-semibold text-text">{row.title}</p>
                      <p className="mt-1 ui-meta text-text-muted">{row.hint}</p>
                    </div>
                    <button
                      type="button"
                      data-testid={`${testIdPrefix}-open-${row.decisionId}`}
                      onClick={() => onOpen(row)}
                      className="shrink-0 rounded border border-border bg-surface px-3 py-1.5 text-sm font-semibold text-text hover:border-border-strong"
                    >
                      {t("views.workspace.decisionReviewOpen")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}
