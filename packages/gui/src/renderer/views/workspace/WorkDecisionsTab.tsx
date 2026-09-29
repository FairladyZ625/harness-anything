import { DenseRow } from "../../components/primitives/DenseRow";
import { Section } from "../../components/primitives/Section";
import { DECISION_REVIEW_GROUPS, DecisionReviewGroups } from "../../components/decisionReview/DecisionReviewGroups.tsx";
import { decisionReviewGroup, decisionReviewSignal, type DecisionReviewSignal } from "../../model/decision-review.ts";
import { decisionReviewRef } from "../../navigation/decisionReviewRoutes.ts";
import type { DecisionRow, FactRef } from "../../model/types.ts";
import type { MessageKey } from "../../i18n/core.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 决策与事实页(原型 v2):本工作派生的 Decision 按评审信号分组(组由读面 readiness
 * 与评审派工映射),事实一行一条、点开直达实体;指向不存在实体的关系如实点名。
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

export interface WorkDecisionsTabProps {
  readonly decisions: readonly DecisionRow[];
  readonly facts: readonly FactRef[];
  readonly missingRefs: readonly string[];
  readonly onNavigateEntity?: (ref: string) => void;
}

export function WorkDecisionsTab({ decisions, facts, missingRefs, onNavigateEntity }: WorkDecisionsTabProps) {
  return (
    <div className="min-w-0 max-w-[900px] space-y-[26px]">
      <WorkDecisionReview decisions={decisions} onNavigateEntity={onNavigateEntity} />
      {facts.length > 0 ? (
        <Section title={t("views.workspace.facts")} count={facts.length}>
          {facts.map((fact) => (
            <div key={fact.anchor} data-fact-row={fact.anchor}>
              <DenseRow
                title={fact.text}
                reason={
                  fact.invalidated
                    ? t("views.workspace.superseded")
                    : fact.archived
                      ? t("views.workspace.archived")
                      : fact.confidence
                }
                time={fact.at ? fact.at.slice(0, 10) : undefined}
                onClick={() => onNavigateEntity?.(fact.anchor)}
              />
            </div>
          ))}
        </Section>
      ) : null}
      {missingRefs.length > 0 ? (
        <p className="break-words text-warning ui-body">
          {t("views.workspace.missingRefs", { refs: missingRefs.join("、") })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 工作内 Decision 按评审下一步分组:组由读面 readiness 与评审派工映射,不另立判据;
 * 查看直达该 Decision 的评审页签。终态 Decision 没有就绪判定,不入组。
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
  if (rows.length === 0) return null;
  return (
    <section data-testid="work-decision-review" aria-labelledby="work-decision-review-title" className="space-y-4">
      <div className="space-y-1">
        <h2 id="work-decision-review-title" className="font-semibold text-text ui-body">
          {t("views.workspace.decisionReviewTitle")}
        </h2>
        <p className="text-text-muted ui-meta">{t("views.workspace.decisionReviewNote")}</p>
      </div>
      <DecisionReviewGroups
        rows={rows}
        groups={DECISION_REVIEW_GROUPS}
        label={t("views.workspace.decisionReviewTitle")}
        testIdPrefix="work-decision-review"
        onOpen={(row) => onNavigateEntity?.(decisionReviewRef(row.id, "review"))}
      />
    </section>
  );
}
