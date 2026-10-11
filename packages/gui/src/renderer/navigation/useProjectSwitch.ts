import { useCallback, useEffect, useState } from "react";
import type { AppLocation, ViewId } from "./viewHistory.ts";

/**
 * 切仓策略(业主 2026-10-11:切换到某个项目,直接回到它上次停留的位置)。
 * 位置记忆由 useViewHistory 承担:切 projectId 时它重读目标仓自己的栈,栈顶即
 * 上次位置;从没打开过的仓读到干净初始栈(总览)。本 hook 只补两件落地事务:
 *
 * 1. 切仓后的显式目标(项目管理页的活动链接、跨仓实体导航的续导航):与
 *    setActiveRepoId 同批的 navigate 会被切仓重读整栈覆盖,挂起为 intent,
 *    待 projectId 落定后再推栈 —— 推在恢复出来的栈之上,后退原路回上次位置。
 * 2. 同仓重复打开:没有重读发生,立即执行目标。
 */
export interface ProjectSwitchIntent {
  readonly repoId: string;
  readonly view: ViewId | null;
  readonly continueInRepo: (() => void) | null;
}

export function useProjectSwitch({
  projectId,
  navigate,
  switchProject,
  leaveProject = async () => undefined,
  onProjectOpened = () => undefined,
}: {
  /** 与 useViewHistory 同一 projectId(含 "unselected" 哨兵),intent 落地按它判。 */
  readonly projectId: string;
  readonly navigate: (fields: Partial<AppLocation>) => void;
  readonly switchProject: (repoId: string) => void;
  /** 离开当前仓前的清理(取消在途查询);在 setActiveRepoId 之前 await。 */
  readonly leaveProject?: (repoId: string) => void | Promise<void>;
  /** 切换生效后的并行动作(关切换器等)。 */
  readonly onProjectOpened?: () => void;
}): {
  readonly openProject: (repoId: string, targetView?: ViewId, continueInRepo?: () => void) => Promise<void>;
  readonly goto: (view: ViewId) => void;
} {
  const [pendingIntent, setPendingIntent] = useState<ProjectSwitchIntent | null>(null);

  useEffect(() => {
    if (pendingIntent === null || pendingIntent.repoId !== projectId) return;
    setPendingIntent(null);
    if (pendingIntent.continueInRepo !== null) pendingIntent.continueInRepo();
    else if (pendingIntent.view !== null) gotoLocation(navigate, pendingIntent.view);
  }, [navigate, pendingIntent, projectId]);

  const goto = useCallback((view: ViewId) => gotoLocation(navigate, view), [navigate]);

  const openProject = useCallback(
    async (repoId: string, targetView?: ViewId, continueInRepo?: () => void) => {
      if (repoId === projectId) {
        if (continueInRepo !== undefined) continueInRepo();
        else if (targetView !== undefined) goto(targetView);
        onProjectOpened();
        return;
      }
      await leaveProject(projectId);
      if (targetView !== undefined || continueInRepo !== undefined) {
        setPendingIntent({ repoId, view: targetView ?? null, continueInRepo: continueInRepo ?? null });
      }
      switchProject(repoId);
      onProjectOpened();
    },
    [goto, leaveProject, onProjectOpened, projectId, switchProject],
  );

  return { openProject, goto };
}

function gotoLocation(navigate: (fields: Partial<AppLocation>) => void, view: ViewId): void {
  navigate({
    view,
    focusedEntityRef: null,
    selectedId: null,
    previewId: null,
    // 总览页内层(产物二级页/放大层)随离页显式收起:侧栏再进总览给干净首屏,
    // 后退仍能回到带着层的那一条(层字段留在原条目里)。
    overviewArtifactId: null,
    overviewFocus: null,
    ...(view !== "board" ? { drill: null } : {}),
  });
}
