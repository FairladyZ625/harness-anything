import { guiInteractionPolicy } from "../../../api/renderer-dto.ts";
import { daemonBridgeError } from "../../daemon-startup.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../../api-client-invoke.ts";
import { readGuiActionResult } from "../../command-receipt.ts";
import { taskReworkClient } from "../../task-rework-client.ts";
import { taskQueryKeys } from "../../task-data.ts";
import { localErrorHint } from "../../result-validation.ts";
import { t } from "../../i18n/index.tsx";
import { Button } from "../primitives/Button.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";

/** Availability is the server's Ontology/RBAC projection; the write independently reauthorizes. */
export function TaskMaterializationControl({ repoId, taskId }: { readonly repoId: string; readonly taskId: string }) {
  const cache = useQueryClient(),
    read = useQuery({
      queryKey: taskQueryKeys.rework(repoId, taskId),
      queryFn: () => taskReworkClient.read(repoId, taskId),
      retry: guiInteractionPolicy.defaultValue.retry,
    }),
    state = read.data?.materializationState,
    missing = state === "skipped_by_node_policy" || state === "dematerialized_terminal",
    availability = useQuery({
      queryKey: ["entity-actions", repoId, taskId],
      queryFn: async () => {
        const result = await invoke(
          "repo.entity.actions.explain",
          {
            repoId,
            schema: "entity-action-explain-request/v1",
            mode: "object",
            entityKind: null,
            refs: [`task/${taskId}`],
          },
          "explainEntityActions",
        );
        if (!("subjects" in result)) throw daemonBridgeError(result, "Task action availability failed.");
        return result;
      },
      enabled: missing,
      retry: guiInteractionPolicy.defaultValue.retry,
    }),
    action = availability.data?.subjects[0]?.actions.find(({ action }) => action.id === "materialize"),
    materialize = useMutation({
      mutationFn: async () => {
        const request = { repoId, taskId },
          receipt = readGuiActionResult(await invoke("repo.task.materialize", request, "materializeTask"));
        if (!receipt.ok) throw new Error(localErrorHint(receipt, "Task materialization failed."));
        return receipt;
      },
      onSuccess: async () => {
        await cache.invalidateQueries({ queryKey: ["tasks", repoId, taskId] });
      },
    });
  if (!missing) return null;
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="task-materialization-control">
      <StatusTag tone="neutral" label={t(`views.taskDetailView.${state}`)} />
      <Button
        testId="task-materialize"
        disabled={action?.available !== true || materialize.isPending}
        tip={action?.nextActions.join("\n")}
        onClick={() => materialize.mutate()}
      >
        {t(materialize.isPending ? "views.taskDetailView.materializing" : "views.taskDetailView.materialize")}
      </Button>
      {(materialize.error || availability.error) && (
        <span role="alert">{(materialize.error || availability.error)?.message}</span>
      )}
    </span>
  );
}
