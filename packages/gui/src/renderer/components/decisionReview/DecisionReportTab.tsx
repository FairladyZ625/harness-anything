import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { dispatchOfReview, reviewById, shortDigest } from "../../model/decision-review.ts";
import type { DecisionRow } from "../../model/types.ts";
import { decisionReviewRef, decisionSessionsRef } from "../../navigation/decisionReviewRoutes.ts";
import { actorText, atText, cardClass, VerdictBadge } from "./parts.tsx";
import { Button } from "../primitives/Button.tsx";
import { DocReader } from "../DocReader.tsx";

type ReportRead =
  | { readonly state: "ready"; readonly body: string }
  | { readonly state: "pending" }
  | { readonly state: "unavailable"; readonly code: string };

/** 中心文档读(`ha doc show` 同一动作):按评审的 reportRef 读 canonical 正文,绝不回落本机同名文件。 */
export async function readReviewReport(repoId: string, reportRef: string): Promise<ReportRead> {
  const receipt = (await harnessClient.showDocument({ repoId, path: reportRef })) as Awaited<
    ReturnType<typeof harnessClient.showDocument>
  > & { readonly evidence?: string; readonly error?: { readonly code?: string } };
  if (receipt.outcome === "applied" && typeof receipt.evidence === "string")
    return { state: "ready", body: receipt.evidence };
  if (receipt.outcome === "pending") return { state: "pending" };
  return { state: "unavailable", code: receipt.error?.code ?? receipt.outcome };
}

/**
 * S6 · 独立评审报告:正文、结论与意见、被审切面、派工与会话回链。报告缺失/追赶/不可达
 * 逐态说明,不以空白或本机文件冒充。
 */
export function DecisionReportTab({
  repoId,
  decision,
  reviewId,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly decision: DecisionRow;
  readonly reviewId: string | null;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const review = decision.review,
    row = reviewById(decision, reviewId),
    reportRef = row?.reportRef ?? null;
  const report = useQuery({
    queryKey: ["decision-review-report", repoId, reportRef],
    queryFn: () => readReviewReport(repoId, reportRef!),
    enabled: reportRef !== null,
    staleTime: 30_000,
  });
  if (!review || row === null) {
    const withReports = review?.reviews.filter(({ reportRef: ref }) => ref !== null) ?? [];
    return (
      <div data-testid="decision-report-tab" className="grid gap-2">
        <p className="ui-meta text-text-faint">
          {reviewId === null
            ? t("views.decisionReview.reportPick")
            : t("views.decisionReview.reportNotFound", { reviewId })}
        </p>
        {withReports.map((candidate) => (
          <span key={candidate.reviewId} className="justify-self-start">
            <Button
              onClick={() => onNavigateEntity(decisionReviewRef(decision.decisionId, "report", candidate.reviewId))}
            >
              {candidate.reviewId} · {atText(candidate.reviewedAt)}
            </Button>
          </span>
        ))}
      </div>
    );
  }
  const dispatch = dispatchOfReview(review, row);
  return (
    <div data-testid="decision-report-tab" className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="ui-title font-semibold text-text">{t("views.decisionReview.reportTitle")}</h2>
          <p className="mt-1 font-mono ui-micro text-text-faint">{reportRef ?? "—"}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            testId="decision-report-back-decision"
            onClick={() => onNavigateEntity(decisionReviewRef(decision.decisionId, "review"))}
          >
            {t("views.decisionReview.reportBackDecision")}
          </Button>
          {dispatch && (
            <Button
              testId="decision-report-back-session"
              onClick={() => onNavigateEntity(decisionSessionsRef(decision.decisionId, dispatch.runtimeSessionId))}
            >
              {t("views.decisionReview.reportBackSession")}
            </Button>
          )}
        </div>
      </header>
      <section className={cardClass}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="ui-meta font-semibold text-text">
            {row.reviewId} · {actorText(row.actor)}
          </h3>
          <VerdictBadge verdict={row.verdict} />
        </div>
        <p className="mt-1 font-mono ui-micro text-text-faint">
          <EntityRefLink entityRef={`decision/${decision.decisionId}`} onNavigate={onNavigateEntity} /> ·{" "}
          {shortDigest(row.reviewContentDigest)}
          {dispatch ? ` · ${dispatch.dispatchId} · ${dispatch.runtimeSessionId}` : ""} · {atText(row.reviewedAt)}
        </p>
        <p className="mt-2 ui-micro font-semibold text-text-muted">{t("views.decisionReview.reportConclusion")}</p>
        <p className="mt-1 ui-meta leading-relaxed text-text">{row.reason}</p>
        {row.findings.map((finding) => (
          <p key={finding.findingId} className="mt-1.5 ui-meta leading-relaxed text-text-muted">
            <span className="font-mono text-text-faint">{finding.findingId} </span>
            {finding.text}
          </p>
        ))}
      </section>
      <section data-testid="decision-report-body" className={cardClass}>
        {reportRef === null ? (
          <p className="ui-meta text-text-faint">{t("views.decisionReview.reportNoRef")}</p>
        ) : report.isPending ? (
          <p className="ui-meta text-text-faint">{t("views.decisionReview.reportLoading")}</p>
        ) : report.isError ? (
          <p role="alert" className="ui-meta text-danger">
            {t("views.decisionReview.reportMissing", {
              code: report.error instanceof Error ? report.error.message : String(report.error),
            })}
          </p>
        ) : report.data.state === "pending" ? (
          <p className="ui-meta text-stale">{t("views.decisionReview.reportPending")}</p>
        ) : report.data.state === "unavailable" ? (
          <p role="alert" className="ui-meta text-stale">
            {t("views.decisionReview.reportMissing", { code: report.data.code })}
          </p>
        ) : (
          <DocReader content={report.data.body} />
        )}
      </section>
      <p className="ui-micro text-text-faint">{t("views.decisionReview.reportBinding")}</p>
    </div>
  );
}
