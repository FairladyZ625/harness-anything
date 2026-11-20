import { consumeKnownError } from "../../../api/error-consumption.ts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { agentRuntimeClient, runtimeQueryKeys } from "../../agent-runtime-client.ts";
import { runtimeCommandClient } from "../../runtime-command-client.ts";
import { submitRuntimeSpawn, type RuntimeSpawnSettlement } from "../../runtime-control.ts";
import { readAllTaskDispatches } from "../../task-dispatch-client.ts";
import { t } from "../../i18n/index.tsx";

export interface AgendaContinuation {
  readonly read: UseQueryResult<Awaited<ReturnType<typeof readAllTaskDispatches>>, Error>;
  readonly resume: { readonly dispatchId: string; readonly agentId: string | null } | undefined;
  readonly result: RuntimeSpawnSettlement | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly run: (resumeDispatchId?: string, freshTaskId?: string | null, findResume?: boolean) => Promise<void>;
}

/** Selected-card read only. The daemon's resume admission owns the Execution fence. */
export function useAgendaContinuation(repoId: string, taskId: string | null): AgendaContinuation {
  const read = useQuery({
    queryKey: runtimeQueryKeys.dispatches(repoId, taskId ?? ""),
    queryFn: () => readAllTaskDispatches({ repoId, taskId: taskId! }),
    enabled: taskId !== null,
  });
  const resume = read.data?.dispatches.findLast((row) => row.resume)?.resume;
  const [result, setResult] = useState<RuntimeSpawnSettlement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef<string | null>(null);
  const run = async (resumeDispatchId?: string, freshTaskId = taskId, findResume = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    try {
      if (findResume && result?.state !== "pending") {
        const refreshed = await read.refetch({ throwOnError: true });
        resumeDispatchId = refreshed.data?.dispatches.findLast((row) => row.resume)?.resume?.dispatchId;
      }
      if (!resumeDispatchId && freshTaskId === null && result?.state !== "pending") {
        setError(t("views.agenda.wakeTargetUnavailable"));
        return;
      }
      const settled = await submitRuntimeSpawn(
        {
          dispatchKey: key.current,
          ...(resumeDispatchId ? { dispatchId: resumeDispatchId } : { taskId: freshTaskId }),
        },
        {
          spawn: (input) =>
            result?.state === "pending"
              ? runtimeCommandClient.showReceipt(repoId, result.opId)
              : runtimeCommandClient.spawn(repoId, input),
          showReceipt: (opId) => runtimeCommandClient.showReceipt(repoId, opId),
          overview: () => agentRuntimeClient.overview(repoId, freshTaskId ?? undefined),
          onPending: setResult,
        },
      );
      setResult(settled);
      if (settled.state !== "pending") key.current = null;
    } catch (cause) {
      consumeKnownError(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return { read, resume, result, error, busy, run };
}
