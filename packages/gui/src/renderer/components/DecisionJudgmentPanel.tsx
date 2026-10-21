import { useEffect, useState } from "react";
import { CheckCircle, ClockClockwise, ProhibitInset } from "@phosphor-icons/react";
import {
  decisionHasReachableEvidence,
  type DecisionAction,
  type DecisionMutationFeedback,
} from "../decision-actions.ts";
import type { DecisionRow, RelationEdge } from "../model/types.ts";
import { DecisionMutationFeedback as FeedbackView } from "./DecisionMutationFeedback.tsx";
import { ApprovalCard, type ApprovalDecision, type ApprovalRisk } from "./agent-ui/ApprovalCard.tsx";
import { AnnotateDiffViewer, type DiffFile } from "./agent-ui/AnnotateDiffViewer.tsx";
import { Button } from "./primitives/Button.tsx";
import { t } from "../i18n/index.tsx";

export interface JudgmentOpenRequest {
  readonly action: DecisionAction;
  readonly nonce: number;
}

const actionLabel: Record<
  DecisionAction,
  "views.decisionsVerdict.accept" | "views.decisionsVerdict.reject" | "views.decisionsVerdict.defer"
> = {
  accept: "views.decisionsVerdict.accept",
  reject: "views.decisionsVerdict.reject",
  defer: "views.decisionsVerdict.defer",
};
const validRationale = (value: string) => [...value.trim()].length >= 1 && [...value.trim()].length <= 199;

