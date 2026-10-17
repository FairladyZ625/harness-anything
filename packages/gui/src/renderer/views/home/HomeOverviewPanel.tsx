import { HomeOverviewView } from "./HomeOverviewView.tsx";

/**
 * 重构区「主页」在 App 壳里的落位(dec_C612E69B):App 只负责把两条既有导航出口
 * (切仓 openProject / 跨仓实体路由 navigateToEntity)接进跨仓总览视图,不在
 * App.tsx 里摊开事项级跳转分支。
 */
export function HomeOverviewPanel({
  currentRepoId,
  openProject,
  navigateToEntity,
  openProjectInNewWindow,
}: {
  readonly currentRepoId: string | null;
  /** useProjectSwitch 的 openProject:无显式 targetView 时回该仓上次停留位置。 */
  readonly openProject: (repoId: string, targetView?: "agenda" | "work" | "overview") => void | Promise<void>;
  /** useEntityNavigation 的 navigateToEntity:repo/<id>/<ref> 前缀先切仓再续导航。 */
  readonly navigateToEntity: (ref: string) => void;
  /** 浏览器壳无此能力时为 null,入口隐藏。 */
  readonly openProjectInNewWindow: ((repoId: string) => void) | null;
}) {
  return (
    <HomeOverviewView
      currentRepoId={currentRepoId}
      onOpenProject={(repoId, targetView, taskId) => {
        // 点事项带 taskId → 跨仓实体路由(工作根进工作页,普通任务开详情);
        // 点仓库名/进入按钮 → 回该仓上次停留位置(显式 targetView 时进该页)。
        if (taskId !== undefined) navigateToEntity(`repo/${repoId}/task/${taskId}`);
        else void openProject(repoId, targetView);
      }}
      onOpenProjectInNewWindow={openProjectInNewWindow ?? undefined}
    />
  );
}
