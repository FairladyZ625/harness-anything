import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "./api-client.ts";
import type { DocEntry, DocGroup } from "./model/types.ts";

export const taskQueryKeys = {
  all: (repoId: string) => ["tasks", repoId] as const,
  list: (repoId: string) => ["tasks", repoId, "list"] as const,
  document: (repoId: string, taskId: string, path: string) => ["tasks", repoId, taskId, "document", path] as const
};

export function useTasksQuery(repoId: string | null) {
  return useQuery({
    queryKey: taskQueryKeys.list(repoId ?? "unselected"),
    queryFn: () => harnessClient.getTasks({ repoId: repoId! }),
    enabled: repoId !== null,
    staleTime: 10_000
  });
}

export function taskDocumentQuery(repoId: string, taskId: string, path: string) { return { queryKey: taskQueryKeys.document(repoId, taskId, path), queryFn: () => harnessClient.getTaskDocument({ repoId, taskId, path }), staleTime: 10_000 }; }

export function useTaskDocumentQuery(repoId: string, taskId: string, path: string | null) { return useQuery({ ...taskDocumentQuery(repoId, taskId, path ?? ""), enabled: path !== null }); }

export function parseTaskContractDocuments(taskId: string, body: string): DocEntry[] {
  let value: unknown; try { value = JSON.parse(body); } catch { throw new Error("task-contract projection is not valid JSON"); }
  if (!record(value) || value.schema !== "task-contract/v1" || value.taskId !== taskId || !Array.isArray(value.documents)) throw new Error("task-contract projection does not match this task");
  return value.documents.map((item, index) => {
    if (!record(item) || typeof item.slot !== "string" || typeof item.path !== "string" || !item.path || item.path.startsWith("/") || item.path.split("/").includes("..")) throw new Error(`task-contract document ${index} is invalid`);
    return { path: item.path, title: item.path.split("/").at(-1) ?? item.path, group: groupForSlot(item.slot), required: !item.path.endsWith("/.gitkeep") && item.path !== ".gitkeep", present: false, presence: "unknown" as const };
  });
}

function groupForSlot(slot: string): DocGroup {
  if (slot.includes("plan")) return "计划"; if (slot.includes("design")) return "设计"; if (slot.includes("artifact") || slot.includes("evidence")) return "证据";
  if (slot.includes("progress") || slot.endsWith(".facts")) return "进度"; if (slot.includes("closeout")) return "收口"; return "必读";
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
