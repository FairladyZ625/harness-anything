/**
 * 项目窗口契约(task_ca1ee6b9e8f83c89cb376e5f07):「一个项目一个窗口」的 renderer↔main 通道。
 *
 * - 新窗口的初始项目不经 URL 传递:打包态 file:// 文档的 query 会被
 *   isNavigableAppDocumentUrl 的 href 全等判定拒绝,还得为它放宽导航边界;改走
 *   BrowserWindow webPreferences.additionalArguments,preload 从 process.argv 读出,
 *   单窗口(无该参数)行为一字不变。
 * - 主进程靠「每个窗口上报自己的当前项目」记账:setActiveProject 由 renderer 在
 *   activeRepoId 变化时发出。开窗入口分两条(CEO 2026-10-17 裁定):切换器
 *   「在新窗口打开」按记账去重(同项目已开则聚焦、不重复开);菜单「新建窗口 ⌘⇧N」
 *   总是新建、以当前项目作初始项目。窗口内仍可用切换器换项目(不锁死),上报保证
 *   记账随之更新。
 */
export const PROJECT_WINDOW_OPEN_CHANNEL = "harness:windows:openProject";
export const PROJECT_WINDOW_ACTIVE_CHANNEL = "harness:windows:setActiveProject";

export const INITIAL_PROJECT_ARGUMENT_PREFIX = "--harness-initial-repo=";

/** repoId 形状与 project-directory-ipc 同一判据(小写 kebab,≤63)。 */
export function isProjectWindowRepoId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,62}$/u.test(value);
}

/** preload 从渲染进程 argv 里取主进程经 additionalArguments 传入的初始项目;无则 null。 */
export function initialProjectFromArgv(argv: readonly string[]): string | null {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const entry = argv[index];
    if (!entry.startsWith(INITIAL_PROJECT_ARGUMENT_PREFIX)) continue;
    const repoId = entry.slice(INITIAL_PROJECT_ARGUMENT_PREFIX.length);
    return isProjectWindowRepoId(repoId) ? repoId : null;
  }
  return null;
}

export interface ProjectWindowApi {
  /** 在独立窗口打开项目:该项目的窗口已存在则主进程聚焦它,否则新建停在该项目。 */
  readonly openProject: (input: { readonly repoId: string }) => Promise<void>;
  /** 窗口上报自己的当前项目(可为 null = 未选),维持主进程的窗口↔项目记账。 */
  readonly setActiveProject: (input: { readonly repoId: string | null }) => Promise<void>;
  /** 本窗口经 additionalArguments 收到的初始项目;普通启动为 null。 */
  readonly initialProjectId: string | null;
}
