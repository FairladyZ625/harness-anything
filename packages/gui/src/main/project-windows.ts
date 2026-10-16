import { INITIAL_PROJECT_ARGUMENT_PREFIX } from "../api/project-window-contract.ts";

/**
 * 项目窗口注册表(task_ca1ee6b9e8f83c89cb376e5f07):主进程对「哪个窗口停在哪个项目」
 * 的唯一记账。renderer 在自己的 activeRepoId 变化时经 setActiveProject 上报;开窗入口
 * 分两条(CEO 2026-10-17 裁定):切换器「在新窗口打开」= openProjectWindow,按记账去重,
 * 目标项目的窗口还在就聚焦它;菜单「新建窗口 ⌘⇧N」= newWindow,总是新建、以当前项目
 * 作初始项目(不去重,同项目允许并排多窗)。初始项目经 additionalArguments 传入新窗口。
 * 窗口关闭即出表(closed 事件),不做过期守卫。
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
  /** 切换器「在新窗口打开」:该项目已有窗口则聚焦它,否则新建停在该项目。 */
  openProjectWindow(repoId: string): ProjectWindowRegistryEntry;
  /** 总是新建一个窗口,以 seedRepoId 作初始项目,即使该项目已有窗口;null = 默认选仓。 */
  newWindow(seedRepoId: string | null): ProjectWindowRegistryEntry;
  /** 窗口上报自己的当前项目;未知窗口(不在表中)忽略,新表项只经 openProjectWindow/newWindow 建立。 */
  setActiveProject(webContentsId: number, repoId: string | null): void;
  /** 某窗口当前停在的项目;不在表中为 null(菜单「新建窗口」默认停当前项目用)。 */
  repoIdOf(webContentsId: number): string | null;
}

/**
 * 菜单「新建窗口 ⌘⇧N」的动作(CEO 2026-10-17 裁定):总是新建一个窗口,以聚焦窗口
 * 停着的项目作初始项目;焦点不在任何窗口或未选项目时开默认窗口。不查重——在已停在
 * 某项目的窗口里按 ⌘⇧N 也要再开一个,而不是聚焦自己。独立成纯函数使菜单→注册表的
 * 接缝可单测(真实菜单点击无法 headless 验证)。
 */
export function menuNewWindow(
  registry: Pick<ProjectWindowRegistry, "newWindow" | "repoIdOf">,
  focusedWebContentsId: number | null,
): void {
  registry.newWindow(focusedWebContentsId === null ? null : registry.repoIdOf(focusedWebContentsId));
}

export function createProjectWindowRegistry(options: {
  readonly createProjectWindow: (repoId: string | null) => ProjectWindowRegistryEntry;
  /** false = headless/自动化运行:窗口保持隐藏,聚焦分支只记账不碰窗口。 */
  readonly focusWindows: boolean;
}): ProjectWindowRegistry {
  const windows = new Map<number, { readonly window: ProjectWindowRegistryEntry; repoId: string | null }>();
  const newWindow = (seedRepoId: string | null): ProjectWindowRegistryEntry => {
    const window = options.createProjectWindow(seedRepoId);
    windows.set(window.webContentsId, { window, repoId: seedRepoId });
    window.onClosed(() => windows.delete(window.webContentsId));
    return window;
  };
  return {
    openProjectWindow(repoId) {
      for (const entry of windows.values()) {
        if (entry.repoId !== repoId) continue;
        if (options.focusWindows) entry.window.focus();
        return entry.window;
      }
      return newWindow(repoId);
    },
    newWindow,
    setActiveProject(webContentsId, repoId) {
      const entry = windows.get(webContentsId);
      if (entry !== undefined) entry.repoId = repoId;
    },
    repoIdOf(webContentsId) {
      return windows.get(webContentsId)?.repoId ?? null;
    },
  };
}
