import { useMutation } from "@tanstack/react-query";
import { inspectWorkspace } from "../../connection-admin-client.ts";
import { useRepoAdminMutations } from "../../connection-data.ts";
import { guiHostBridge } from "../../gui-transport.ts";
import { t } from "../../i18n/index.tsx";

/** 管理动作(停用/启用/移除)需要宿主的 repoAdmin bridge;浏览器调试面没有,动作不出现。 */
export function canManageProjects(): boolean {
  return guiHostBridge()?.repoAdmin !== undefined;
}

export interface AddProjectNotice {
  readonly tone: "done" | "bad";
  readonly text: string;
}

/**
 * 「添加项目」:选一个本机目录 → 已有 Harness 台账就直接注册(daemon.repo.register)。
 * 没有台账的目录需要新建台账(身份、工作区名等),那张表单在「设置 → 仓库与连接」,
 * 这里如实指路,不在本页再做一份。available 为假(没有选目录或注册的 bridge)时不给入口。
 * 被拒绝或出错时,原因由 mutation 的 error 带出,显示在页头下方。
 */
export function useAddProject(): {
  readonly available: boolean;
  readonly busy: boolean;
  readonly notice: AddProjectNotice | null;
  readonly add: () => void;
} {
  const { register } = useRepoAdminMutations();
  const firstRun = guiHostBridge()?.firstRun;
  const flow = useMutation({
    mutationFn: async (): Promise<AddProjectNotice | null> => {
      const rootDir = await firstRun!.chooseRepository();
      if (rootDir === null) return null;
      const inspected = await inspectWorkspace(rootDir);
      if (!inspected.hasWorkspace) return { tone: "bad", text: t("views.homeView.addNoLedger", { path: rootDir }) };
      await register.mutateAsync({ rootDir, repoId: inspected.suggestedRepoId, mode: "local" });
      return { tone: "done", text: t("views.homeView.addDone", { repoId: inspected.suggestedRepoId }) };
    },
  });
  return {
    available: firstRun !== undefined && canManageProjects(),
    busy: flow.isPending,
    notice: flow.error === null ? (flow.data ?? null) : { tone: "bad", text: flow.error.message },
    add: () => flow.mutate(),
  };
}
