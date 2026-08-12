import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "./api-client.ts";

export const taskQueryKeys = {
  all: ["harness", "tasks"] as const,
  list: () => [...taskQueryKeys.all, "list"] as const
};

export function useTasksQuery() {
  return useQuery({
    queryKey: taskQueryKeys.list(),
    queryFn: () => harnessClient.getTasks(),
    staleTime: 10_000
  });
}
