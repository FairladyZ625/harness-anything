import type { SystemRepoRow } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import { Region } from "../components/primitives/Region.tsx";
import type { StatusTone } from "../components/primitives/StatusTag.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { groupProjects, repoNeedsAttention, type ProjectGroupId } from "../model/repo-state.ts";
import { canManageProjects, useAddProject } from "./home/add-project.ts";
import { ProjectEntry } from "./home/ProjectEntry.tsx";
import { useProjectActivity } from "./home/project-activity.ts";

const GROUP_TITLE = {
  attention: "views.homeView.groupAttention",
  open: "views.homeView.groupOpen",
  disabled: "views.homeView.groupDisabled",
} as const;

/**
 * 项目管理页(标准 §2.5 目录型):回答「各项目现在怎么样、哪个需要我、我能在这里做什么」。
 * 三个区域框自上而下:需要处理(挂不上、报错、有等人处理的事)→ 项目(当前项目置首并
 * 标记)→ 已停用;空的区域不渲染。区域内条目按容器宽度自动分列——每列不窄于 32rem
 * (项目名、位置与第二行的计数在两行里放得下的宽度),窄了退成单列,宽了就多列铺开。
 */
export function HomeView({
  repos,
  currentRepoId,
  onOpenProject,
}: {
  readonly repos: ReadonlyArray<SystemRepoRow>;
  readonly currentRepoId: string | null;
  readonly onOpenProject: (repoId: string, targetView?: "agenda" | "work") => void;
}) {
  const readOf = useProjectActivity(repos),
    groups = groupProjects(repos, currentRepoId, readOf),
    addProject = useAddProject(),
    canManage = canManageProjects(),
    counts = (
      [
        ["views.homeView.countOpen", groups.open.length],
        ["views.homeView.countAttention", groups.attention.length],
        ["views.homeView.countDisabled", groups.disabled.length],
      ] as const
    ).filter(([, count]) => count > 0),
    attentionTone: StatusTone = groups.attention.some(
      (repo) => repoNeedsAttention(repo) || readOf(repo).state === "failed",
    )
      ? "bad"
      : "wait";
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="home-view">
      <header className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3" data-testid="home-header">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h1 className="ui-heading font-semibold">{t("views.homeView.title")}</h1>
            <span className="ui-meta text-text-muted" data-testid="home-counts">
              {counts.map(([key, count]) => t(key, { count })).join(" · ")}
            </span>
          </div>
          <p className="mt-1 ui-meta text-text-faint">{t("views.homeView.summary")}</p>
        </div>
        {addProject.available ? (
          <Button testId="home-add-project" disabled={addProject.busy} onClick={addProject.add}>
            {addProject.busy ? t("views.homeView.actionAdding") : t("views.homeView.actionAdd")}
          </Button>
        ) : null}
      </header>
      {addProject.notice === null ? null : (
        <p
          className={`border-b border-border px-4 py-2 ui-meta ${
            addProject.notice.tone === "bad" ? "text-status-blocked" : "text-status-done"
          }`}
          data-testid="home-add-notice"
        >
          {addProject.notice.text}
        </p>
      )}
      {repos.length === 0 ? (
        <p className="px-4 py-3 ui-meta text-text-faint" data-testid="home-empty">
          {t("views.homeView.empty")}
        </p>
      ) : (
        <div data-testid="home-content" className="flex flex-col gap-6 p-4">
          {(["attention", "open", "disabled"] satisfies ProjectGroupId[]).map((group) =>
            groups[group].length === 0 ? null : (
              <div key={group} data-testid={`home-group-${group}`} className="flex flex-col">
                <Region
                  title={t(GROUP_TITLE[group])}
                  big={groups[group].length}
                  bigTone={group === "attention" ? attentionTone : undefined}
                  edge={group === "attention" ? attentionTone : undefined}
                >
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,32rem),1fr))] gap-x-4">
                    {groups[group].map((repo) => (
                      <ProjectEntry
                        key={repo.repoId}
                        repo={repo}
                        read={readOf(repo)}
                        isCurrent={repo.repoId === currentRepoId}
                        canManage={canManage}
                        onOpen={onOpenProject}
                      />
                    ))}
                  </div>
                </Region>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
