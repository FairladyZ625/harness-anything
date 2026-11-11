import { guiInteractionPolicy } from "../../../api/renderer-dto.ts";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TaskRow } from "../../model/types.ts";
import { useTaskActions } from "../../task-actions.ts";
import { taskQueryKeys } from "../../task-data.ts";
import { taskReworkClient } from "../../task-rework-client.ts";
import { t } from "../../i18n/index.tsx";
import { INPUT } from "../../authorization-ui.tsx";
import { Button } from "../primitives/Button.tsx";
import { TextInput } from "../primitives/TextInput.tsx";
import { BoundedContent } from "../primitives/BoundedContent.tsx";
import { IdText } from "../IdText.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";

/** Presentation of task-show plus the existing ReworkTask action; the daemon owns admission. */
export function TaskReworkPanel({
  task,
  onNavigateEntity,
}: {
  readonly task: TaskRow;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const read = useQuery({
      queryKey: taskQueryKeys.rework(task.projectId, task.taskId),
      queryFn: () => taskReworkClient.read(task.projectId, task.taskId),
      retry: guiInteractionPolicy.defaultValue.retry,
    }),
    actions = useTaskActions(task.projectId),
    feedback = actions.feedback.get(task.taskId),
    [selected, setSelected] = useState(""),
    [reason, setReason] = useState(""),
    [agentId, setAgentId] = useState(""),
    targets = read.data?.reworkTargets ?? [],
    target = targets.find((value) => value.executionId === selected) ?? targets[0],
    arrangement = read.data?.task?.executionArrangement,
    pending = feedback?.state === "pending";

  return (
    <section data-testid="task-rework-panel" className="grid min-w-0 gap-3 border-b border-border p-3">
      <h3 className="font-semibold">{t("taskRework.title")}</h3>
      <p className="m-0 ui-meta text-text-muted">{t("taskRework.rule")}</p>
      {read.isPending ? (
        <p role="status">{t("taskRework.loading")}</p>
      ) : read.isError ? (
        <p role="alert">{read.error.message}</p>
      ) : (
        <>
          <div data-testid="task-rework-state" className="grid min-w-0 gap-1 ui-meta">
            <p>
              {t(arrangement ? (arrangement.ready ? "taskRework.ready" : "taskRework.incomplete") : "taskRework.auto")}
            </p>
            {arrangement && (
              <>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span>{t("taskRework.round", { iteration: arrangement.iteration })}</span>
                  <EntityRefLink entityRef={`execution/${arrangement.executionId}`} onNavigate={onNavigateEntity} />
                  <IdText value={arrangement.submissionDigest} />
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span>{t("taskRework.arranger")}</span>
                  <IdText value={arrangement.actor.principal.personId} />
                  {arrangement.agentId && (
                    <EntityRefLink entityRef={`agent/${arrangement.agentId}`} onNavigate={onNavigateEntity} />
                  )}
                </div>
                <BoundedContent className="whitespace-pre-wrap break-words">{arrangement.reason}</BoundedContent>
              </>
            )}
          </div>
          {target ? (
            <form
              className="grid min-w-0 gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!pending && reason.trim())
                  void actions.reworkTask(task, {
                    ...target,
                    reason: reason.trim(),
                    ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
                  });
              }}
            >
              <label className="grid min-w-0 gap-1 ui-meta">
                {t("taskRework.target")}
                <select
                  data-testid="task-rework-target"
                  className={`${INPUT} w-full min-w-0`}
                  value={target.executionId}
                  disabled={pending}
                  onChange={(event) => setSelected(event.currentTarget.value)}
                >
                  {targets.map((value) => (
                    <option key={value.executionId} value={value.executionId}>
                      {value.executionId}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex min-w-0 items-center gap-2 ui-meta" data-testid="task-rework-digest">
                <span>{t("taskRework.digest")}</span>
                <IdText value={target.submissionDigest} />
              </div>
              <label className="grid min-w-0 gap-1 ui-meta">
                {t("taskRework.reason")}
                <TextInput
                  testId="task-rework-reason"
                  label={t("taskRework.reason")}
                  value={reason}
                  onChange={setReason}
                  disabled={pending}
                />
              </label>
              <label className="grid min-w-0 gap-1 ui-meta">
                {t("taskRework.agent")}
                <TextInput
                  testId="task-rework-agent"
                  label={t("taskRework.agent")}
                  value={agentId}
                  onChange={setAgentId}
                  disabled={pending}
                />
              </label>
              <Button
                type="submit"
                testId="task-rework-submit"
                variant="primary"
                loading={pending}
                disabled={!reason.trim()}
              >
                {t("taskRework.submit")}
              </Button>
            </form>
          ) : (
            <p className="ui-meta text-text-muted">{t("taskRework.empty")}</p>
          )}
        </>
      )}
      {feedback && (
        <div
          data-testid="task-rework-feedback"
          role={feedback.state === "error" ? "alert" : "status"}
          className={`grid min-w-0 gap-1 ui-meta ${feedback.state === "error" ? "text-danger" : "text-text-muted"}`}
        >
          <p>
            {feedback.state} · <IdText value={feedback.opId} />
            {feedback.code && (
              <>
                {" "}
                · <IdText value={feedback.code} />
              </>
            )}
          </p>
          <BoundedContent className="whitespace-pre-wrap break-words">{feedback.hint}</BoundedContent>
        </div>
      )}
    </section>
  );
}
