import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentPlan, type PlanStep, type PlanStepStatus } from "../agent-ui/AgentPlan.tsx";
import { AgentSteering, type SteerNote } from "../agent-ui/AgentSteering.tsx";
import { pollSessionEventsOnce, runtimeQueryKeys } from "../../agent-runtime-client.ts";
import { runtimeCommandClient } from "../../runtime-command-client.ts";
import { resumeRuntimeSpawnInput } from "../../runtime-control.ts";
import { dispatchRole } from "../../model/lineage-tree.ts";
import { harnessClient } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import type { TaskRow } from "../../model/types.ts";
import type { TaskDispatchProjectionRow } from "../../../api/renderer-dto.ts";

/**
 * 执行与干预面板(dec_C0AF8CBBFFECF71F4F34FB76F9 CH4/W3-T1):任务详情派工页签的步骤级
 * 执行视图。派工轮次即步骤(AgentPlan):每轮实时计时、失败步「从此步重试」(resume 派工,
 * 走 runtime spawn 通道);运行中可插话(AgentSteering):追加指令经 repo.agentRuntime.steer
 * 写进正在运行的 provider 会话——daemon 在安全点吸收并续跑,回执 command-receipt/v2 是
 * 唯一成功信号;会话推进(出现新生命周期事件)后纸条滑入对应轮次步骤卡(FLIP)。立即中断
 * 走 repo.agentRuntime.cancel。没有本地假成功:写失败纸条留在队列并显示错误,可撤回重试。
 */

/** 派工行状态 → 步骤状态词(词表归 AgentPlan;非终态的 unknown/lost/blocked 归 pending)。 */
function stepStatusOf(status: TaskDispatchProjectionRow["status"]): PlanStepStatus {
  switch (status) {
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
    case "stopped":
      return "skipped";
    default:
      return "pending";
  }
}

/** 追加回执侧写:纸条本体保持 SteerNote(原语契约),送达与错误记在旁边。 */
interface SteerNoteState extends SteerNote {
  /** steer 回执 ok 后置位:会话出现该时刻之后的首个生命周期事件即转 absorbed。 */
  readonly deliveredAt: number | null;
  readonly error: string | null;
}

