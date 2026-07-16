import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "../api-client.ts";
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
