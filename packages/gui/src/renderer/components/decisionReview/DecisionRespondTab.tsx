import { useState } from "react";
import { t } from "../../i18n/index.tsx";
import { findingResponses, respondableFindings, shortDigest } from "../../model/decision-review.ts";
import type { DecisionRow } from "../../model/types.ts";
import { decisionReviewRef } from "../../navigation/decisionReviewRoutes.ts";
import type { DecisionReviewWriteFeedback } from "../../decision-review-actions.ts";
import { DecisionMutationFeedback } from "../DecisionMutationFeedback.tsx";
import { actorText, atText, cardClass } from "./parts.tsx";
import { Button } from "../primitives/Button.tsx";

type Disposition = "adopt" | "rebut";
type Draft = { readonly disposition: Disposition | null; readonly rationale: string; readonly amendmentRef: string };
const EMPTY_DRAFT: Draft = { disposition: null, rationale: "", amendmentRef: "" };

/**
 * S4 · 逐项回应。「我的判断」不设默认值(task_5122f83e 约束):每条意见由提案人自己选
 * 「采纳并修改」或「反驳,保留方案」并写理由;没选的意见不提交。保存只写回复,不解除
 * changes_requested——阻塞是否解除只看读面 readiness。
 */
export function DecisionRespondTab({
  decision,
  feedback,
  onRespond,
  onNavigateEntity,
}: {
  readonly decision: DecisionRow;
  readonly feedback?: DecisionReviewWriteFeedback;
  readonly onRespond: (
    responses: ReadonlyArray<{
      readonly reviewId: string;
      readonly findingId: string;
      readonly disposition: Disposition;
      readonly rationale: string;
      readonly amendmentRef: string | null;
    }>,
  ) => Promise<DecisionReviewWriteFeedback>;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const review = decision.review,
    findings = review ? respondableFindings(review) : [],
    pending = feedback?.state === "pending";
  const keyOf = (reviewId: string, findingId: string) => `${reviewId}/${findingId}`;
  const update = (key: string, patch: Partial<Draft>) =>
    setDrafts((current) => new Map(current).set(key, { ...(current.get(key) ?? EMPTY_DRAFT), ...patch }));

  const submit = async () => {
    const chosen = findings.flatMap(({ review: row, findingId }) => {
      const draft = drafts.get(keyOf(row.reviewId, findingId));
      return draft && (draft.disposition !== null || draft.rationale.trim() !== "")
        ? [{ reviewId: row.reviewId, findingId, draft }]
        : [];
    });
    if (chosen.length === 0) return setError(t("views.decisionReview.respondNothing"));
    if (chosen.some(({ draft }) => draft.disposition === null || draft.rationale.trim() === ""))
      return setError(t("views.decisionReview.respondValidation"));
    setError(null);
    const result = await onRespond(
      chosen.map(({ reviewId, findingId, draft }) => ({
        reviewId,
        findingId,
        disposition: draft.disposition!,
        rationale: draft.rationale.trim(),
        amendmentRef: draft.amendmentRef.trim() === "" ? null : draft.amendmentRef.trim(),
      })),
    );
    if (result.state === "success") setDrafts(new Map());
  };

  return (
    <div data-testid="decision-respond-tab" className="grid gap-4">
      <header>
        <h2 className="ui-title font-semibold text-text">{t("views.decisionReview.respondTitle")}</h2>
        <p className="mt-2 rounded-xs border border-stale/50 bg-stale/10 px-3 py-2 ui-meta text-stale">
          {t("views.decisionReview.respondNote")}
        </p>
      </header>
      {findings.length === 0 ? (
        <p className="ui-meta text-text-faint">{t("views.decisionReview.respondEmpty")}</p>
      ) : (
        findings.map(({ review: row, findingId, text, anchor }) => {
          const key = keyOf(row.reviewId, findingId),
            draft = drafts.get(key) ?? EMPTY_DRAFT,
            history = review ? findingResponses(review, row.reviewId, findingId) : [];
          return (
            <article key={key} data-testid={`decision-respond-${key}`} className={cardClass}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="ui-meta font-semibold text-text">
                  {findingId}
                  {anchor ? ` · ${anchor}` : ""}
                </h3>
                <span className="font-mono ui-micro text-text-faint">
                  {row.reviewId} · {shortDigest(row.reviewContentDigest)}
                </span>
              </div>
              <p className="mt-1.5 ui-meta leading-relaxed text-text">{text}</p>
              {history.length > 0 && (
                <div
                  data-testid={`decision-respond-${key}-history`}
                  className="mt-2 rounded-xs bg-surface-raised/60 px-2 py-1.5"
                >
                  <p className="font-mono ui-micro uppercase tracking-wide text-text-faint">
                    {t("views.decisionReview.responseHistory")}
                  </p>
                  {history.map((response) => (
                    <p key={response.respondedAt} className="mt-1 ui-micro leading-relaxed text-text-muted">
                      {response.disposition === "adopt"
                        ? t("views.decisionReview.respondedAdopt")
                        : t("views.decisionReview.respondedRebut")}{" "}
                      · {response.rationale}
                      {response.amendmentRef ? ` · ${response.amendmentRef}` : ""}
                      <span className="ml-1.5 font-mono text-text-faint">
                        {actorText(response.actor)} · {atText(response.respondedAt)}
                      </span>
                    </p>
                  ))}
                </div>
              )}
              <fieldset className="mt-3" disabled={pending}>
                <legend className="ui-micro font-semibold text-text-muted">
                  {t("views.decisionReview.myJudgment")}
                </legend>
                <div className="mt-1 flex flex-wrap gap-3" role="radiogroup">
                  {(["adopt", "rebut"] as const).map((disposition) => (
                    <label key={disposition} className="inline-flex items-center gap-1.5 ui-meta text-text">
                      <input
                        type="radio"
                        name={`disposition-${key}`}
                        data-testid={`decision-respond-${key}-${disposition}`}
                        checked={draft.disposition === disposition}
                        onChange={() => update(key, { disposition })}
                      />
                      {t(disposition === "adopt" ? "views.decisionReview.adopt" : "views.decisionReview.rebut")}
                    </label>
                  ))}
                </div>
                <label className="mt-2 block ui-micro font-semibold text-text-muted">
                  {t("views.decisionReview.rationaleLabel")}
                  <textarea
                    data-testid={`decision-respond-${key}-rationale`}
                    value={draft.rationale}
                    onChange={(event) => update(key, { rationale: event.target.value })}
                    rows={2}
                    className="mt-1 w-full rounded-xs border border-border bg-surface p-2 ui-meta text-text outline-none focus:border-accent"
                  />
                </label>
                {draft.disposition === "adopt" && (
                  <label className="mt-2 block ui-micro font-semibold text-text-muted">
                    {t("views.decisionReview.amendmentRefLabel")}
                    <input
                      value={draft.amendmentRef}
                      onChange={(event) => update(key, { amendmentRef: event.target.value })}
                      className="mt-1 w-full rounded-xs border border-border bg-surface p-1.5 font-mono ui-micro text-text outline-none focus:border-accent"
                    />
                  </label>
                )}
              </fieldset>
            </article>
          );
        })
      )}
      {error && <p className="ui-micro text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {findings.length > 0 && (
          <Button variant="primary" testId="decision-respond-save" disabled={pending} onClick={() => void submit()}>
            {t("views.decisionReview.saveResponses")}
          </Button>
        )}
        <Button onClick={() => onNavigateEntity(decisionReviewRef(decision.decisionId, "review"))}>
          {t("views.decisionReview.backToProposal")}
        </Button>
        <Button onClick={() => onNavigateEntity(decisionReviewRef(decision.decisionId, "judge"))}>
          {t("views.decisionReview.judgeThis")}
        </Button>
      </div>
      <DecisionMutationFeedback feedback={feedback} />
    </div>
  );
}
