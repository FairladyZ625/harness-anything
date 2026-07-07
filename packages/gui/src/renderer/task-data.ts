import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DomainStatus, TaskProjectionRow } from "../api/renderer-dto.ts";
import { harnessClient, type CommandResult } from "./api-client.ts";

export const taskQueryKeys = {
  all: ["harness", "tasks"] as const,
  list: () => [...taskQueryKeys.all, "list"] as const,
  detail: (taskId: string) => [...taskQueryKeys.all, "detail", taskId] as const,
  document: (taskId: string, path: string) => [...taskQueryKeys.all, "document", taskId, path] as const
};

export function useTasksQuery() {
  return useQuery({
    queryKey: taskQueryKeys.list(),
    queryFn: () => harnessClient.getTasks(),
    staleTime: 10_000
  });
}

export function useTaskDetailQuery(taskId: string | null) {
  return useQuery({
    queryKey: taskQueryKeys.detail(taskId ?? "none"),
    queryFn: () => {
      if (!taskId) throw new Error("Task id is required.");
      return harnessClient.getTaskDetail({ taskId });
    },
    enabled: taskId !== null
  });
}

export function useTaskDocumentQuery(taskId: string | null, path: string | null) {
  return useQuery({
    queryKey: taskQueryKeys.document(taskId ?? "none", path ?? "none"),
    queryFn: () => {
      if (!taskId || !path) throw new Error("Task document path is required.");
      return harnessClient.getTaskDocument({ taskId, path });
    },
    enabled: taskId !== null && path !== null
  });
}

export function useSetTaskStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly taskId: string; readonly status: DomainStatus }) => harnessClient.setTaskStatus(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.all });
    }
  });
}

export function useAppendTaskProgressMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly taskId: string; readonly text: string }) => harnessClient.appendTaskProgress(input),
    onSuccess: async (_result, input) => {
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(input.taskId) });
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.document(input.taskId, "progress.md") });
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.list() });
    }
  });
}

export function useReviewTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly taskId: string }) => harnessClient.reviewTask(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.all });
    }
  });
}

export function useRebuildGovernanceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => harnessClient.rebuildGovernance(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.all });
    }
  });
}

export function activeTaskCount(tasks: ReadonlyArray<TaskProjectionRow>): number {
  return tasks.filter((task) => task.coordinationStatus === "open" || task.coordinationStatus === "blocked" || task.coordinationStatus === "in_review").length;
}

export function taskModule(task: TaskProjectionRow): string {
  return task.moduleTitle ?? task.moduleKey ?? task.vertical ?? "unassigned";
}

export function commandMessage(result: CommandResult | undefined): string {
  if (!result) return "";
  return result.ok ? "Command completed through the local task bridge." : `${result.error.code}: ${result.error.hint}`;
}
