import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EdgeJoinWizard } from "./components/EdgeJoinWizard.tsx";
import { onEdgeJoinLink } from "./edge-join-client.ts";
import { systemQueryKeys } from "./system-data.ts";

/**
 * Owns the join-center wizard's open state and its handoff to the shell: a `harness-edge://`
 * activation prefills it, the two entries open it empty, and a finished join refreshes the repo
 * list before switching to the first repository the invitation actually synced.
 */
export function useEdgeJoinEntry(openProject: (repoId: string) => void | Promise<void>): {
  readonly open: () => void;
  readonly wizard: ReactNode;
} {
  const queryClient = useQueryClient(),
    [state, setState] = useState<{ readonly open: boolean; readonly link: string | null }>({
      open: false,
      link: null,
    });
  useEffect(() => onEdgeJoinLink((link) => setState({ open: true, link })), []);
  return {
    open: () => setState({ open: true, link: null }),
    wizard: (
      <EdgeJoinWizard
        open={state.open}
        initialLink={state.link}
        onClose={() => setState({ open: false, link: null })}
        onJoined={(repoIds) => {
          // 加入即注册:先刷系统状态让新仓可见,再切到第一个加入的仓库。
          void queryClient.invalidateQueries({ queryKey: systemQueryKeys.status() });
          if (repoIds.length > 0) void openProject(repoIds[0]!);
        }}
      />
    ),
  };
}
