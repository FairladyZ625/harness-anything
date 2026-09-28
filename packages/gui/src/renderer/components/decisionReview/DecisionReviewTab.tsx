import { t } from "../../i18n/index.tsx";
import type { MessageKey } from "../../i18n/core.ts";
import {
  decisionReviewSignal,
  dispatchOfReview,
  findingResponses,
  reviewCuts,
  reviewOverrides,
  shortDigest,
  type DecisionReview,
} from "../../model/decision-review.ts";
import type { DecisionReviewState, DecisionRow } from "../../model/types.ts";
import { decisionReviewRef, decisionSessionsRef } from "../../navigation/decisionReviewRoutes.ts";
import type { DecisionReviewWriteFeedback } from "../../decision-review-actions.ts";
import { RiskTierBadge } from "../badges.tsx";
import { DecisionMutationFeedback } from "../DecisionMutationFeedback.tsx";
import {
  actorText,
  atText,
  cardClass,
  dispatchStatusText,
  primaryButtonClass,
  ReviewSection,
  secondaryButtonClass,
  VerdictBadge,
} from "./parts.tsx";

/**
 * S3 · Decision 详情「提案与评审」:左栏提案与生效依据,右栏当前/历史切面的评审与评审派工。
 * 就绪判定、下一步与当前切面全部来自读面;这里只陈列并给出跳转(报告 / 会话 / 回应 / 裁决)。
 */
