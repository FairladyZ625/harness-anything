import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { GuiActionResult } from "../api/renderer-dto.ts";
import type { GuiSubmissionV1 } from "../api/renderer-dto.ts";
import { harnessClient, type TaskListSuccess } from "./api-client.ts";
import type { TaskRow } from "./model/types.ts";
import { readTaskList, taskQueryKeys } from "./task-data.ts";

type ReceiptRecord = GuiActionResult & {
  readonly revision?: number;
  readonly code?: string;
  readonly nextAction?: string;
  readonly error?: { readonly code?: string; readonly hint?: string };
  readonly proof?: {
    readonly committedRevision?: number;
    readonly appliedCut?: number;
    readonly durable?: boolean;
    readonly canonicalVisible?: boolean;
    readonly worktreeVisible?: boolean | null;
  };
};

export interface TaskSettlement {
  readonly state: "applied" | "pending" | "op_rejected";
  readonly opId: string;
  readonly code?: string;
  readonly hint?: string;
  readonly revision?: number;
  readonly receipt: GuiActionResult;
}

export async function settleTaskReceipt(
  initial: GuiActionResult,
  showReceipt: (payload: { readonly opId: string }) => Promise<GuiActionResult>,
): Promise<TaskSettlement> {
  let receipt = initial as ReceiptRecord;
  if ((receipt.outcome === "pending" || receipt.outcome === "indeterminate") && receipt.opId !== "N/A") {
    receipt = (await showReceipt({ opId: receipt.opId })) as ReceiptRecord;
  }
  const proof = receipt.proof;
  if (
    receipt.outcome === "applied" &&
    proof?.durable === true &&
    proof.canonicalVisible === true &&
    proof.worktreeVisible === true &&
    proof.committedRevision === proof.appliedCut
  ) {
    return {
      state: "applied",
      opId: receipt.opId,
      ...(Number.isInteger(receipt.revision) ? { revision: receipt.revision } : {}),
      receipt,
    };
  }
  if (receipt.outcome === "pending" || receipt.outcome === "indeterminate" || receipt.outcome === "applied") {
    return {
      state: "pending",
      opId: receipt.opId,
      code: receipt.outcome === "applied" ? "canonical_not_visible" : (receipt.code ?? receipt.outcome),
      hint: receipt.nextAction ?? "用 opId 查询 canonical receipt；不要重放 mutation。",
      ...(Number.isInteger(receipt.revision) ? { revision: receipt.revision } : {}),
      receipt,
    };
  }
  return {
    state: "op_rejected",
    opId: receipt.opId,
    code: receipt.error?.code ?? receipt.code ?? "write_rejected",
    hint: receipt.error?.hint ?? receipt.nextAction ?? "Inspect the canonical rejection.",
    receipt,
  };
}

export function isTaskStartable(task: TaskRow): boolean {
  return (
    task.origin === "native" &&
    /* @gate-identity check-gui-status-judgments/gui-status-044 */
    task.packageDisposition === "active" &&
    /* @gate-identity check-gui-status-judgments/gui-status-045 */
    task.canonicalStatus === "planned" &&
    /* @gate-identity check-gui-status-judgments/gui-status-046 */
    task.blocking === "clear"
  );
}

export function createGuiExecutionId(randomUUID: () => string = () => crypto.randomUUID()): string {
  return `execution-gui-${randomUUID()}`;
}

export interface TaskMutationFeedback {
  readonly state: "pending" | "success" | "error";
  readonly kind: "start" | "progress" | "submit";
  readonly opId: string;
  readonly code?: string;
  readonly hint: string;
}

