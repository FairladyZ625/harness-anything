import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { harnessClient } from "../api-client.ts";
import type { DaemonRestartResult } from "../daemon-diagnostics-api-contract.ts";
import type { DaemonStatusModel } from "./daemon-status.ts";

export const daemonStatusQueryKeys = {
  all: ["harness", "daemon-status"] as const,
  current: () => [...daemonStatusQueryKeys.all, "current"] as const
};

/** Loads daemon status for the Settings → System panel via the live bridge. */
async function fetchDaemonStatus(): Promise<DaemonStatusModel> {
  return harnessClient.getDaemonStatus();
}

export function useDaemonStatusQuery() {
  return useQuery({
    queryKey: daemonStatusQueryKeys.current(),
    queryFn: fetchDaemonStatus,
    staleTime: 5_000
  });
}

/**
 * Requests a service-wide daemon restart via admin.daemon.restart.
 * On accept, invalidates the status query so activeControl / new PID can surface.
 */
export function useDaemonRestartMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<DaemonRestartResult> => {
      const result = await harnessClient.restartDaemon(null);
      if (!result.ok) {
        const error = new Error(result.error.hint);
        (error as Error & { code?: string }).code = result.error.code;
        throw error;
      }
      return result;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: daemonStatusQueryKeys.all });
    }
  });
}
