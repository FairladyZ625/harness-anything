import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { harnessClient, type DaemonControlReceipt, type SystemRepoRow } from "./api-client.ts";

export const systemQueryKeys = {
  status: () => ["system", "global", "status"] as const,
};

export function selectActiveRepoId(repos: ReadonlyArray<SystemRepoRow>, current: string | null): string | null {
  const enabled = repos.filter((repo) => repo.registrationState === "enabled");
  if (current && enabled.some((repo) => repo.repoId === current)) return current;
  return enabled.find((repo) => repo.cellState === "attached")?.repoId ?? enabled[0]?.repoId ?? null;
}

export function useSystemStatusQuery() {
  return useQuery({
    queryKey: systemQueryKeys.status(),
    queryFn: () => harnessClient.getSystemStatus(),
    staleTime: 3_000,
    refetchInterval: 10_000,
  });
}

export function controlSucceeded(receipt: DaemonControlReceipt): boolean {
  if (!receipt.ok || receipt.phase !== "settled" || !receipt.before || !receipt.after) return false;
  return receipt.kind === "refresh" || receipt.after.pid !== receipt.before.pid;
}

export async function settleDaemonControl(
  initial: DaemonControlReceipt,
  read: (operationId: string) => Promise<DaemonControlReceipt>,
  pause: () => Promise<void> = () => new Promise((resolve) => window.setTimeout(resolve, 250)),
): Promise<DaemonControlReceipt> {
  let receipt = initial;
  for (
    let attempt = 0;
    attempt < 80 &&
    receipt.ok &&
    !(
      /* @gate-identity check-gui-status-judgments/gui-status-042 */
      ["settled", "failed"].includes(receipt.phase)
    );
    attempt += 1
  ) {
    await pause();
    receipt = await read(receipt.operationId);
  }
  return receipt;
}

export function useDaemonControl(authorityRepoId: string | null) {
  const queryClient = useQueryClient();
  const [receipt, setReceipt] = useState<DaemonControlReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useCallback(
    async (kind: "refresh" | "restart") => {
      if (!authorityRepoId || busy) return null;
      setBusy(true);
      try {
        const initial = await harnessClient.requestDaemonControl({ kind, authorityRepoId });
        setReceipt(initial);
        const settled =
          initial.ok &&
          !(
            /* @gate-identity check-gui-status-judgments/gui-status-043 */
            ["settled", "failed"].includes(initial.phase)
          )
            ? await settleDaemonControl(initial, async (operationId) => {
                const next = await harnessClient.getDaemonControlReceipt({ operationId });
                setReceipt(next);
                return next;
              })
            : initial;
        setReceipt(settled);
        if (controlSucceeded(settled)) await queryClient.invalidateQueries({ queryKey: systemQueryKeys.status() });
        return settled;
      } finally {
        setBusy(false);
      }
    },
    [authorityRepoId, busy, queryClient],
  );
  return { receipt, busy, request };
}
