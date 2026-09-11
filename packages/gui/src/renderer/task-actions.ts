import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { GuiActionResult } from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";
import type { TaskRow } from "./model/types.ts";
import { taskQueryKeys } from "./task-data.ts";

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
  };
};

export interface TaskSettlement {
  readonly state: "applied" | "pending" | "op_rejected";
  readonly opId: string;
  readonly code?: string;
  readonly hint?: string;
  readonly receipt: GuiActionResult;
}

// The write receipt is the settlement input: durable acceptance plus projection visibility is applied.
// Git and worktree follower progress stays display-only; the ledger poll carries later cuts.
export function settleTaskReceipt(initial: GuiActionResult): TaskSettlement {
  const receipt = initial as ReceiptRecord,
    proof = receipt.proof;
  if (
    receipt.outcome === "applied" &&
    proof?.durable === true &&
    proof.canonicalVisible === true &&
    proof.committedRevision === proof.appliedCut
  ) {
    return {
      state: "applied",
      opId: receipt.opId,
      receipt,
    };
  }
  if (receipt.outcome === "pending" || receipt.outcome === "indeterminate" || receipt.outcome === "applied") {
    return {
      state: "pending",
      opId: receipt.opId,
      code: receipt.outcome === "applied" ? "canonical_not_visible" : (receipt.code ?? receipt.outcome),
      hint: receipt.nextAction ?? "用 opId 查询 canonical receipt；不要重放 mutation。",
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

export function createGuiExecutionId(randomUUID: () => string = () => crypto.randomUUID()): string {
  return `execution-gui-${randomUUID()}`;
}

export interface TaskMutationFeedback {
  readonly state: "pending" | "success" | "error";
  readonly kind: "start" | "progress" | "submit" | "pin";
  readonly opId: string;
  readonly code?: string;
  readonly hint: string;
}

/**
 * 回执已 applied、只是「canonical 可见」还没到位。这种落定里写入已经不在飞,
 * in-flight 锁必须放开;它与 pending/indeterminate(归属未知)不是一回事。
 */
const settledButInvisible: ReadonlySet<string> = new Set(["canonical_not_visible"]);

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
  // 动作回调引用稳定(W9):它们顺着看板/列表传到每张卡片,memo 的比较键里
  // 不能有每次渲染都换的函数引用。依赖只有 repoId 与 queryClient(稳定)。
  const publish = useCallback(
    (taskId: string, value: TaskMutationFeedback): TaskMutationFeedback => {
      if (activeRepoId.current === repoId)
        setFeedbackState((current) => ({
          repoId,
          values: new Map(current.repoId === repoId ? current.values : []).set(taskId, value),
        }));
      return value;
    },
    [repoId],
  );
  const reread = useCallback(
    async (
      taskId: string,
      kind: TaskMutationFeedback["kind"],
      settlement: TaskSettlement,
    ): Promise<TaskMutationFeedback> => {
      if (settlement.state !== "applied")
        return publish(taskId, {
          state: settlement.state === "op_rejected" ? "error" : "pending",
          kind,
          opId: settlement.opId,
          code: settlement.code,
          hint: settlement.hint ?? "canonical receipt 尚未 settled；不要重放 mutation。",
        });
      // 回执本身就是落定证明(durable + canonicalVisible + committedRevision===appliedCut):
      // 只失效任务切面,新行状态由挂载中的台账探针正常 refetch 带上来,不强制整表重读。
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.all(repoId), refetchType: "active" });
      return publish(taskId, {
        state: "success",
        kind,
        opId: settlement.opId,
        hint: "canonical receipt 已确认落定。",
      });
    },
    [repoId, queryClient, publish],
  );
  const once = useCallback(
    (key: string, taskId: string, run: () => Promise<TaskMutationFeedback>): Promise<TaskMutationFeedback> => {
      const lockKey = `${repoId}:${key}`,
        held = locks.current.get(lockKey);
      if (held) return held;
      const promise = run().then(
        (result) => {
          // 锁只挡「这次写入还在飞」。回执本身已 applied、只差可见性追平的那两种落定
          // 不是在飞写入:继续挡住会把控件永久锁死——实测 pin 一次(回执
          // canonical_not_visible)之后 unpin 再也发不出去。真正归属未知的回执
          // (pending/indeterminate)照旧挡住,start 那条会另铸 executionId,不得重放。
          if (result.state !== "pending" || (result.code !== undefined && settledButInvisible.has(result.code)))
            locks.current.delete(lockKey);
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
    },
    [repoId, publish],
  );
  const startTask = useCallback(
    (task: TaskRow): Promise<TaskMutationFeedback> =>
      once(`start:${task.taskId}`, task.taskId, async () => {
        const executionId = createGuiExecutionId();
        publish(task.taskId, {
          state: "pending",
          kind: "start",
          opId: "awaiting-receipt",
          hint: `正在申请 lease · ${executionId}`,
        });
        const settlement = settleTaskReceipt(
          await harnessClient.startTask({ repoId, taskId: task.taskId, executionId }),
        );
        return reread(task.taskId, "start", settlement);
      }),
    [once, reread],
  );
  const appendProgress = useCallback(
    (
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
        const settlement = settleTaskReceipt(
          await harnessClient.appendTaskProgress({
            repoId,
            taskId: task.taskId,
            executionId: task.activeExecutionId,
            ...input,
          }),
        );
        return reread(task.taskId, "progress", settlement);
      }),
    [once, reread],
  );
  const submitTask = useCallback(
    (task: TaskRow): Promise<TaskMutationFeedback> =>
      once(`submit:${task.taskId}`, task.taskId, async () => {
        publish(task.taskId, {
          state: "pending",
          kind: "submit",
          opId: "awaiting-receipt",
          hint: "正在从 closeout.md 提交评审…",
        });
        const settlement = settleTaskReceipt(
          await harnessClient.submitTask({
            repoId,
            taskId: task.taskId,
            executionId: task.activeExecutionId,
          }),
        );
        return reread(task.taskId, "submit", settlement);
      }),
    [once, reread],
  );
  // 台账 pin 的 GUI 写通道:与 `ha task pin/unpin` 完全同一条 daemon 动作
  // (pinned-only `task-amend`),不另造写路。pinned 与 coordinationStatus 正交,
  // 所以可见性判据只看 `snapshot.task.pinned` 这一件事。
  const setTaskPin = useCallback(
    (task: Pick<TaskRow, "taskId">, pinned: boolean): Promise<TaskMutationFeedback> =>
      once(`pin:${task.taskId}`, task.taskId, async () => {
        publish(task.taskId, {
          state: "pending",
          kind: "pin",
          opId: "awaiting-receipt",
          hint: pinned ? "正在 pin(今天当前在做)…" : "正在解除 pin…",
        });
        const settlement = settleTaskReceipt(
          await (pinned ? harnessClient.pinTask : harnessClient.unpinTask)({ repoId, taskId: task.taskId }),
        );
        return reread(task.taskId, "pin", settlement);
      }),
    [once, reread],
  );
  return { feedback, startTask, appendProgress, submitTask, setTaskPin };
}
