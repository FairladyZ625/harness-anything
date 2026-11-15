import { consumeKnownError } from "../../../api/error-consumption.ts";
import { BoundedContent } from "../../components/primitives/BoundedContent.tsx";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { harnessClient } from "../../api-client.ts";
import { agendaQueryKeys } from "../../agenda-data.ts";
import { taskQueryKeys } from "../../task-data.ts";
import { settleTaskReceipt } from "../../task-actions.ts";
import type { AgendaWorkbenchItem } from "../../model/agenda-workbench.ts";
import type { TaskRow } from "../../model/types.ts";
import { Button } from "../../components/primitives/Button.tsx";
import { TextInput } from "../../components/primitives/TextInput.tsx";
import { Toggle } from "../../components/primitives/Toggle.tsx";
import { t } from "../../i18n/index.tsx";
import { useAgendaContinuation } from "./useAgendaContinuation.ts";
import { AgendaContinuationFeedback } from "./AgendaContinuationFeedback.tsx";
import { AgendaDecisionActions } from "./AgendaDecisionActions.tsx";

export function AgendaInboxActions(props: {
  readonly repoId: string;
  readonly item: AgendaWorkbenchItem;
  readonly tasks: readonly TaskRow[];
  readonly onNavigateEntity: (ref: string) => void;
  readonly onRetain: () => void;
}) {
  const { item } = props;
  if (item.row.ruling || item.row.group === "restart") return <AgendaRuntimeActions {...props} />;
  if (["dispose", "judge"].includes(item.row.group) && item.row.target?.startsWith("decision"))
    return <AgendaDecisionActions {...props} />;
  return null;
}

function AgendaRuntimeActions({
  repoId,
  item,
  onNavigateEntity,
  onRetain,
}: {
  readonly repoId: string;
  readonly item: AgendaWorkbenchItem;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onRetain: () => void;
}) {
  const queryClient = useQueryClient();
  const continuation = useAgendaContinuation(repoId, item.taskId);
  const [answer, setAnswer] = useState("");
  const [autoRun, setAutoRun] = useState(true);
  const [recorded, setRecorded] = useState(false);
  const [pendingWrite, setPendingWrite] = useState<{ opId: string; dismiss: boolean } | null>(null);
  const locked = recorded || pendingWrite !== null;
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const row = item.row.ruling;
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: agendaQueryKeys.read(repoId) }),
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.all(repoId) }),
    ]);
  const submit = async (dismiss = false, opId?: string) => {
    if (busy || !row) return;
    onRetain();
    setBusy(true);
    try {
      const receipt = settleTaskReceipt(
        await (opId
          ? harnessClient.showReceipt({ repoId, opId })
          : dismiss
            ? harnessClient.dismissRuntimeIncident({
                repoId,
                dispatchId: row.dispatchId,
                reason: answer.trim() || t("views.agenda.incidentHandled"),
              })
            : harnessClient.resolveTaskEscalation({
                repoId,
                taskId: row.taskId,
                dispatchId: row.dispatchId,
                answer: answer.trim(),
              })),
      );
      if (receipt.state !== "applied") {
        setFeedback(receipt.hint ?? receipt.state);
        // A pending write must be checked by opId, never replayed as another answer.
        if (receipt.state === "pending") setPendingWrite({ opId: receipt.opId, dismiss });
        else setPendingWrite(null);
        return;
      }
      setPendingWrite(null);
      setRecorded(true);
      setFeedback(t(dismiss ? "views.agenda.incidentClosed" : "views.agenda.answerStored"));
      // This await is outside the canonical write queue, after its durable applied receipt.
      if (!dismiss && autoRun) await continuation.run(undefined);
      await refresh();
    } catch (cause) {
      consumeKnownError(cause);
      setFeedback(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid min-w-0 gap-3 border-t border-border pt-3" data-testid="agenda-inbox-actions">
      {row ? (
        <>
          <BoundedContent className="whitespace-pre-wrap break-words ui-meta">{row.question}</BoundedContent>
          <div className="flex flex-wrap gap-2">
            {row.options.map((option, index) => (
              <Button
                key={option}
                size="sm"
                testId={`agenda-ruling-option-${index}`}
                disabled={busy || locked}
                onClick={() => setAnswer(option)}
              >
                <span className="max-w-[40ch] whitespace-normal break-words text-left">{option}</span>
              </Button>
            ))}
          </div>
          {(row.rulingPath || row.options.length > 0) && (
            <>
              <TextInput
                testId="agenda-ruling-answer"
                label={t("views.agenda.rulingAnswer")}
                value={answer}
                onChange={setAnswer}
                disabled={busy || locked}
              />
              <label className="flex items-center gap-2 ui-meta">
                <Toggle
                  checked={autoRun}
                  onChange={setAutoRun}
                  label={t("views.agenda.autoRerun")}
                  disabled={busy || locked}
                />
                {t("views.agenda.autoRerun")}
              </label>
              <Button
                testId="agenda-ruling-submit"
                variant="primary"
                disabled={!answer.trim() || locked}
                loading={busy}
                onClick={() => void submit()}
              >
                {t("views.agenda.submitRuling")}
              </Button>
            </>
          )}
          {row.attention !== "guard" && row.options.length === 0 && (
            <Button testId="agenda-incident-dismiss" disabled={locked} loading={busy} onClick={() => void submit(true)}>
              {t("views.agenda.closeIncident")}
            </Button>
          )}
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          {continuation.resume && (
            <Button
              testId="agenda-resume"
              loading={continuation.busy}
              onClick={() => {
                onRetain();
                void continuation.run(continuation.resume?.dispatchId);
              }}
            >
              {t("views.agenda.resumeSession")}
            </Button>
          )}
          <Button
            testId="agenda-restart"
            loading={continuation.busy}
            onClick={() => {
              onRetain();
              void continuation.run();
            }}
          >
            {t("views.agenda.restartTask")}
          </Button>
        </div>
      )}
      {continuation.read.isError && (
        <p role="alert" className="ui-meta text-danger">
          {continuation.read.error.message}
        </p>
      )}
      {feedback && !continuation.busy && !continuation.result && !continuation.error && (
        <p role="status" className="break-words ui-meta">
          {feedback}
        </p>
      )}
      {pendingWrite && (
        <Button
          size="sm"
          testId="agenda-ruling-check-receipt"
          loading={busy}
          onClick={() => void submit(pendingWrite.dismiss, pendingWrite.opId)}
        >
          {t("views.agenda.checkReceipt")}
        </Button>
      )}
      <AgendaContinuationFeedback
        continuation={continuation}
        recorded={recorded}
        onNavigateEntity={onNavigateEntity}
        onRetry={() => void continuation.run()}
      />
    </section>
  );
}