export function DecisionReviewTab({
  decision,
  dispatchFeedback,
  onDispatchReview,
  onNavigateEntity,
}: {
  readonly decision: DecisionRow;
  readonly dispatchFeedback?: DecisionReviewWriteFeedback;
  readonly onDispatchReview: (expectedDigest: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const review = decision.review;
  if (!review) return <p className="ui-meta text-text-faint">{t("views.decisionReview.dispatchesUnavailable")}</p>;
  const cuts = reviewCuts(review),
    readiness = review.readiness,
    pending = dispatchFeedback?.state === "pending";
  return (
    <div data-testid="decision-review-tab" className="grid gap-4">
      <ReadinessBanner decision={decision} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="grid content-start gap-3">
          <section className={cardClass}>
            <h2 className="ui-body font-semibold text-text">{t("views.decisionReview.proposalContent")}</h2>
            <p className="mt-2 ui-meta leading-relaxed text-text">{decision.question}</p>
            {decision.chosen.map((option) => (
              <p key={option.id} className="mt-1.5 ui-meta leading-relaxed text-text-muted">
                <span className="font-mono text-text-faint">{option.id} </span>
                {option.text}
              </p>
            ))}
            <dl className="mt-3 grid gap-1 font-mono ui-micro text-text-faint">
              <div>
                {t("views.decisionReview.proposer")}:{" "}
                {decision.proposedBy ? `${decision.proposedBy.kind}:${decision.proposedBy.id}` : "—"}
              </div>
              <div className="flex items-center gap-1">
                {t("views.decisionReview.risk")}: <RiskTierBadge tier={decision.riskTier} />
              </div>
              <div data-testid="decision-review-current-digest">
                {t("views.decisionReview.currentCut")}: {shortDigest(review.currentDigest)}
              </div>
            </dl>
          </section>
          <section className={cardClass}>
            <h2 className="ui-body font-semibold text-text">{t("views.decisionReview.basisTitle")}</h2>
            <p className="mt-2 ui-meta leading-relaxed text-text">
              {readiness === null
                ? t("views.decisionReview.bannerNotPending")
                : readiness.basis === "review"
                  ? t("views.decisionReview.basisReview")
                  : readiness.basis === "policy_unreviewed"
                    ? t("views.decisionReview.basisPolicy")
                    : t("views.decisionReview.basisNone", {
                        reason: readiness.blocker?.reason ?? readiness.next.reason,
                      })}
            </p>
            <p className="mt-2 ui-micro text-text-faint">{t("views.decisionReview.reviewerIsNotArbiter")}</p>
          </section>
        </div>
        <div className="grid content-start gap-4">
          <ReviewSection
            testId="decision-review-current"
            title={t("views.decisionReview.currentReviews")}
            aside={shortDigest(review.currentDigest)}
          >
            {cuts.current.length === 0 ? (
              <p className="ui-meta text-text-faint">{t("views.decisionReview.noReviews")}</p>
            ) : (
              cuts.current.map((row) => (
                <ReviewCard
                  key={row.reviewId}
                  decisionId={decision.decisionId}
                  review={review}
                  row={row}
                  onNavigateEntity={onNavigateEntity}
                />
              ))
            )}
          </ReviewSection>
          <ReviewSection testId="decision-review-dispatches" title={t("views.decisionReview.dispatchesTitle")}>
            <DispatchList decisionId={decision.decisionId} review={review} onNavigateEntity={onNavigateEntity} />
            {readiness !== null && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="decision-review-dispatch"
                  disabled={pending || review.currentDigest === null}
                  onClick={() => review.currentDigest && onDispatchReview(review.currentDigest)}
                  className={secondaryButtonClass}
                >
                  {t("views.decisionReview.dispatchReview")}
                </button>
                <span className="ui-micro text-text-faint">
                  {review.currentDigest === null
                    ? t("views.decisionReview.digestUnavailable")
                    : t("views.decisionReview.dispatchReviewHint")}
                </span>
              </div>
            )}
            {dispatchFeedback && dispatchFeedback.state !== "pending" && (
              <DecisionMutationFeedback feedback={dispatchFeedback} />
            )}
          </ReviewSection>
          {cuts.historical.length > 0 && (
            <ReviewSection testId="decision-review-historical" title={t("views.decisionReview.historicalReviews")}>
              <p className="ui-micro text-text-faint">{t("views.decisionReview.historicalNote")}</p>
              {cuts.historical.map((row) => (
                <ReviewCard
                  key={row.reviewId}
                  decisionId={decision.decisionId}
                  review={review}
                  row={row}
                  onNavigateEntity={onNavigateEntity}
                />
              ))}
            </ReviewSection>
          )}
        </div>
      </div>
    </div>
  );
}

const BANNER_KEY = {
  reviewing: "views.decisionReview.bannerReviewing",
  changesRequested: "views.decisionReview.bannerChangesRequested",
  unansweredFindings: "views.decisionReview.bannerUnansweredFindings",
  approved: "views.decisionReview.bannerApproved",
  policyUnreviewed: "views.decisionReview.bannerPolicyUnreviewed",
  unreviewed: "views.decisionReview.bannerPolicyUnreviewed",
} as const satisfies Record<string, MessageKey>;

/** 就绪横幅:信号词表与读面 next 原文;blocker 计数取读面列出的 reviewIds / findings。 */
export function ReadinessBanner({ decision }: { readonly decision: DecisionRow }) {
  const review = decision.review,
    signal = decisionReviewSignal(review),
    readiness = review?.readiness ?? null;
  if (signal === null || readiness === null)
    return (
      <p className="rounded-md border border-border bg-surface-raised px-3 py-2 ui-meta text-text-muted">
        {t("views.decisionReview.bannerNotPending")}
      </p>
    );
  const blocker = readiness.blocker,
    count =
      blocker?.code === "changes_requested"
        ? blocker.reviewIds.length
        : blocker?.code === "unanswered_findings"
          ? blocker.findings.length
          : 0,
    tone =
      signal === "changesRequested" || signal === "unansweredFindings"
        ? "border-stale/50 bg-stale/10 text-stale"
        : signal === "approved"
          ? "border-success/40 bg-success/10 text-success"
          : "border-accent/40 bg-accent/10 text-accent";
  return (
    <div data-testid="decision-review-banner" data-signal={signal} className={`rounded-md border px-3 py-2 ${tone}`}>
      <p className="ui-meta font-medium">{t(BANNER_KEY[signal], { count })}</p>
      <p className="mt-1 ui-micro opacity-90">
        {t("views.decisionReview.nextStep", {
          actor: t(
            readiness.next.actor === "owner" ? "views.decisionReview.actorOwner" : "views.decisionReview.actorProposer",
          ),
        })}{" "}
        · {readiness.next.action} · {readiness.next.reason}
      </p>
    </div>
  );
}

function ReviewCard({
  decisionId,
  review,
  row,
  onNavigateEntity,
}: {
  readonly decisionId: string;
  readonly review: DecisionReviewState;
  readonly row: DecisionReview;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const dispatch = dispatchOfReview(review, row),
    overrides = reviewOverrides(review, row.reviewId);
  return (
    <article data-testid={`decision-review-card-${row.reviewId}`} className={cardClass}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate ui-meta font-semibold text-text">
          {row.reviewId} · {actorText(row.actor)}
        </h3>
        <VerdictBadge verdict={row.verdict} />
      </div>
      <p className="mt-1.5 ui-meta leading-relaxed text-text">{row.reason}</p>
      {row.findings.length > 0 && (
        <ul className="mt-2 grid gap-1">
          {row.findings.map((finding) => {
            const latest = findingResponses(review, row.reviewId, finding.findingId)[0];
            return (
              <li key={finding.findingId} className="ui-micro leading-relaxed text-text-muted">
                <span className="font-mono text-text-faint">{finding.findingId} </span>
                {finding.text}
                <span className="ml-1.5 font-mono text-text-faint">
                  ·{" "}
                  {latest === undefined
                    ? t("views.decisionReview.notResponded")
                    : latest.disposition === "adopt"
                      ? t("views.decisionReview.respondedAdopt")
                      : t("views.decisionReview.respondedRebut")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {overrides.map((override) => (
        <p key={override.overriddenAt} className="mt-1.5 ui-micro text-success">
          {t("views.decisionReview.overridden", { reason: override.reason })} · {actorText(override.actor)}
        </p>
      ))}
      <p className="mt-2 font-mono ui-micro text-text-faint">
        {atText(row.reviewedAt)} · {shortDigest(row.reviewContentDigest)}
        {dispatch ? ` · ${dispatch.dispatchId}` : ""}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {row.reportRef ? (
          <button
            type="button"
            data-testid={`decision-review-open-report-${row.reviewId}`}
            className={secondaryButtonClass}
            onClick={() => onNavigateEntity(decisionReviewRef(decisionId, "report", row.reviewId))}
          >
            {t("views.decisionReview.readReport")}
          </button>
        ) : (
          <span className="ui-micro text-text-faint">{t("views.decisionReview.noReport")}</span>
        )}
        {dispatch && (
          <button
            type="button"
            data-testid={`decision-review-open-session-${row.reviewId}`}
            className={secondaryButtonClass}
            onClick={() => onNavigateEntity(decisionSessionsRef(decisionId, dispatch.runtimeSessionId))}
          >
            {t("views.decisionReview.viewSession")}
          </button>
        )}
        {row.verdict === "changes_requested" && (
          <button
            type="button"
            data-testid={`decision-review-respond-${row.reviewId}`}
            className={primaryButtonClass}
            onClick={() => onNavigateEntity(decisionReviewRef(decisionId, "respond"))}
          >
            {t("views.decisionReview.respondEach")}
          </button>
        )}
      </div>
    </article>
  );
}

function DispatchList({
  decisionId,
  review,
  onNavigateEntity,
}: {
  readonly decisionId: string;
  readonly review: DecisionReviewState;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  if (review.dispatches === null)
    return <p className="ui-micro text-text-faint">{t("views.decisionReview.dispatchesUnavailable")}</p>;
  if (review.dispatches.length === 0)
    return <p className="ui-micro text-text-faint">{t("views.decisionReview.noDispatches")}</p>;
  return (
    <ul className="grid gap-1">
      {review.dispatches.map((row) => (
        <li key={row.dispatchId} data-testid={`decision-review-dispatch-${row.dispatchId}`} className={cardClass}>
          <div className="flex flex-wrap items-center gap-2 ui-micro">
            <span className="font-mono text-text-muted">{row.dispatchId}</span>
            <span
              data-status={row.status}
              className={row.status === "failed" || row.status === "unknown" ? "text-stale" : "text-text-muted"}
            >
              {dispatchStatusText(row.status)}
            </span>
            {row.reviewContentDigest !== review.currentDigest && (
              <span className="text-text-faint">· {t("views.decisionReview.dispatchStaleCut")}</span>
            )}
            <button
              type="button"
              className="ml-auto text-accent hover:underline"
              onClick={() => onNavigateEntity(decisionSessionsRef(decisionId, row.runtimeSessionId))}
            >
              {t("views.decisionReview.viewSession")} ↗
            </button>
          </div>
          {row.reportRef === null && (row.status === "succeeded" || row.status === "failed") && (
            <p className="mt-1 ui-micro text-stale">{t("views.decisionReview.dispatchUnregistered")}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
