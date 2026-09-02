import { useRef } from "react";
import { FolderSimple, CaretUpDown, CloudSlash } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../api-client.ts";
import type { Project } from "../model/types.ts";
import type { RuntimeHealth } from "../model/runtime-health.ts";
import type { ViewId } from "../navigation/viewHistory.ts";
import { NAV_GROUPS, navLabel } from "../navigation/navConfig.tsx";
import { NavButton, ThemeToggle } from "./shell-chrome.tsx";
import { QuickSwitcher } from "./sidebar/QuickSwitcher.tsx";
import { SystemStatusPanel, type LedgerStatusBarInput } from "./sidebar/SystemStatusPanel.tsx";
import { useConnectionsQuery } from "../connection-data.ts";
import { RepoModeBadge } from "./RepoModeBadge.tsx";
import { t } from "../i18n/index.tsx";

export interface AppSidebarProps {
  readonly project: Project;
  readonly repos: readonly SystemRepoRow[];
  readonly activeRepoId: string | null;
  readonly view: ViewId;
  /** 任务详情占用主区时导航不点亮任何一项(与旧 App.tsx 判定一致)。 */
  readonly hasSelection: boolean;
  readonly inboxCount: number | undefined;
  readonly projectSwitcherOpen: boolean;
  readonly onProjectSwitcherToggle: () => void;
  readonly onOpenProject: (repoId: string) => void;
  readonly onOpenProjectManager: () => void;
  readonly onNavigate: (view: ViewId) => void;
  readonly ledgerStatus: LedgerStatusBarInput;
  readonly onRefreshLedger: () => void;
  readonly health: RuntimeHealth;
  readonly onOpenSystem: () => void;
}

/**
 * 左侧栏外壳。2026-08-31 泽宇反馈两条缺陷的结构修复:
 *
 * 1)矮窗口重叠/无滚动 —— 旧实现是 `<aside class="… md:overflow-visible">` 把全部内容
 *   直接铺开,侧栏内容高(≈830px:四组 15 个导航项 + 分组标题 + 项目切换器)超过
 *   720px minHeight 时既不裁切也不滚动,溢出压到主区,导航文字叠在分组标题上。
 *   现在 aside 只做 `flex-col overflow-hidden`,导航区包进唯一的纵向滚动容器
 *   (`min-h-0 flex-1 overflow-y-auto`),任何窗口高度下导航项不重叠、滚动可达全部项。
 * 2)系统运行区收纳 —— 原左上角事件刷新条与总览「运行时健康」区块合并为左下角
 *   `SystemStatusPanel`(账号区之上),与账号区一起固定在底部,不随导航滚动,
 *   也不与滚动区形成嵌套双滚动条(底部是 shrink-0,不产生自己的滚动)。
 */
export function AppSidebar({
  project,
  repos,
  activeRepoId,
  view,
  hasSelection,
  inboxCount,
  projectSwitcherOpen,
  onProjectSwitcherToggle,
  onOpenProject,
  onOpenProjectManager,
  onNavigate,
  ledgerStatus,
  onRefreshLedger,
  health,
  onOpenSystem,
}: AppSidebarProps) {
  const projectSwitcherAnchor = useRef<HTMLButtonElement>(null);
  // 当前仓的模式徽标与端点(PLT-EdgeGUI-W3,设计稿 §3.4):端点来自连接表,
  // local 仓挂在隐含本机连接下、无端点,不显示端点行。
  const activeRepo = repos.find((repo) => repo.repoId === activeRepoId) ?? null,
    connections = useConnectionsQuery().data ?? [],
    endpoint = activeRepo
      ? connections.find((connection) => connection.id === activeRepo.connectionId)?.endpoint
      : undefined;
  return (
    <aside
      data-testid="app-sidebar"
      className={`flex max-h-[42dvh] w-full shrink-0 flex-col overflow-hidden border-b border-border bg-surface
        md:max-h-none md:w-56 md:border-r md:border-b-0`}
    >
      {/* 导航滚动区:侧栏唯一纵向滚动容器;窗口够高时不出现滚动条。 */}
      <div data-testid="app-sidebar-scroll" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
          <span className="font-mono ui-micro font-semibold tracking-wide text-text-muted">HARNESS</span>
          <span
            title={t("components.appSidebar.localModeNotSynchronizedV2MultiTerminal")}
            className={`inline-flex items-center gap-1 rounded border border-border px-1 py-px
              font-mono ui-micro text-text-faint`}
          >
            <CloudSlash weight="bold" />
            {t("components.appSidebar.local")}
          </span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>

        <div className="px-3 pt-2 pb-2">
          <div className="relative">
            <button
              ref={projectSwitcherAnchor}
              onClick={onProjectSwitcherToggle}
              title={t("components.appSidebar.quicklySwitchProjects")}
              className={`flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left text-sm
              font-medium hover:border-border-strong ${
                projectSwitcherOpen || view === "home"
                  ? "border-border-strong bg-surface-raised"
                  : "border-border bg-surface-raised"
              }`}
            >
              <FolderSimple weight="duotone" className="shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate">{project.name}</span>
                  {activeRepo ? <RepoModeBadge mode={activeRepo.mode} /> : null}
                </span>
                <span className="block truncate font-mono ui-micro text-text-faint">
                  {endpoint ? `${project.preset} · ${endpoint}` : project.preset}
                </span>
              </span>
              <CaretUpDown weight="bold" className="shrink-0 text-text-faint" />
            </button>

            <QuickSwitcher
              open={projectSwitcherOpen}
              anchorRef={projectSwitcherAnchor}
              repos={repos}
              activeRepoId={activeRepoId}
              onOpenProject={onOpenProject}
              onOpenProjectManager={onOpenProjectManager}
            />
          </div>
        </div>

        {NAV_GROUPS.map((group, groupIndex) => (
          <div key={group.id}>
            <div
              className={`px-3 font-mono ui-meta uppercase tracking-wide text-text-faint
                ${groupIndex === 0 ? "pt-1 pb-1" : "pt-3 pb-1"}`}
            >
              {t(group.labelKey)}
            </div>
            <nav className="flex gap-1 overflow-x-auto px-2 pb-1 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
              {group.items.map((item) => (
                <NavButton
                  key={item.id}
                  active={view === item.id && !hasSelection}
                  onClick={() => onNavigate(item.id)}
                  icon={item.icon}
                  label={navLabel(item.id)}
                  badge={item.id === "decisions" ? inboxCount : undefined}
                />
              ))}
            </nav>
          </div>
        ))}
      </div>

      {/* 固定底部:系统运行区 + 账号区。shrink-0,不随导航滚动,也不与滚动区嵌套。 */}
      <SystemStatusPanel
        status={ledgerStatus}
        health={health}
        onRefresh={onRefreshLedger}
        onOpenSystem={onOpenSystem}
      />
      <div className="hidden shrink-0 border-t border-border px-3 py-2.5 md:block">
        <button
          disabled
          title={t("components.appSidebar.v2PreviewAfterLoggingYourAccountYou")}
          className="flex w-full cursor-not-allowed items-center gap-2 text-left opacity-70"
        >
          <span
            className={`grid size-6 shrink-0 place-items-center rounded-full bg-surface-raised
              font-mono ui-micro font-semibold text-text-muted`}
          >
            Z
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs text-text">{t("components.appSidebar.localMode2")}</span>
            <span className="block truncate ui-micro text-text-faint">
              {t("components.appSidebar.accountSynchronizationV2")}
            </span>
          </span>
        </button>
      </div>
    </aside>
  );
}
