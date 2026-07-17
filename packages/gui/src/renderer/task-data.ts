import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DomainStatus, TaskProjectionRow } from "../api/renderer-dto.ts";
import { harnessClient, type CommandResult } from "./api-client.ts";

export const taskQueryKeys = {
  all: ["harness", "tasks"] as const,
  list: (repoId?: string | null) => [...taskQueryKeys.all, "list", repoId ?? "default"] as const,
  detail: (taskId: string, repoId?: string | null) =>
    [...taskQueryKeys.all, "detail", repoId ?? "default", taskId] as const,
  document: (taskId: string, path: string, repoId?: string | null) =>
    [...taskQueryKeys.all, "document", repoId ?? "default", taskId, path] as const
};

export function useTasksQuery(repoId?: string | null) {
  return useQuery({
    queryKey: taskQueryKeys.list(repoId),
    queryFn: () => harnessClient.getTasks(repoId ?? undefined),
    staleTime: 10_000,
    });
}

export function useTaskDetailQuery(taskId: string | null, repoId?: string | null) {
  return useQuery({
    queryKey: taskQueryKeys.detail(taskId ?? "none", repoId),
    queryFn: () => {
      if (!taskId) throw new Error("Task id is required.");
      return harnessClient.getTaskDetail({
        taskId,
        ...(repoId ? { repoId } : {})
      });
    },
    enabled: taskId !== null
  });
}

export function useTaskDocumentQuery(
  taskId: string | null,
  path: string | null,
  repoId?: string | null
) {
  return useQuery({
    queryKey: taskQueryKeys.document(taskId ?? "none", path ?? "none", repoId),
    queryFn: () => {
      if (!taskId || !path) throw new Error("Task document path is required.");
      return harnessClient.getTaskDocument({
        taskId,
        path,
        ...(repoId ? { repoId } : {})
      });
    },
    enabled: taskId !== null && path !== null
  });
}

export function useSetTaskStatusMutation(repoId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly taskId: string; readonly status: DomainStatus }) =>
      requireCommandSuccess(
        await harnessClient.setTaskStatus({
          ...input,
          ...(repoId ? { repoId } : {})
        })
      ),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.all });
    }
  });
}

export function useAppendTaskProgressMutation(repoId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly taskId: string; readonly text: string }) =>
      harnessClient.appendTaskProgress({
        ...input,
        ...(repoId ? { repoId } : {})
      }),
    onSuccess: async (_result, input) => {
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(input.taskId, repoId) });
      await queryClient.invalidateQueries({
        queryKey: taskQueryKeys.document(input.taskId, "progress.md", repoId)
      });
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.list(repoId) });
    }
  });
}

export function useReviewTaskMutation(repoId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly taskId: string }) =>
      requireCommandSuccess(
        await harnessClient.reviewTask({
          ...input,
          ...(repoId ? { repoId } : {})
        })
      ),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.all });
    }
  });
}

export function useRebuildGovernanceMutation(repoId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => harnessClient.rebuildGovernance(repoId ?? undefined),
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

function requireCommandSuccess(result: CommandResult): CommandResult {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`);
  return result;
}
