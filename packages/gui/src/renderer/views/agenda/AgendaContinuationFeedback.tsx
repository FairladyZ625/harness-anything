import type { useAgendaContinuation } from "./useAgendaContinuation.ts";
import { EntityRefLink } from "../../components/EntityRefLink.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { t } from "../../i18n/index.tsx";

export function AgendaContinuationFeedback({
  continuation,
  onRetry,
  onNavigateEntity,
  recorded = false,
}: {
  readonly continuation: ReturnType<typeof useAgendaContinuation>;
  readonly onRetry: () => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly recorded?: boolean;
}) {
  const { result, busy, error } = continuation;
  if (!result && !busy && !error) return null;
  const failed = Boolean(error) || result?.state === "op_rejected";
  return (
    <div
      className="grid min-w-0 gap-2 ui-meta"
      role={failed ? "alert" : "status"}
      data-testid="agenda-continuation-feedback"
    >
      <p className="break-words">
        {recorded && t("views.agenda.answerRecorded")}
        {t(
          failed
            ? "views.agenda.wakeFailed"
            : busy
              ? "views.agenda.waking"
              : result?.state === "applied"
                ? "views.agenda.wakeStarted"
                : "views.agenda.wakePending",
        )}
      </p>
      {(error || (result?.state !== "applied" && result?.hint)) && (
        <p className="break-words text-danger">{error ?? result?.hint}</p>
      )}
      {result?.runtimeSessionId && (
        <EntityRefLink entityRef={`session/${result.runtimeSessionId}`} onNavigate={onNavigateEntity} />
      )}
      {!busy && (failed || result?.state === "pending") && (
        <Button size="sm" testId="agenda-wake-retry" onClick={onRetry}>
          {t(result?.state === "pending" ? "views.agenda.checkReceipt" : "views.agenda.retryWake")}
        </Button>
      )}
    </div>
  );
}
