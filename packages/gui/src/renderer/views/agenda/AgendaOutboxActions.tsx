import { consumeKnownError } from "../../../api/error-consumption.ts";
import { startWorkIdempotencyKey, startWorkPlan } from "../../start-work-flow.ts";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { harnessClient } from "../../api-client.ts";
import { settleTaskReceipt, useTaskActions } from "../../task-actions.ts";
import { taskReworkClient } from "../../task-rework-client.ts";
import { taskQueryKeys } from "../../task-data.ts";
import { agendaQueryKeys } from "../../agenda-data.ts";
import { useCatalogSnapshot, useCatalogPreset } from "../../catalog-data.ts";
import type { AgendaWorkbenchItem } from "../../model/agenda-workbench.ts";
import type { TaskRow } from "../../model/types.ts";
import { EntityRefLink } from "../../components/EntityRefLink.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { TextInput } from "../../components/primitives/TextInput.tsx";
import { t } from "../../i18n/index.tsx";

export function AgendaOutboxActions({
  repoId,
  item,
  tasks,
  onRetain,
  onArchived,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly item: AgendaWorkbenchItem;
  readonly tasks: readonly TaskRow[];
  readonly onRetain: () => void;
  readonly onArchived: (taskIds: readonly string[]) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const queryClient = useQueryClient();
  const actions = useTaskActions(repoId);
  const [reason, setReason] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const task = item.task;
  const done = task?.coordinationStatus === "done";
  const reviewing = task?.coordinationStatus === "submitted" || task?.coordinationStatus === "in_review";
  const rework = useQuery({
    queryKey: taskQueryKeys.rework(repoId, item.taskId ?? ""),
    queryFn: () => taskReworkClient.read(repoId, item.taskId!),
    enabled: reviewing && Boolean(item.taskId),
  });
  // Catalog is needed only for the selected completed card's follow-up creation.
  const catalog = useCatalogSnapshot(done ? repoId : null);
  const preset = useCatalogPreset(
    repoId,
    done ? (catalog.data?.defaults.presetId ?? null) : null,
    catalog.data?.defaults.locale ?? "zh-CN",
  );
  const scaffold = preset.data?.resolved.documents.find((document) => document.slot === "task.plan")?.body;
  const plan =
    typeof scaffold === "string"
      ? startWorkPlan(scaffold, title, title, t("views.work.startWork.planSectionNote"))
      : null;
  const batch = item.workRootId
    ? tasks.filter(
        (row) =>
          (row.workId ?? row.taskId) === item.workRootId &&
          row.coordinationStatus === "done" &&
          row.packageDisposition === "active",
      )
    : [];
  const approved = task?.reviews?.findLast((review) => review.verdict === "approved");
  const needsConsent = approved && !task?.consents?.some((consent) => consent.reviewId === approved.reviewId);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.all(repoId) }),
      queryClient.invalidateQueries({ queryKey: agendaQueryKeys.read(repoId) }),
    ]);
  const archive = async (taskIds: readonly string[]) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = settleTaskReceipt(
        await harnessClient.archiveTasks({ repoId, taskIds, reason: t("views.agenda.archiveReason") }),
      );
      setFeedback(result.state === "applied" ? t("views.agenda.received") : (result.hint ?? result.state));
      if (result.state === "applied") {
        onArchived(taskIds);
        await refresh();
      }
    } catch (cause) {
      consumeKnownError(cause);
      setFeedback(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    const defaults = catalog.data?.defaults;
    if (!defaults || !title.trim() || !task || !plan || busy) return;
    onRetain();
    setBusy(true);
    try {
      const receipt = await harnessClient.createTask({
        repoId,
        title: title.trim(),
        plan,
        presetId: defaults.presetId,
        verticalId: defaults.verticalId,
        locale: defaults.locale,
        riskTier: task.riskTier ?? "low",
        taskClass: "standard",
        workKind: "feat",
        parentTaskId: item.workRootId ?? task.taskId,
        idempotencyKey: startWorkIdempotencyKey({
          title: title.trim(),
          intent: title.trim(),
          presetId: defaults.presetId,
          riskTier: task.riskTier ?? "low",
          taskClass: "standard",
          workKind: "feat",
          parentTaskId: item.workRootId ?? task.taskId,
        }),
      });
      const result = settleTaskReceipt(receipt);
      if (result.state === "applied" && receipt.ok) {
        setCreated(receipt.taskId);
        await refresh();
      } else setFeedback(result.hint ?? result.state);
    } catch (cause) {
      consumeKnownError(cause);
      setFeedback(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!task) return null;
  const mutation = actions.feedback.get(task.taskId);
  return (
    <section className="grid min-w-0 gap-3 border-t border-border pt-3" data-testid="agenda-outbox-actions">
      {reviewing && (
        <>
          <div className="flex flex-wrap gap-2">
            {needsConsent && (
              <Button
                testId="agenda-consent"
                variant="primary"
                disabled={mutation?.state === "pending"}
                onClick={() => void actions.consentReview(task, approved.reviewId)}
              >
                {t("views.agenda.consentCloseout")}
              </Button>
            )}
            {approved && !needsConsent && (
              <Button
                testId="agenda-complete"
                disabled={mutation?.state === "pending"}
                onClick={() => void actions.completeTask(task)}
              >
                {t("views.agenda.completeTask")}
              </Button>
            )}
          </div>
          <TextInput
            testId="agenda-rework-reason"
            label={t("views.agenda.reworkReason")}
            value={reason}
            onChange={setReason}
          />
          <Button
            testId="agenda-rework"
            disabled={!reason.trim() || !rework.data?.reworkTargets[0] || mutation?.state === "pending"}
            onClick={() => void actions.reworkTask(task, { ...rework.data!.reworkTargets[0], reason: reason.trim() })}
          >
            {t("views.agenda.reworkDispatch")}
          </Button>
          {rework.isError && (
            <p role="alert" className="break-words ui-meta text-danger">
              {rework.error.message}
            </p>
          )}
        </>
      )}
      {done && task.packageDisposition === "active" && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              testId="agenda-archive"
              variant="primary"
              loading={busy}
              onClick={() => void archive([task.taskId])}
            >
              {t("views.agenda.receiveDelivery")}
            </Button>
            {batch.length >= 2 && (
              <Button
                testId="agenda-archive-work"
                disabled={busy}
                onClick={() => void archive(batch.map((row) => row.taskId))}
              >
                {t("views.agenda.receiveWork", { count: batch.length })}
              </Button>
            )}
          </div>
          <TextInput
            testId="agenda-followup-title"
            label={t("views.agenda.followupTitle")}
            value={title}
            onChange={setTitle}
            disabled={busy || Boolean(created)}
          />
          <Button
            testId="agenda-followup"
            disabled={!title.trim() || !plan || Boolean(created)}
            loading={busy}
            onClick={() => void create()}
          >
            {t("views.agenda.createFollowup")}
          </Button>
          {catalog.isError && (
            <p role="alert" className="ui-meta text-danger">
              {catalog.error.message}
            </p>
          )}
          {preset.isError && (
            <p role="alert" className="ui-meta text-danger">
              {preset.error.message}
            </p>
          )}
          {created && <EntityRefLink entityRef={`task/${created}`} onNavigate={onNavigateEntity} />}
        </>
      )}
      {(feedback || mutation) && (
        <p role="status" className="break-words ui-meta">
          {feedback ?? mutation?.hint}
        </p>
      )}
    </section>
  );
}
