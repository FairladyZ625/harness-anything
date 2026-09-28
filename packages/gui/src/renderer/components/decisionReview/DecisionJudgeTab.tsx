import { useState } from "react";
import { t } from "../../i18n/index.tsx";
import type { DecisionAction, DecisionMutationFeedback as JudgeFeedback } from "../../decision-actions.ts";
import type { DecisionReviewWriteFeedback } from "../../decision-review-actions.ts";
import { reviewById, shortDigest } from "../../model/decision-review.ts";
import type { DecisionRow, RelationEdge } from "../../model/types.ts";
import { decisionReviewRef } from "../../navigation/decisionReviewRoutes.ts";
import { RiskTierBadge } from "../badges.tsx";
import { DecisionJudgmentPanel } from "../DecisionJudgmentPanel.tsx";
import { DecisionMutationFeedback } from "../DecisionMutationFeedback.tsx";
import { ReadinessBanner } from "./DecisionReviewTab.tsx";
import { cardClass, primaryButtonClass, secondaryButtonClass } from "./parts.tsx";

/**
 * S8 · 裁决确认:当前切面、将写入的 basis、未处置打回与业主具名处置。accept 是否可点只看
 * 读面 readiness.ready;权限(提案人/裁决资格/人类同意)由中心按裁决矩阵判定,GUI 不自造规则。
 * 真实写入自动带 expectedDigest(decision-actions judge),内容变化即被拒并需重读。
 */
export function DecisionJudgeTab({
  decision,
  relations,
  judgeFeedback,
  overrideFeedback,
  onJudge,
  onCheckReceipt,
  onOverride,
  onNavigateEntity,
}: {
  readonly decision: DecisionRow;
  readonly relations: ReadonlyArray<RelationEdge>;
  readonly judgeFeedback?: JudgeFeedback;
  readonly overrideFeedback?: DecisionReviewWriteFeedback;
  readonly onJudge?: (
    decision: DecisionRow,
    action: DecisionAction,
    input: { readonly rationale: string; readonly judgmentOnlyRationale?: string },
  ) => Promise<JudgeFeedback>;
  readonly onCheckReceipt?: () => void;
  readonly onOverride: (input: {
    readonly reviewContentDigest: string;
    readonly reviewIds: readonly string[];
    readonly reason: string;
  }) => Promise<DecisionReviewWriteFeedback>;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const review = decision.review,
    readiness = review?.readiness ?? null,
    blockingIds = readiness?.blocker?.code === "changes_requested" ? readiness.blocker.reviewIds : [],
    overridePending = overrideFeedback?.state === "pending";

  const submitOverride = async () => {
    if (selected.size === 0 || reason.trim() === "" || !review?.currentDigest)
      return setError(t("views.decisionReview.overrideValidation"));
    setError(null);
    const result = await onOverride({
      reviewContentDigest: review.currentDigest,
      reviewIds: blockingIds.filter((id) => selected.has(id)),
      reason: reason.trim(),
    });
    if (result.state === "success") {
      setSelected(new Set());
      setReason("");
    }
  };

  return (
    <div data-testid="decision-judge-tab" className="grid gap-4">
      <header>
        <h2 className="ui-title font-semibold text-text">{t("views.decisionReview.judgeTitle")}</h2>
        <p className="mt-1 ui-meta text-text-muted">{t("views.decisionReview.judgeLead")}</p>
      </header>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="grid content-start gap-3">
          <section className={cardClass}>
            <p className="font-mono ui-micro uppercase tracking-wide text-text-faint">
              {t("views.decisionReview.judgeContent")}
            </p>
            <h3 className="mt-1 ui-body font-semibold text-text">{decision.title}</h3>
            <p className="mt-1 flex items-center gap-1.5 font-mono ui-micro text-text-faint">
              decision/{decision.decisionId} · {shortDigest(review?.currentDigest ?? null)} ·{" "}
              <RiskTierBadge tier={decision.riskTier} />
            </p>
            <div className="mt-2">
              <ReadinessBanner decision={decision} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => onNavigateEntity(`decision/${decision.decisionId}`)}
              >
                {t("views.decisionReview.backToProposal")}
              </button>
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => onNavigateEntity(decisionReviewRef(decision.decisionId, "review"))}
              >
                {t("views.decisionReview.tabReview")}
              </button>
            </div>
          </section>
          {blockingIds.length > 0 && (
            <section data-testid="decision-judge-unresolved" className={cardClass}>
              <h3 className="ui-meta font-semibold text-text">{t("views.decisionReview.unresolvedReviews")}</h3>
              <p className="mt-1 ui-micro text-text-faint">{t("views.decisionReview.overrideHint")}</p>
              <fieldset className="mt-2 grid gap-1.5" disabled={overridePending}>
                {blockingIds.map((reviewId) => {
                  const row = reviewById(decision, reviewId);
                  return (
                    <label key={reviewId} className="flex items-start gap-2 ui-meta text-text">
                      <input
                        type="checkbox"
                        data-testid={`decision-override-pick-${reviewId}`}
                        checked={selected.has(reviewId)}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(reviewId);
                            else next.delete(reviewId);
                            return next;
                          })
                        }
                      />
                      <span>
                        <span className="font-mono">{reviewId}</span>
                        {row ? ` · ${row.findings.map(({ findingId }) => findingId).join("、")} · ${row.reason}` : ""}
                      </span>
                    </label>
                  );
                })}
                <label className="block ui-micro font-semibold text-text-muted">
                  {t("views.decisionReview.overrideReason")}
                  <textarea
                    data-testid="decision-override-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    rows={2}
                    className="mt-1 w-full rounded-md border border-border bg-surface p-2 ui-meta text-text outline-none focus:border-accent"
                  />
                </label>
              </fieldset>
              {error && <p className="mt-1 ui-micro text-danger">{error}</p>}
              <button
                type="button"
                data-testid="decision-override-submit"
                disabled={overridePending}
                onClick={() => void submitOverride()}
                className={`${primaryButtonClass} mt-2`}
              >
                {t("views.decisionReview.overrideSubmit")}
              </button>
              <DecisionMutationFeedback feedback={overrideFeedback} />
            </section>
          )}
        </div>
        <section className={cardClass}>
          <h3 className="ui-meta font-semibold text-text">{t("views.decisionReview.judgeRecord")}</h3>
          <p data-testid="decision-judge-basis" className="mt-1 font-mono ui-micro text-text-muted">
            {t("views.decisionReview.judgeBasis", {
              basis: readiness?.basis ?? t("views.decisionReview.judgeBasisNone"),
            })}
          </p>
          <p className="mt-1 ui-micro text-text-faint">{t("views.decisionReview.reviewerIsNotArbiter")}</p>
          {onJudge && readiness !== null ? (
            <DecisionJudgmentPanel
              decision={decision}
              relations={relations}
              feedback={judgeFeedback}
              onSubmit={onJudge}
              onCheckReceipt={onCheckReceipt}
              acceptBlockedReason={
                readiness.ready
                  ? null
                  : t("views.decisionReview.judgeBlocked", {
                      reason: readiness.blocker?.reason ?? readiness.next.reason,
                    })
              }
            />
          ) : (
            <p className="mt-2 ui-micro text-text-faint">{t("views.decisionReview.bannerNotPending")}</p>
          )}
          <p className="mt-2 ui-micro text-text-faint">{t("views.decisionReview.judgeDigestNote")}</p>
        </section>
      </div>
    </div>
  );
}
