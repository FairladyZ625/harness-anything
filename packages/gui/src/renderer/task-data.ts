import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "./api-client.ts";

export const taskQueryKeys = {
  all: ["harness", "tasks"] as const,
  list: () => [...taskQueryKeys.all, "list"] as const, document: (taskId: string, path: string) => [...taskQueryKeys.all, taskId, "document", path] as const
};

export function useTasksQuery() {
  return useQuery({
    queryKey: taskQueryKeys.list(),
    queryFn: () => harnessClient.getTasks(),
    staleTime: 10_000
  });
}

export function taskDocumentQuery(taskId: string, path: string) { return { queryKey: taskQueryKeys.document(taskId, path), queryFn: () => harnessClient.getTaskDocument({ taskId, path }), staleTime: 10_000 }; }

export function useTaskDocumentQuery(taskId: string, path: string | null) { return useQuery({ ...taskDocumentQuery(taskId, path ?? ""), enabled: path !== null }); }
