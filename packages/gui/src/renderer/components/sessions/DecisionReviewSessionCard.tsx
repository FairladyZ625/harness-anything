import { t } from "../../i18n/index.tsx";
import { shortDigest, type DecisionReviewRound } from "../../model/decision-review.ts";
import { decisionReviewRef } from "../../navigation/decisionReviewRoutes.ts";
import { dispatchStatusText, VerdictBadge } from "../decisionReview/parts.tsx";

/**
 * S5 · 评审会话的对象卡片:评审对象、绑定切面、派工、运行状态与评审结论分开陈列——运行成功
 * 不等于批准,changes_requested 也不代表提案被否决。回链到被评审 Decision 与中心报告。
 */
export function DecisionReviewSessionCard({
  round,
  onNavigateEntity,
}: {
  readonly round: DecisionReviewRound;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const { dispatch, review } = round;
  return (
    <section
      data-testid="decision-review-session-card"
      className="mb-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5"
    >
      <dl className="grid gap-1 font-mono ui-micro text-text-muted sm:grid-cols-2">
        <div>
          {t("agentRuntime.reviewSessionTarget")}: decision/{round.decisionId}
          {round.decisionTitle ? ` · ${round.decisionTitle}` : ""}
        </div>
        <div>
          {t("agentRuntime.reviewSessionCut")}: {shortDigest(dispatch.reviewContentDigest)}
          {round.currentDigest !== null && dispatch.reviewContentDigest !== round.currentDigest
            ? ` · ${t("views.decisionReview.dispatchStaleCut")}`
            : ""}
        </div>
        <div>
          {t("agentRuntime.reviewSessionDispatch")}: {dispatch.dispatchId}
        </div>
        <div>{t("agentRuntime.reviewSessionLease")}</div>
        <div data-testid="decision-review-session-run">
          {t("agentRuntime.reviewSessionRun")}: {dispatchStatusText(dispatch.status)}
        </div>
        <div data-testid="decision-review-session-verdict" className="flex items-center gap-1.5">
          {t("agentRuntime.reviewSessionVerdict")}:{" "}
          {review ? (
            <VerdictBadge verdict={review.verdict} />
          ) : dispatch.status === "running" ? (
            t("views.decisionReview.dispatchRunning")
          ) : dispatch.status === "unknown" ? (
            t("views.decisionReview.dispatchUnknown")
          ) : (
            <span className="text-stale">{t("agentRuntime.reviewSessionUnregistered")}</span>
          )}
        </div>
      </dl>
      <p className="mt-1.5 ui-micro text-text-faint">{t("agentRuntime.reviewSessionNote")}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          data-testid="decision-review-session-open-decision"
          onClick={() => onNavigateEntity(decisionReviewRef(round.decisionId, "review"))}
          className="rounded border border-border bg-surface px-2 py-0.5 ui-micro text-text hover:border-accent hover:text-accent"
        >
          {t("agentRuntime.reviewSessionOpenDecision")} ↗
        </button>
        {review?.reportRef && (
          <button
            type="button"
            data-testid="decision-review-session-open-report"
            onClick={() => onNavigateEntity(decisionReviewRef(round.decisionId, "report", review.reviewId))}
            className="rounded border border-border bg-surface px-2 py-0.5 ui-micro text-text hover:border-accent hover:text-accent"
          >
            {t("agentRuntime.reviewSessionOpenReport")} ↗
          </button>
        )}
      </div>
    </section>
  );
}