export function useTaskActions(repoId: string) {
  const queryClient = useQueryClient(),
    locks = useRef(new Map<string, Promise<TaskMutationFeedback>>());
  const activeRepoId = useRef(repoId),
    emptyFeedback = useRef<ReadonlyMap<string, TaskMutationFeedback>>(new Map()).current;
  activeRepoId.current = repoId;
  const [feedbackState, setFeedbackState] = useState<{
    readonly repoId: string;
    readonly values: ReadonlyMap<string, TaskMutationFeedback>;
  }>({ repoId, values: new Map() });
  const feedback = feedbackState.repoId === repoId ? feedbackState.values : emptyFeedback;
  const publish = (taskId: string, value: TaskMutationFeedback): TaskMutationFeedback => {
    if (activeRepoId.current === repoId)
      setFeedbackState((current) => ({
        repoId,
        values: new Map(current.repoId === repoId ? current.values : []).set(taskId, value),
      }));
    return value;
  };
  const reread = async (
    taskId: string,
    kind: TaskMutationFeedback["kind"],
    settlement: TaskSettlement,
    visible: (data: TaskListSuccess) => boolean,
  ): Promise<TaskMutationFeedback> => {
    if (settlement.state !== "applied")
      return publish(taskId, {
        state: settlement.state === "op_rejected" ? "error" : "pending",
        kind,
        opId: settlement.opId,
        code: settlement.code,
        hint: settlement.hint ?? "canonical receipt 尚未 settled；不要重放 mutation。",
      });
    const queryKey = taskQueryKeys.list(repoId),
      previous = queryClient.getQueryData<TaskListSuccess>(queryKey);
    const data = await queryClient.fetchQuery({
      queryKey,
      queryFn: () => readTaskList(repoId, previous),
      staleTime: 0,
    });
    const revisionVisible = settlement.revision === undefined || data.watermark >= settlement.revision;
    return revisionVisible && visible(data)
      ? publish(taskId, { state: "success", kind, opId: settlement.opId, hint: "canonical projection 已重读并确认。" })
      : publish(taskId, {
          state: "pending",
          kind,
          opId: settlement.opId,
          code: "projection_not_visible",
          hint: "receipt 已 applied，但 task projection 尚未显示目标 cut；用 opId 继续查询，勿重放 mutation。",
        });
  };
  const once = (
    key: string,
    taskId: string,
    run: () => Promise<TaskMutationFeedback>,
  ): Promise<TaskMutationFeedback> => {
    const lockKey = `${repoId}:${key}`,
      held = locks.current.get(lockKey);
    if (held) return held;
    const promise = run().then(
      (result) => {
        if (result.state !== "pending") locks.current.delete(lockKey);
        return result;
      },
      (error) => {
        locks.current.delete(lockKey);
        return publish(taskId, {
          state: "error",
          kind: key.split(":")[0] as TaskMutationFeedback["kind"],
          opId: "N/A",
          code: "bridge_error",
          hint: error instanceof Error ? error.message : String(error),
        });
      },
    );
    locks.current.set(lockKey, promise);
    return promise;
  };
  const startTask = (task: TaskRow): Promise<TaskMutationFeedback> =>
    once(`start:${task.taskId}`, task.taskId, async () => {
      const executionId = createGuiExecutionId();
      publish(task.taskId, {
        state: "pending",
        kind: "start",
        opId: "awaiting-receipt",
        hint: `正在申请 lease · ${executionId}`,
      });
      const settlement = await settleTaskReceipt(
        await harnessClient.startTask({ repoId, taskId: task.taskId, executionId }),
        ({ opId }) => harnessClient.showReceipt({ repoId, opId }),
      );
      return reread(task.taskId, "start", settlement, (data) =>
        data.rows.some(
          (row) =>
            row.taskId === task.taskId &&
            /* @gate-identity check-gui-status-judgments/gui-status-047 */
            row.snapshot.task?.status === "active" &&
            row.snapshot.lease?.executionId === executionId,
        ),
      );
    });
  const appendProgress = (
    task: TaskRow,
    input: {
      readonly text: string;
      readonly evidence: ReadonlyArray<{ readonly type: string; readonly path: string; readonly summary: string }>;
    },
  ): Promise<TaskMutationFeedback> =>
    once(`progress:${task.taskId}`, task.taskId, async () => {
      publish(task.taskId, {
        state: "pending",
        kind: "progress",
        opId: "awaiting-receipt",
        hint: "正在追加 typed progress…",
      });
      const settlement = await settleTaskReceipt(
        await harnessClient.appendTaskProgress({
          repoId,
          taskId: task.taskId,
          executionId: task.activeExecutionId,
          ...input,
        }),
        ({ opId }) => harnessClient.showReceipt({ repoId, opId }),
      );
      return reread(task.taskId, "progress", settlement, (data) =>
        data.rows.some(
          (row) =>
            row.taskId === task.taskId &&
            /* @gate-identity check-gui-status-judgments/gui-status-048 */
            row.snapshot.task?.status === "active" &&
            row.snapshot.lease?.executionId === task.activeExecutionId,
        ),
      );
    });
  const submitTask = (task: TaskRow, submission: GuiSubmissionV1): Promise<TaskMutationFeedback> =>
    once(`submit:${task.taskId}`, task.taskId, async () => {
      publish(task.taskId, {
        state: "pending",
        kind: "submit",
        opId: "awaiting-receipt",
        hint: "正在原子提交 SubmissionV1…",
      });
      const settlement = await settleTaskReceipt(
        await harnessClient.submitTask({
          repoId,
          taskId: task.taskId,
          executionId: task.activeExecutionId ?? "",
          submission,
        }),
        ({ opId }) => harnessClient.showReceipt({ repoId, opId }),
      );
      return reread(task.taskId, "submit", settlement, (data) =>
        data.rows.some(
          (row) =>
            row.taskId === task.taskId &&
            /* @gate-identity check-gui-status-judgments/gui-status-049 */
            row.snapshot.task?.status === "in_review" &&
            row.snapshot.lease === null,
        ),
      );
    });
  return { feedback, startTask, appendProgress, submitTask };
}
