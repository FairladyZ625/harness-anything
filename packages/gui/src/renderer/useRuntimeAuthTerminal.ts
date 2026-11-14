import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { runtimeInstanceClient } from "./runtime-instance-client.ts";
import { runtimeInstanceCatalogQueryKey } from "./runtime-instance-data.ts";
import { terminalClient, terminalQueryKeys } from "./terminal-client.ts";
import type { TerminalAttachSession } from "./views/TerminalView.tsx";

interface RuntimeAuthRequest extends TerminalAttachSession {
  readonly repoId: string;
  readonly instanceId: string;
}

/** Window-local navigation intent; credentials and account observations remain daemon-owned. */
export function useRuntimeAuthTerminal(repoId: string, view: string) {
  const client = useQueryClient();
  const [request, setRequest] = useState<RuntimeAuthRequest | null>(null);
  const { mutate, reset, error } = useMutation({
    // A successful exit arriving during the early-return probe must run after it,
    // so its account observation cannot be lost or superseded by the earlier one.
    scope: { id: `runtime-auth:${repoId}` },
    mutationFn: async ({
      target,
      requireSuccessfulExit,
    }: {
      target: RuntimeAuthRequest;
      requireSuccessfulExit: boolean;
    }) => {
      // Exit frames deliberately contain no exitCode. Read the authoritative session row,
      // including when a fast provider command exited before the renderer attached.
      const listed = await terminalClient.list(target.repoId);
      client.setQueryData(terminalQueryKeys.sessions(target.repoId), listed);
      const session = listed.sessions.find((row) => row.sessionId === target.sessionId);
      if (requireSuccessfulExit && session?.exitCode !== 0) return false;
      await runtimeInstanceClient.probe(target.instanceId, target.repoId);
      await Promise.all([
        client.invalidateQueries({ queryKey: runtimeInstanceCatalogQueryKey }),
        client.invalidateQueries({ queryKey: ["runtime-control", target.repoId] }),
      ]);
      // Returning to Providers may observe a login that still awaits its authorization
      // code. Keep its handle until a probe started after terminal completion finishes.
      return session?.status === "exited";
    },
    onSuccess: (refreshed, { target }) => {
      if (refreshed) setRequest((current) => (current?.requestId === target.requestId ? null : current));
    },
  });
  useEffect(() => {
    if (view === "providers" && request?.repoId === repoId) mutate({ target: request, requireSuccessfulExit: false });
  }, [mutate, repoId, request, view]);
  return {
    attachSession: request?.repoId === repoId ? request : null,
    error: error?.message ?? null,
    open: (instanceId: string, sessionId: string) => {
      reset();
      setRequest({ requestId: crypto.randomUUID(), repoId, instanceId, sessionId });
    },
    onSessionExit: (sessionId: string) => {
      if (request?.repoId === repoId && request.sessionId === sessionId)
        mutate({ target: request, requireSuccessfulExit: true });
    },
  };
}
