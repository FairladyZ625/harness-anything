import { useCallback, useState } from "react";
import type { TaskRow } from "../../model/types.ts";
import type { useTaskActions } from "../../task-actions.ts";
import { useTaskDeliveryDiffQuery } from "../../task-data.ts";
import { TaskReturnDialog } from "./TaskReturnDialog.tsx";

type ReturnIntent = {
  readonly task: TaskRow;
  readonly reviewId?: string;
  readonly repoId: string;
  readonly initialFeedback?: string;
};
type AdjudicateAction = ReturnType<typeof useTaskActions>["adjudicateTask"];
type ReturnDialogProps = Parameters<typeof TaskReturnDialog>[0];

/** Owns the selected task, its delivery diff, and the shared return prompt lifecycle. */
export function useTaskReturnWorkflow(repoId: string, adjudicate: AdjudicateAction) {
  const [intent, setIntent] = useState<ReturnIntent | null>(null);
  const diff = useTaskDeliveryDiffQuery(repoId, intent?.task.taskId ?? null);

  const adjudicateTask = useCallback(
    async (task: TaskRow, decision: "forward" | "return", reason: string, reviewId?: string) => {
      if (decision === "return") {
        setIntent({ task, reviewId, repoId });
        return;
      }
      await adjudicate(task, decision, reason, reviewId);
    },
    [adjudicate, repoId],
  );
  const openTaskReturnWithNote = useCallback(
    async (task: TaskRow, reason: string, reviewId?: string) => {
      setIntent({ task, reviewId, repoId, initialFeedback: reason });
    },
    [repoId],
  );

  const dialogProps: ReturnDialogProps = {
    open: intent?.repoId === repoId,
    diffFiles: diff.data?.files,
    initialFeedback: intent?.initialFeedback,
    onClose: () => setIntent(null),
    onReturn: (mode, feedback) => {
      if (intent === null) return;
      void adjudicate(intent.task, "return", feedback, intent.reviewId, mode);
      setIntent(null);
    },
  };

  return { adjudicateTask, openTaskReturnWithNote, dialogProps };
}
