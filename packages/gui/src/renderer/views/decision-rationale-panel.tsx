import { t } from "../i18n/index.tsx";

type RationaleAction = "accept" | "reject" | "defer";

export function DecisionRationalePanel({
  action,
  draft,
  error,
  onDraftChange,
  onCancel,
  onSubmit,
  onSubmitExistingEvidence,
}: {
  action: RationaleAction;
  draft: string;
  error: string | null;
  onDraftChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onSubmitExistingEvidence: () => void;
}) {
  return (
    <div className="mt-2 rounded-md border border-border bg-surface-raised/60 p-2.5" data-testid="decision-rationale-panel">
      {action === "accept" ? (
        <>
          <div className="text-[11px] font-semibold text-text-muted">
            {t("views.decisionsVerdict.acceptEvidenceFloorTitle")}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-text-faint">
            {t("views.decisionsVerdict.acceptEvidenceFloorHelp")}
          </p>
          <button
            type="button"
            onClick={onSubmitExistingEvidence}
            data-testid="decision-accept-existing-evidence"
            className="mt-2 w-full rounded border border-accent/40 bg-accent/5 px-2.5 py-1.5 text-left text-[11px] font-semibold text-accent hover:bg-accent/10"
          >
            {t("views.decisionsVerdict.acceptWithExistingEvidence")}
          </button>
          <div className="my-2 flex items-center gap-2 text-[10px] text-text-faint">
            <span className="h-px flex-1 bg-border" />
            {t("views.decisionsVerdict.orRecordJudgmentOnly")}
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="mb-1 text-[11px] font-semibold text-text-muted">
            {t("views.decisionsVerdict.judgmentOnlyRationaleRequired")}
          </div>
        </>
      ) : (
        <div className="mb-1 text-[11px] font-semibold text-text-muted">
          {action === "reject"
            ? t("views.decisionsVerdict.rationaleRequiredForReject")
            : t("views.decisionsVerdict.rationaleOptionalForDefer")}
        </div>
      )}
      <textarea
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        rows={3}
        data-testid={action === "accept" ? "decision-judgment-only-input" : "decision-rationale-input"}
        placeholder={t(
          action === "accept"
            ? "views.decisionsVerdict.judgmentOnlyPlaceholder"
            : "views.decisionsVerdict.rationalePlaceholder",
        )}
        className="w-full resize-y rounded border border-border bg-surface px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
        autoFocus
      />
      {error && (
        <div className="mt-1 text-[11px] text-danger" data-testid="decision-rationale-error">{error}</div>
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-[11px] text-text-muted hover:bg-surface hover:text-text"
        >
          {t("views.decisionsVerdict.cancelRationale")}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          data-testid={action === "accept" ? "decision-accept-judgment-only" : "decision-rationale-submit"}
          className={`rounded px-2.5 py-1 text-[11px] font-semibold ${
            action === "reject"
              ? "bg-danger/15 text-danger hover:bg-danger/25"
              : action === "accept"
                ? "bg-accent/15 text-accent hover:bg-accent/25"
                : "bg-stale/15 text-stale hover:bg-stale/25"
          }`}
        >
          {action === "reject"
            ? t("views.decisionsVerdict.confirmReject")
            : action === "accept"
              ? t("views.decisionsVerdict.confirmJudgmentOnly")
              : t("views.decisionsVerdict.confirmDefer")}
        </button>
      </div>
    </div>
  );
}