export function DecisionJudgmentPanel({
  decision,
  relations,
  feedback,
  openRequest,
  onSubmit,
  onCheckReceipt,
  acceptBlockedReason = null,
}: {
  decision: DecisionRow;
  /** 读面 accept 就绪判定未就绪时的原因:accept 停用并说明,reject/defer 不受影响。 */
  acceptBlockedReason?: string | null;
  relations: ReadonlyArray<RelationEdge>;
  feedback?: DecisionMutationFeedback;
  openRequest?: JudgmentOpenRequest;
  onSubmit: (
    decision: DecisionRow,
    action: DecisionAction,
    input: { readonly rationale: string; readonly judgmentOnlyRationale?: string },
  ) => Promise<DecisionMutationFeedback>;
  onCheckReceipt?: () => void;
}) {
  const [action, setAction] = useState<DecisionAction | null>(openRequest?.action ?? null);
  const [rationale, setRationale] = useState("");
  const [judgmentOnly, setJudgmentOnly] = useState("");
  const [error, setError] = useState<string | null>(null);
  const evidenceReachable = decisionHasReachableEvidence(decision, relations);
  const pending = feedback?.state === "pending";
  useEffect(() => {
    if (openRequest) setAction(openRequest.action);
  }, [openRequest]);

  const submit = async () => {
    if (action === "accept" && acceptBlockedReason !== null) {
      setError(acceptBlockedReason);
      return;
    }
    if (!action || !validRationale(rationale)) {
      setError(t("views.decisionsVerdict.rationaleValidation"));
      return;
    }
    if (action === "accept" && !evidenceReachable && !validRationale(judgmentOnly)) {
      setError(t("views.decisionsVerdict.judgmentOnlyValidation"));
      return;
    }
    setError(null);
    const result = await onSubmit(decision, action, {
      rationale: rationale.trim(),
      ...(action === "accept" && !evidenceReachable ? { judgmentOnlyRationale: judgmentOnly.trim() } : {}),
    });
    if (result.state === "success") {
      setAction(null);
      setRationale("");
      setJudgmentOnly("");
    }
  };

  const risk: ApprovalRisk = decision.riskTier === "high" ? "high" : decision.riskTier === "low" ? "low" : "medium";

  // DecisionRow 没有 options 字段:预览回退链是 chosen → rejected(同为 DecisionClaim[])。
  const previewLines =
    (decision.chosen ?? []).length > 0
      ? decision.chosen.map((c) => `${c.id} | ${c.text}`)
      : (decision.rejected ?? []).length > 0
        ? decision.rejected.map((o) => `${o.id} | ${o.text}`)
        : [decision.question];
  const decisionChanges: DiffFile = {
    // Decision changes are a structured preview, not a repository file. Keep the
    // synthetic path human-readable so entity IDs remain navigable elsewhere in the card.
    filePath: "decision-changes.txt",
    lines: previewLines.map((text, index) => ({ kind: "add" as const, newLineNo: index + 1, text })),
  };

  const decidedState: ApprovalDecision | null =
    feedback?.state === "success"
      ? {
          verdict: action === "reject" ? "denied" : "approved",
          at: new Date().toISOString(),
          reason: "user",
        }
      : null;

  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="decision-judgment-panel">
      <ApprovalCard
        title={decision.title}
        summary={decision.question || decision.decisionId}
        risk={risk}
        previewLines={previewLines}
        previewKind="changes"
        decided={decidedState}
        testId="decision-approval-card"
        hideDefaultActions
      >
        <div className="flex flex-col gap-2 pt-1">
          <AnnotateDiffViewer
            files={[decisionChanges]}
            testId="decision-changes-annotator"
            onBatchSend={(prompt) => {
              setRationale((current) => (current.trim() ? `${current.trim()}\n\n${prompt}` : prompt));
              setError(null);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              testId="decision-judge-accept"
              disabled={pending || acceptBlockedReason !== null}
              tip={acceptBlockedReason ?? undefined}
              onClick={() => {
                setAction("accept");
                setError(null);
              }}
            >
              <CheckCircle weight="bold" aria-hidden />
              {t("views.decisionsVerdict.accept")}
            </Button>
            <Button
              variant="ghost"
              testId="decision-judge-reject"
              disabled={pending}
              onClick={() => {
                setAction("reject");
                setError(null);
              }}
            >
              <ProhibitInset weight="bold" aria-hidden />
              {t("views.decisionsVerdict.reject")}
            </Button>
            <Button
              variant="ghost"
              testId="decision-judge-defer"
              disabled={pending}
              onClick={() => {
                setAction("defer");
                setError(null);
              }}
            >
              <ClockClockwise weight="bold" aria-hidden />
              {t("views.decisionsVerdict.defer")}
            </Button>
          </div>

          {acceptBlockedReason !== null && (
            <p data-testid="decision-judge-accept-blocked" className="ui-micro text-stale">
              {acceptBlockedReason}
            </p>
          )}

          {action && (
            <div className="rounded-lg border border-border bg-surface-raised/50 p-2.5">
              <label className="block ui-micro font-semibold text-text-muted">
                {t("views.decisionsVerdict.actionRationaleLabel", { action: t(actionLabel[action]) })}
              </label>
              <textarea
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                placeholder={t("views.decisionsVerdict.rationalePlaceholder")}
                rows={2}
                maxLength={199}
                disabled={pending}
                className="mt-1 w-full rounded-md border border-border bg-surface p-2 ui-meta leading-relaxed text-text outline-none transition-colors duration-100 focus:border-accent"
              />
              {action === "accept" && !evidenceReachable && (
                <label className="mt-2 block ui-micro font-semibold text-stale">
                  {t("views.decisionsVerdict.judgmentOnlyRationaleLabel")}
                  <textarea
                    value={judgmentOnly}
                    onChange={(event) => setJudgmentOnly(event.target.value)}
                    placeholder={t("views.decisionsVerdict.judgmentOnlyPlaceholder")}
                    rows={2}
                    maxLength={199}
                    disabled={pending}
                    className="mt-1 w-full rounded-md border border-stale/50 bg-surface p-2 ui-meta leading-relaxed text-text outline-none transition-colors duration-100 focus:border-stale"
                  />
                </label>
              )}
              {error && <div className="mt-1 ui-micro text-danger">{error}</div>}
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  testId="decision-judge-cancel"
                  onClick={() => setAction(null)}
                  disabled={pending}
                >
                  {t("views.decisionsVerdict.cancel")}
                </Button>
                <Button variant="primary" size="sm" testId="decision-judge-submit" onClick={submit} disabled={pending}>
                  {t("views.decisionsVerdict.confirmAction", { action: t(actionLabel[action]) })}
                </Button>
              </div>
            </div>
          )}
        </div>
      </ApprovalCard>
      <FeedbackView feedback={feedback} onCheckReceipt={onCheckReceipt} />
    </div>
  );
}
