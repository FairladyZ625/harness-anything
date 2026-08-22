import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { harnessClient, type TaskListSuccess, type TaskQueryFacets } from "./api-client.ts";
import type { DocEntry, DocGroup } from "./model/types.ts";
import { isRendererRecord } from "./result-validation.ts";
import { workspaceSummaryQueryKeys } from "./workspace-summary-data.ts";

export const LEDGER_REFRESH_INTERVAL_MS = 2_000;
export const TASK_LIST_PAGE_LIMIT = 500;

export const taskQueryKeys = {
  all: (repoId: string) => ["tasks", repoId] as const,
  list: (repoId: string) => ["tasks", repoId, "list"] as const,
  document: (repoId: string, taskId: string, path: string) => ["tasks", repoId, taskId, "document", path] as const,
  documentList: (repoId: string, taskId: string) => ["tasks", repoId, taskId, "document-list"] as const
};

export function taskListQuery(repoId: string) {
  return {
    queryKey: taskQueryKeys.list(repoId),
    queryFn: () => readCompleteTaskList(repoId),
    staleTime: 10_000,
    refetchInterval: LEDGER_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: "always" as const
  };
}

export async function readCompleteTaskList(repoId: string): Promise<TaskListSuccess> {
  return readTaskPages(repoId, {});
}

export async function readTaskList(repoId: string, previous?: TaskListSuccess): Promise<TaskListSuccess> {
  if (!previous || previous.status !== "ready") return readCompleteTaskList(repoId);
  const delta = await readTaskPages(repoId, { changedAfterRevision: previous.watermark });
  if (delta.status !== "ready" || delta.watermark < previous.watermark || delta.sourceRevision < previous.sourceRevision) return readCompleteTaskList(repoId);
  const rows = new Map(previous.rows.map((row) => [row.taskId, row]));
  for (const row of delta.rows) rows.set(row.taskId, row);
  return { ...delta, rows: [...rows.values()].sort((left, right) => left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0) };
}

async function readTaskPages(repoId: string, facets: Pick<TaskQueryFacets, "changedAfterRevision">): Promise<TaskListSuccess> {
  const first = await harnessClient.getTasks({ repoId, ...facets, limit: TASK_LIST_PAGE_LIMIT });
  let current = first;
  const rows = [...first.rows];
  while (current.page?.nextCursor) {
    current = await harnessClient.getTasks({ repoId, ...facets, limit: TASK_LIST_PAGE_LIMIT, cursor: current.page.nextCursor });
    if (current.watermark !== first.watermark || current.sourceRevision !== first.sourceRevision) {
      throw new Error("Task projection changed while the complete list was being read.");
    }
    rows.push(...current.rows);
  }
  const { page: _page, ...complete } = first;
  return { ...complete, rows };
}

export function useTasksQuery(repoId: string | null) {
  const queryClient = useQueryClient(), selectedRepoId = repoId ?? "unselected", queryKey = taskQueryKeys.list(selectedRepoId);
  return useQuery({
    ...taskListQuery(selectedRepoId),
    queryFn: () => readTaskList(selectedRepoId, queryClient.getQueryData<TaskListSuccess>(queryKey)),
    enabled: repoId !== null
  });
}

export async function invalidateLedgerDependents(queryClient: QueryClient, repoId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: taskQueryKeys.all(repoId), predicate: (query) => query.queryKey[2] !== "list" }),
    queryClient.invalidateQueries({ queryKey: ["triadic", repoId] }),
    queryClient.invalidateQueries({ queryKey: workspaceSummaryQueryKeys.read(repoId) })
  ]);
}

export function taskDocumentQuery(repoId: string, taskId: string, path: string) { return { queryKey: taskQueryKeys.document(repoId, taskId, path), queryFn: () => harnessClient.getTaskDocument({ repoId, taskId, path }), staleTime: 10_000 }; }

export function useTaskDocumentQuery(repoId: string, taskId: string, path: string | null) { return useQuery({ ...taskDocumentQuery(repoId, taskId, path ?? ""), enabled: path !== null }); }

/** 任务包文档清单(repo.tasks.documents.list):合同槽位之外,artifacts/ 等子目录文件也在此列。 */
export function taskDocumentListQuery(repoId: string, taskId: string) { return { queryKey: taskQueryKeys.documentList(repoId, taskId), queryFn: () => harnessClient.getTaskDocuments({ repoId, taskId }), staleTime: 10_000 }; }

export function useTaskDocumentListQuery(repoId: string, taskId: string | null) { return useQuery({ ...taskDocumentListQuery(repoId, taskId ?? ""), enabled: taskId !== null }); }

export function parseTaskContractDocuments(taskId: string, body: string): DocEntry[] {
  let value: unknown; try { value = JSON.parse(body); } catch { throw new Error("task-contract projection is not valid JSON"); }
  if (!isRendererRecord(value) || value.schema !== "task-contract/v1" || value.taskId !== taskId || !Array.isArray(value.documents)) throw new Error("task-contract projection does not match this task");
  return value.documents.map((item, index) => {
    if (!isRendererRecord(item) || typeof item.slot !== "string" || typeof item.path !== "string" || !item.path || item.path.startsWith("/") || item.path.split("/").includes("..")) throw new Error(`task-contract document ${index} is invalid`);
    return { path: item.path, title: item.path.split("/").at(-1) ?? item.path, group: groupForSlot(item.slot), required: !item.path.endsWith("/.gitkeep") && item.path !== ".gitkeep", present: false, presence: "unknown" as const };
  });
}

function groupForSlot(slot: string): DocGroup {
  if (slot.includes("plan")) return "计划"; if (slot.includes("design")) return "设计"; if (slot.includes("artifact") || slot.includes("evidence")) return "证据";
  if (slot.includes("progress") || slot.endsWith(".facts")) return "进度"; if (slot.includes("closeout")) return "收口"; return "必读";
}
