import {
  FolderSimple,
  CaretUpDown,
  CloudSlash,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Project, TaskRow } from "../model/types.ts";
import type { UseQueryResult } from "@tanstack/react-query";
import { ThemeToggle, NavButton, ProjectSummary } from "./shell-chrome.tsx";
import {
  WORKSPACE_NAV,
  MANAGE_NAV,
  type ViewId,
} from "../shell-config.tsx";

/**
 * AppShell 侧边栏:项目标识 + 台账桥状态 + 项目切换器 + 工作区/管理导航。
 *
 * 从 App.tsx 抽出(历史栈任务的前置拆分)。纯展示:所有状态与回调由 AppShell
 * 通过 props 注入,本组件不持有任何应用位置态。
 */
interface AppSidebarProps {
  view: ViewId;
  selected: TaskRow | null;
  tasksQuery: UseQueryResult;
  projectTasks: TaskRow[];
  activeCount: number;
  project: Project;
  projects: Project[];
  projectId: string;
  tasks: TaskRow[];
  projectSwitcherOpen: boolean;
  onProjectSwitcherToggle: () => void;
  /** 「管理全部」入口:关闭切换器 + 导航到 home。 */
  onManageAll: () => void;
  openProject: () => void;
  goto: (v: ViewId) => void;
  inboxCount: number;
}

export function AppSidebar({
  view,
  selected,
  tasksQuery,
  projectTasks,
  activeCount,
  project,
  projects,
  projectId,
  tasks,
  projectSwitcherOpen,
  onProjectSwitcherToggle,
  onManageAll,
  openProject,
  goto,
  inboxCount,
}: AppSidebarProps) {
  return (
    <aside className="flex max-h-[42dvh] w-full shrink-0 flex-col overflow-y-auto border-b border-border bg-surface md:max-h-none md:w-56 md:overflow-visible md:border-r md:border-b-0">
      <div className="flex items-center gap-2 px-3 pt-3 pb-1">
        <span className="font-mono text-[11px] font-semibold tracking-wide text-text-muted">
          HARNESS
        </span>
        <span
          title="本地模式 · 未同步（V2：多端同步）"
          className="inline-flex items-center gap-1 rounded border border-border px-1 py-px font-mono text-[10px] text-text-faint"
        >
          <CloudSlash weight="bold" />
          本地
        </span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>

      <div className="px-3 pb-1">
        {tasksQuery.isSuccess ? (
          projectTasks.length > 0 ? (
            <span
              data-testid="real-task-summary"
              className="block font-mono text-[11px] text-text-faint"
            >
              Active work · {activeCount} of {projectTasks.length} tasks
            </span>
          ) : (
            <span
              data-testid="task-empty-state"
              className="block font-mono text-[11px] text-text-faint"
            >
              No task rows available from the local task bridge
            </span>
          )
        ) : tasksQuery.isError ? (
          <span className="block font-mono text-[11px] text-status-blocked">
            台账桥读取失败
          </span>
        ) : (
          <span className="block font-mono text-[11px] text-text-faint">
            读取本地台账…
          </span>
        )}
      </div>

      <div className="px-3 pt-2 pb-2">
        <div className="relative">
          <button
            onClick={onProjectSwitcherToggle}
            title="快速切换项目"
            className={`flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left text-sm font-medium hover:border-border-strong ${
              projectSwitcherOpen || view === "home"
                ? "border-border-strong bg-surface-raised"
                : "border-border bg-surface-raised"
            }`}
          >
            <FolderSimple weight="duotone" className="shrink-0 text-text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{project.name}</span>
              <span className="block truncate font-mono text-[11px] text-text-faint">
                {project.preset}
              </span>
            </span>
            <CaretUpDown weight="bold" className="shrink-0 text-text-faint" />
          </button>

          {projectSwitcherOpen && (
            <div className="absolute left-0 right-0 z-30 mt-2 rounded-lg border border-border-strong bg-surface-raised p-2 shadow-2xl shadow-black/35 md:right-auto md:w-[320px]">
              <div className="flex items-center justify-between px-1 pb-2">
                <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                  快速切换
                </span>
                <span className="font-mono text-[11px] text-text-faint">
                  {projects.length} projects
                </span>
              </div>
              <div className="flex max-h-[330px] flex-col gap-1.5 overflow-y-auto">
                {projects.map((p) => (
                  <ProjectSummary
                    key={p.id}
                    project={p}
                    tasks={tasks}
                    active={p.id === projectId}
                    onOpen={openProject}
                  />
                ))}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-border pt-2">
                <button
                  onClick={onManageAll}
                  className="rounded-md border border-border px-2 py-1.5 text-left text-[12px] font-medium text-text-muted hover:border-border-strong hover:text-text"
                >
                  管理全部
                </button>
                <button
                  disabled
                  className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-[12px] text-text-faint opacity-70"
                >
                  <WarningCircle weight="bold" />
                  本地模式
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="px-3 pt-1 pb-1 font-mono text-[12px] uppercase tracking-wide text-text-faint">
        工作区
      </div>
      <nav className="flex gap-1 overflow-x-auto px-2 pb-1 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
        {WORKSPACE_NAV.map((item) => (
          <NavButton
            key={item.id}
            active={view === item.id && !selected}
            onClick={() => goto(item.id)}
            icon={item.icon}
            label={item.label}
            badge={item.id === "decisions" ? inboxCount : undefined}
            isNew={item.isNew}
          />
        ))}
      </nav>

      <div className="px-3 pt-3 pb-1 font-mono text-[12px] uppercase tracking-wide text-text-faint">
        管理
      </div>
      <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
        {MANAGE_NAV.map((item) => (
          <NavButton
            key={item.id}
            active={view === item.id && !selected}
            onClick={() => goto(item.id)}
            icon={item.icon}
            label={item.label}
          />
        ))}
      </nav>

      <div className="mt-auto hidden border-t border-border px-3 py-2.5 md:block">
        <button
          disabled
          title="V2 预览：账号登录后可多设备同步、远程访问项目"
          className="flex w-full cursor-not-allowed items-center gap-2 text-left opacity-70"
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-raised font-mono text-[11px] font-semibold text-text-muted">
            Z
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs text-text">本地模式</span>
            <span className="block truncate text-[10px] text-text-faint">
              账号与同步 · V2
            </span>
          </span>
        </button>
      </div>
    </aside>
  );
}
