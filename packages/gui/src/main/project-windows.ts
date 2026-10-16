import { INITIAL_PROJECT_ARGUMENT_PREFIX } from "../api/project-window-contract.ts";

/**
 * 项目窗口注册表(task_ca1ee6b9e8f83c89cb376e5f07):主进程对「哪个窗口停在哪个项目」
 * 的唯一记账。renderer 在自己的 activeRepoId 变化时经 setActiveProject 上报;「在新窗口
 * 打开」按这份记账判定——目标项目的窗口还在就聚焦它,不在才新建(初始项目经
 * additionalArguments 传入新窗口)。窗口关闭即出表(closed 事件),不做过期守卫。
 */
export interface ProjectWindowRegistryEntry {
  readonly webContentsId: number;
  /** 前台语义的聚焦:恢复最小化 + show + focus。headless 运行不会被调用。 */
  focus(): void;
  onClosed(listener: () => void): void;
}

export function projectWindowArgument(repoId: string): string {
  return `${INITIAL_PROJECT_ARGUMENT_PREFIX}${repoId}`;
}

export interface ProjectWindowRegistry {
  /** 打开(或聚焦已有的)停在指定项目的窗口;repoId 为 null 时无条件新建默认窗口。 */
  openProjectWindow(repoId: string | null): ProjectWindowRegistryEntry;
  /** 窗口上报自己的当前项目;未知窗口(不在表中)忽略,新表项只经 openProjectWindow 建立。 */
  setActiveProject(webContentsId: number, repoId: string | null): void;
  /** 某窗口当前停在的项目;不在表中为 null(菜单「新建窗口」默认停当前项目用)。 */
  repoIdOf(webContentsId: number): string | null;
}

export function createProjectWindowRegistry(options: {
  readonly createProjectWindow: (repoId: string | null) => ProjectWindowRegistryEntry;
  /** false = headless/自动化运行:窗口保持隐藏,聚焦分支只记账不碰窗口。 */
  readonly focusWindows: boolean;
}): ProjectWindowRegistry {
  const windows = new Map<number, { readonly window: ProjectWindowRegistryEntry; repoId: string | null }>();
  return {
    openProjectWindow(repoId) {
      if (repoId !== null) {
        for (const entry of windows.values()) {
          if (entry.repoId !== repoId) continue;
          if (options.focusWindows) entry.window.focus();
          return entry.window;
        }
      }
      const window = options.createProjectWindow(repoId);
      windows.set(window.webContentsId, { window, repoId });
      window.onClosed(() => windows.delete(window.webContentsId));
      return window;
    },
    setActiveProject(webContentsId, repoId) {
      const entry = windows.get(webContentsId);
      if (entry !== undefined) entry.repoId = repoId;
    },
    repoIdOf(webContentsId) {
      return windows.get(webContentsId)?.repoId ?? null;
    },
  };
}