const epochMs = (iso: string | null | undefined): number | null => {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

export function TaskExecutionPanel({ task }: { readonly task: TaskRow }) {
  // 与派工链同族读键:两个面板共享一次读与缓存,台账 cut 的扇出失效一并刷新。
  const dispatches = useQuery({
    queryKey: runtimeQueryKeys.dispatches(task.projectId, task.taskId),
    queryFn: () => harnessClient.getTaskDispatches({ repoId: task.projectId, taskId: task.taskId }),
    staleTime: 4_000,
    refetchInterval: (query) =>
      (query.state.data?.dispatches ?? []).some((row) => row.status === "running") ? 4_000 : false,
  });
  const rows = useMemo(
    () =>
      (dispatches.data?.dispatches ?? []).slice().sort((left, right) => {
        const byAttempt = left.attemptIndex - right.attemptIndex;
        if (byAttempt !== 0) return byAttempt;
        const byStarted = (epochMs(left.startedAt) ?? 0) - (epochMs(right.startedAt) ?? 0);
        return byStarted !== 0 ? byStarted : left.dispatchId.localeCompare(right.dispatchId);
      }),
    [dispatches.data],
  );
  const runningRow = useMemo(() => [...rows].reverse().find((row) => row.status === "running") ?? null, [rows]);

  // 运行中会话的生命周期事件:走 W1-T1 的增量同步唯一入口(共享 runtime-session-events
  // 缓存与游标),纸条吸收判据只看合并后的事件时间线。
  const queryClient = useQueryClient();
  const events = useQuery({
    queryKey: runtimeQueryKeys.events(task.projectId, runningRow?.runtimeSessionId ?? "none"),
    queryFn: () => pollSessionEventsOnce(queryClient, task.projectId, runningRow!.runtimeSessionId),
    enabled: runningRow !== null,
    staleTime: 4_000,
    refetchInterval: runningRow !== null ? 4_000 : false,
  });

  const [notes, setNotes] = useState<readonly SteerNoteState[]>([]);
  const [feedback, setFeedback] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /** 最近一次送达时刻:送达落地(deliveredAt 置位)时复查吸收,不必等下一轮事件刷新。 */
  const latestDeliveredAt = Math.max(0, ...notes.map((note) => note.deliveredAt ?? 0));
  useEffect(() => {
    if (runningRow === null || events.data === undefined) return;
    const advancedPast = Math.max(0, ...events.data.events.map((event) => epochMs(event.occurredAt) ?? 0));
    setNotes((current) =>
      current.map((note) =>
        note.state === "queued" &&
        note.deliveredAt !== null &&
        advancedPast > note.deliveredAt &&
        note.targetStepId === runningRow.dispatchId
          ? { ...note, state: "absorbed" }
          : note,
      ),
    );
    // notes 的更新走 setNotes 函数式写,只有「有无新送达」这一派生值需要进依赖。
  }, [events.data, runningRow, latestDeliveredAt]);

  const steps: readonly PlanStep[] = useMemo(
    () =>
      rows.map((row, index) => ({
        id: row.dispatchId,
        title: t("views.execution.roundTitle", { index: index + 1, role: dispatchRole(row) }),
        status: stepStatusOf(row.status),
        ...(epochMs(row.startedAt) !== null ? { startedAt: epochMs(row.startedAt)! } : {}),
        ...(epochMs(row.endedAt) !== null ? { endedAt: epochMs(row.endedAt)! } : {}),
        steerNotes: notes.filter((note) => note.state === "absorbed" && note.targetStepId === row.dispatchId),
      })),
    [rows, notes],
  );

  async function runOperation(labelOk: string, operation: () => Promise<unknown>) {
    setBusy(true);
    setFeedback(null);
    // 双回调显式把失败投影成 error feedback:不回退成成功、不吞异常,也不新增 catch 兜底点
    // (no-swallowed-failure 只认「显式失败投影」与 rethrow 两种写法)。
    await operation().then(
      () => setFeedback({ ok: true, text: labelOk }),
      (error: unknown) =>
        setFeedback({
          ok: false,
          text: t("views.execution.opFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        }),
    );
    setBusy(false);
  }

  const enqueue = (text: string) => {
    if (runningRow === null) return;
    const noteId = crypto.randomUUID(),
      createdAt = Date.now();
    setNotes((current) => [
      ...current,
      {
        id: noteId,
        text,
        targetStepId: runningRow.dispatchId,
        createdAt,
        state: "queued",
        deliveredAt: null,
        error: null,
      },
    ]);
    // steer 的失败走纸条自身的 error 字段(不进全局 feedback):纸条留在队列、显示真实错误、可撤回重试。
    setBusy(true);
    runtimeCommandClient
      .steer(task.projectId, { runtimeSessionId: runningRow.runtimeSessionId, prompt: text })
      .then(() => {
        setNotes((current) =>
          current.map((note) => (note.id === noteId ? { ...note, deliveredAt: Date.now(), error: null } : note)),
        );
      })
      .catch((error: unknown) => {
        setNotes((current) =>
          current.map((note) =>
            note.id === noteId ? { ...note, error: error instanceof Error ? error.message : String(error) } : note,
          ),
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <section data-testid="task-execution-panel" className="grid gap-3 border-b border-border p-3">
      <h3 className="font-semibold">{t("views.execution.title")}</h3>
      <p className="m-0 ui-meta text-text-muted">{t("views.execution.note")}</p>
      {dispatches.isPending ? (
        <p className="m-0 animate-pulse ui-meta text-text-faint">{t("views.execution.reading")}</p>
      ) : dispatches.isError ? (
        <p role="alert" className="m-0 ui-meta leading-5 text-danger">
          {t("views.execution.readError", { message: dispatches.error.message })}
        </p>
      ) : steps.length === 0 ? (
        <p className="m-0 ui-meta text-text-faint">{t("views.execution.empty")}</p>
      ) : (
        <AgentPlan
          steps={steps}
          phase="running"
          onRetryFromStep={(dispatchId) =>
            void runOperation(t("views.execution.retryDispatched"), () =>
              runtimeCommandClient.spawn(
                task.projectId,
                resumeRuntimeSpawnInput(dispatchId, `gui-retry-${crypto.randomUUID()}`),
              ),
            )
          }
          layoutGroupId={`task-execution-${task.taskId}`}
          testId="task-execution-plan"
        />
      )}
      {runningRow !== null && (
        <AgentSteering
          notes={notes}
          running={runningRow !== null && !busy}
          onEnqueue={enqueue}
          onWithdraw={(noteId) => setNotes((current) => current.filter((note) => note.id !== noteId))}
          onInterrupt={() =>
            void runOperation(t("views.execution.interrupted"), () =>
              runtimeCommandClient.cancel(task.projectId, runningRow.runtimeSessionId),
            )
          }
          layoutGroupId={`task-execution-${task.taskId}`}
          testId="task-execution-steering"
        />
      )}
      {feedback !== null && (
        <p
          role="status"
          data-testid="task-execution-feedback"
          className={`m-0 ui-meta ${feedback.ok ? "text-text-muted" : "text-danger"}`}
        >
          {feedback.text}
        </p>
      )}
      {notes.some((note) => note.error !== null) && (
        <ul className="m-0 grid gap-1" data-testid="task-execution-note-errors">
          {notes
            .filter((note) => note.error !== null)
            .map((note) => (
              <li key={note.id} className="ui-micro leading-5 text-danger">
                {t("views.execution.noteError", { text: note.text, message: note.error! })}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
