import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { harnessClient } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import type { TaskRow } from "../../model/types.ts";
import { formatTime } from "../../model/time.ts";
import { settleTaskReceipt } from "../../task-actions.ts";
import { taskQueryKeys } from "../../task-data.ts";
import { INPUT } from "../identityAccess/AccessParts.tsx";
import { Button } from "../primitives/Button.tsx";
import { IdText } from "../IdText.tsx";

export function TaskAssignmentPanel({ task }: { readonly task: TaskRow }) {
  const directory = useQuery({
      queryKey: ["task-assignment-directory", task.projectId, task.taskId],
      queryFn: () => harnessClient.getTaskAssignmentDirectory({ repoId: task.projectId, taskId: task.taskId }),
      retry: false,
    }),
    queryClient = useQueryClient(),
    [kind, setKind] = useState("person"),
    [target, setTarget] = useState(""),
    [expiry, setExpiry] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null),
    [submittedRevision, setSubmittedRevision] = useState<number | null>(null),
    disabled = busy || task.revision === undefined || submittedRevision === task.revision,
    assignment = task.assignment,
    assignee = assignment?.assignee,
    choices =
      kind === "node"
        ? directory.data?.nodes.map((node) => ({ id: node.nodeId, label: `${node.nodeId} · ${node.personId}` }))
        : kind === "team"
          ? directory.data?.teams.map((team) => ({ id: team.id, label: team.name }))
          : directory.data?.people.map((person) => ({ id: person.personId, label: person.username }));

  async function save(remove: boolean) {
    if (disabled || task.revision === undefined) return;
    setBusy(true);
    setMessage(null);
    try {
      const expectedVersion = task.revision,
        scope = { repoId: task.projectId, taskId: task.taskId, expectedVersion },
        receipt = await (remove
          ? harnessClient.unassignTask(scope)
          : harnessClient.assignTask({
              ...scope,
              ...(kind === "node" ? { nodeId: target } : kind === "team" ? { teamId: target } : { personId: target }),
              ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : {}),
            })),
        settlement = settleTaskReceipt(receipt);
      if (settlement.state !== "op_rejected") setSubmittedRevision(expectedVersion);
      setMessage(settlement.state === "applied" ? t("taskAssignment.saved") : `${settlement.code}: ${settlement.hint}`);
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.all(task.projectId), refetchType: "active" });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section data-testid="task-assignment-panel" className="grid gap-3 border-b border-border p-3">
      <h3 className="font-semibold">{t("taskAssignment.title")}</h3>
      <p className="ui-meta text-text-muted">{t("taskAssignment.rule")}</p>
      <div className="flex flex-wrap items-center gap-2" data-testid="task-assignment-current">
        {assignee ? (
          <>
            <span>
              {t(`taskAssignment.${assignee.kind === "team" ? "team" : assignee.nodeId ? "node" : "person"}`)}
            </span>
            <IdText value={assignee.kind === "team" ? assignee.teamId : (assignee.nodeId ?? assignee.personId)} />
            <span>{formatTime(assignment!.expiresAt, { style: "month-day-time" })}</span>
          </>
        ) : (
          t("taskAssignment.none")
        )}
      </div>
      {directory.error && <p role="alert">{directory.error.message}</p>}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save(false);
        }}
      >
        <label className="grid min-w-0 gap-1 ui-meta">
          {t("taskAssignment.kind")}
          <select
            className={INPUT}
            data-testid="task-assignment-kind"
            value={kind}
            disabled={disabled}
            onChange={(event) => {
              setKind(event.currentTarget.value);
              setTarget("");
            }}
          >
            {(["person", "node", "team"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`taskAssignment.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 flex-1 gap-1 ui-meta">
          {t("taskAssignment.target")}
          <select
            className={`${INPUT} w-full`}
            data-testid="task-assignment-target"
            value={target}
            disabled={disabled || !choices}
            onChange={(event) => setTarget(event.currentTarget.value)}
          >
            <option value="">{t(choices ? "taskAssignment.choose" : "taskAssignment.loading")}</option>
            {choices?.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-1 ui-meta">
          {t("taskAssignment.expiry")}
          <input
            type="datetime-local"
            className={INPUT}
            data-testid="task-assignment-expiry"
            value={expiry}
            disabled={disabled}
            onChange={(event) => setExpiry(event.currentTarget.value)}
          />
        </label>
        <Button
          type="submit"
          testId="task-assignment-save"
          disabled={disabled || !target || !choices?.some((choice) => choice.id === target)}
        >
          {t("taskAssignment.save")}
        </Button>
        <Button testId="task-assignment-remove" disabled={disabled || !assignment} onClick={() => void save(true)}>
          {t("taskAssignment.remove")}
        </Button>
      </form>
      <p className="ui-meta text-text-muted">{t("taskAssignment.defaultExpiry")}</p>
      {message && (
        <p role="status" data-testid="task-assignment-feedback" className="ui-meta">
          {message}
        </p>
      )}
    </section>
  );
}
