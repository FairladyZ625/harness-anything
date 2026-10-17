import { useQuery } from "@tanstack/react-query";
import type { AgentRuntimeSessionGroupsResult } from "@harness-anything/daemon/protocol";
import { agentRuntimeClient, runtimeQueryKeys } from "../../agent-runtime-client.ts";
import type { TaskSnapshotProjectionRow } from "../../../api/renderer-dto.ts";

/**
 * 「重构 › 今天」页自持的读面(dec_C612E69B7C7E3480A5F9D2CAD3):议程由 App 常驻
 * 挂载、经 props 进来;正在跑读会话组,刚交付读 App 常驻任务投影,不建第二份读路。
 */

/** 正在跑:repo 级会话组读面(groupBy=task,无成员级筛选;daemon 保证 live 会话不被 since 切掉)。 */
export function useTodaySessionGroups(repoId: string | null) {
  return useQuery({
    queryKey: [...runtimeQueryKeys.sessionGroupsAll(repoId ?? "unselected"), "today", "task"],
    queryFn: (): Promise<AgentRuntimeSessionGroupsResult> =>
      agentRuntimeClient.sessionGroups(repoId ?? "unselected", { groupBy: "task" }),
    enabled: repoId !== null,
    staleTime: 4_000,
    retry: 1,
  });
}

/** 刚交付行:任务投影的权威完成时间(事件窗口可能已被大量非完成事件挤出)。 */
export interface DeliveredRow {
  readonly key: string;
  readonly taskId: string;
  readonly at: string;
  readonly title: string;
  readonly summary: string | null;
}

function deliverySummary(row: TaskSnapshotProjectionRow): string {
  const executions = [...(row.snapshot.executions ?? [])].sort((left, right) => right.iteration - left.iteration);
  for (const execution of executions) {
    const archived = "archivedSubmission" in execution,
      submission = archived ? execution.archivedSubmission : execution.submission;
    if (submission === null || submission === undefined) continue;
    const claim = typeof submission.completionClaim === "string" ? submission.completionClaim.trim() : "";
    if (claim.length > 0) return claim;
    const deliverable = submission.deliverables?.find((value) => typeof value === "string" && value.trim().length > 0);
    if (deliverable !== undefined) return deliverable.trim();
    const output = archived
      ? undefined
      : execution.submission?.outputs.find((value) => typeof value === "string" && value.trim().length > 0);
    if (output !== undefined) return output.trim();
  }
  return row.snapshot.task?.title ?? row.taskId;
}

export function deliveredRows(rows: readonly TaskSnapshotProjectionRow[], now = Date.now()): readonly DeliveredRow[] {
  const since = now - 24 * 60 * 60 * 1000;
  return rows
    .flatMap((row) => {
      const completedAt = row.completedAt;
      if (row.snapshot.task?.status !== "done" || completedAt === null || Date.parse(completedAt) < since) return [];
      return [
        {
          key: row.taskId,
          taskId: row.taskId,
          at: completedAt,
          title: row.snapshot.task.title,
          summary: deliverySummary(row),
        },
      ];
    })
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}
