import { useCallback, useEffect, useRef, useState } from "react";
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
  const refreshing = useRef<string | null>(null);
  const { mutate, reset, error } = useMutation({
    mutationFn: async ({
      target,
      requireSuccessfulExit,
    }: {
      target: RuntimeAuthRequest;
      requireSuccessfulExit: boolean;
    }) => {
      // Exit frames deliberately contain no exitCode. Read the authoritative session row,
      // including when a fast provider command exited before the renderer attached.
      if (requireSuccessfulExit) {
        const listed = await terminalClient.list(target.repoId);
        client.setQueryData(terminalQueryKeys.sessions(target.repoId), listed);
        if (listed.sessions.find((row) => row.sessionId === target.sessionId)?.exitCode !== 0) return false;
      }
      await runtimeInstanceClient.probe(target.instanceId, target.repoId);
      await Promise.all([
        client.invalidateQueries({ queryKey: runtimeInstanceCatalogQueryKey }),
        client.invalidateQueries({ queryKey: ["runtime-control", target.repoId] }),
      ]);
      return true;
    },
    onSuccess: (refreshed, { target }) => {
      if (refreshed) setRequest((current) => (current?.requestId === target.requestId ? null : current));
    },
    onSettled: (_data, _error, { target }) => {
      if (refreshing.current === target.requestId) refreshing.current = null;
    },
  });
  const refresh = useCallback(
    (target: RuntimeAuthRequest, requireSuccessfulExit: boolean) => {
      if (refreshing.current === target.requestId) return;
      refreshing.current = target.requestId;
      mutate({ target, requireSuccessfulExit });
    },
    [mutate],
  );
  useEffect(() => {
    if (view === "providers" && request?.repoId === repoId) refresh(request, false);
  }, [refresh, repoId, request, view]);
  return {
    attachSession: request?.repoId === repoId ? request : null,
    error: error?.message ?? null,
    open: (instanceId: string, sessionId: string) => {
      reset();
      setRequest({ requestId: crypto.randomUUID(), repoId, instanceId, sessionId });
    },
    onSessionExit: (sessionId: string) => {
      if (request?.repoId === repoId && request.sessionId === sessionId) refresh(request, true);
    },
  };
}
