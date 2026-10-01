import { PinButton } from "./PinButton.tsx";
import { TitleText } from "./primitives/TitleText.tsx";
import { useEffect, useRef, useState } from "react";
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
import { guiHostBridge } from "../gui-transport.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";

export interface AppSidebarProps {
  readonly project: Project;
  readonly repos: readonly SystemRepoRow[];
  readonly activeRepoId: string | null;
  readonly view: ViewId;
  /** 任务详情占用主区时导航不点亮任何一项(与旧 App.tsx 判定一致)。 */
  readonly hasSelection: boolean;
  /** 待办签发总池的待办角标(决策待裁 + 门禁待签 + 收口待同意 + 阻断待特批)。 */
  readonly poolBadgeCount: number | undefined;
  readonly projectSwitcherOpen: boolean;
  readonly onProjectSwitcherToggle: () => void;
  readonly onOpenProject: (repoId: string) => void;
  readonly onOpenProjectManager: () => void;
  readonly onNavigate: (view: ViewId) => void;
  readonly pinnedWork: readonly { readonly taskId: string; readonly title: string }[];
  /** 置顶项的打开位:App 按「根任务即工作」分流到工作页或任务详情。 */
  readonly onOpenPinned: (taskId: string) => void;
  /** 解除置顶。这一段是唯一展示置顶集的地方,所以取消它的入口也只能在这里。 */
  readonly onUnpinWork: (taskId: string) => void;
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
  poolBadgeCount,
  projectSwitcherOpen,
  onProjectSwitcherToggle,
  onOpenProject,
  onOpenProjectManager,
  onNavigate,
  pinnedWork = [],
  onOpenPinned,
  onUnpinWork,
  ledgerStatus,
  onRefreshLedger,
  health,
  onOpenSystem,
}: AppSidebarProps) {
  const projectSwitcherAnchor = useRef<HTMLButtonElement>(null);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [identity, setIdentity] = useState<{ readonly authenticated: boolean; readonly personId?: string }>({
      authenticated: false,
    }),
    [bindingReady, setBindingReady] = useState(false);
  const authCandidate = guiHostBridge()?.auth,
    auth = authCandidate && typeof authCandidate.status === "function" ? authCandidate : undefined;
  const refreshIdentity = () => {
    if (!auth) return;
    void auth.status().then((value) => {
      const status = value as { readonly authenticated?: boolean; readonly personId?: string };
      setIdentity({
        authenticated: status.authenticated === true,
        ...(status.personId ? { personId: status.personId } : {}),
      });
    }, consumeKnownError);
  };
  useEffect(refreshIdentity, []);
  useEffect(() => {
    if (!auth) return;
    void auth.bindingStatus().then(
      (value) => setBindingReady((value as { readonly ready?: boolean }).ready === true),
      () => setBindingReady(false),
    );
  }, []);
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
      {/* 侧栏四块:固定顶部(品牌行 + 项目切换)、固定的置顶工作、导航(唯一滚动区)、固定底部。 */}
      <div data-testid="app-sidebar-head" className="shrink-0">
        <div className="titlebar-drag titlebar-traffic-top flex items-center gap-2 px-3 pt-3 pb-1">
          <span className="font-mono ui-micro font-semibold tracking-wide text-text-muted">HARNESS</span>
          <span
            title={t("components.appSidebar.localModeNotSynchronizedV2MultiTerminal")}
            className={`inline-flex items-center gap-1 rounded border border-border px-1 py-px
              font-mono ui-micro text-text-faint`}
          >
            <CloudSlash weight="bold" />
            {t("components.appSidebar.local")}
          </span>
          <div className="titlebar-no-drag ml-auto">
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
      </div>

      {/* 置顶工作块:高度按侧栏比例封顶(不写死像素),块内滚动;不随导航滚动,也不把导航挤走。 */}
      <div data-testid="app-sidebar-pinned" className="flex max-h-[30%] shrink-0 flex-col border-b border-border">
        {pinnedWork.length ? (
          <div className="flex min-h-0 flex-col px-2 pb-2" data-testid="sidebar-pinned-work">
            <button
              type="button"
              data-testid="sidebar-pinned-toggle"
              aria-expanded={pinnedOpen}
              onClick={() => setPinnedOpen((open) => !open)}
              className="flex w-full items-center gap-1 px-1 pb-1 text-left font-mono ui-meta uppercase tracking-wide text-text-faint hover:text-text-muted"
            >
              <span aria-hidden>{pinnedOpen ? "▾" : "▸"}</span>
              <span>置顶工作</span>
              <span className="ml-auto tabular-nums">{pinnedWork.length}</span>
            </button>
            {/* 块内滚动:置顶再多,这一块也不超过侧栏高度的三成。 */}
            <div data-testid="sidebar-pinned-list" className={pinnedOpen ? "min-h-0 overflow-y-auto" : "hidden"}>
              {pinnedWork.map((item) => (
                <div
                  key={item.taskId}
                  className="group flex w-full items-center gap-1 rounded pr-1 text-text-muted hover:bg-surface-raised hover:text-text"
                >
                  <button
                    type="button"
                    onClick={() => onOpenPinned(item.taskId)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                  >
                    <span aria-hidden>◆</span>
                    <span className="truncate">
                      <TitleText title={item.title} />
                    </span>
                  </button>
                  <PinButton
                    testId={`sidebar-unpin-${item.taskId}`}
                    onClick={() => onUnpinWork(item.taskId)}
                    pinned
                    compact
                    label={`解除置顶:${item.title}`}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* 导航滚动区:侧栏唯一纵向滚动容器;窗口够高时不出现滚动条。 */}
      <div data-testid="app-sidebar-scroll" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
                  badge={item.id === "decisionPool" ? poolBadgeCount : undefined}
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
          disabled={!auth || (!identity.authenticated && !bindingReady)}
          title={
            identity.authenticated
              ? t("identityAccess.signOut")
              : bindingReady
                ? t("identityAccess.signIn")
                : t("identityAccess.signInDisabled")
          }
          onClick={() => {
            if (!auth) return;
            void (identity.authenticated ? auth.logout() : auth.login()).then(refreshIdentity, consumeKnownError);
          }}
          className="flex w-full items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-70"
        >
          <span
            className={`grid size-6 shrink-0 place-items-center rounded-full bg-surface-raised
              font-mono ui-micro font-semibold text-text-muted`}
          >
            {identity.authenticated ? (identity.personId?.slice(0, 1).toUpperCase() ?? "K") : "?"}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs text-text">
              {identity.authenticated ? identity.personId : t("identityAccess.signedOut")}
            </span>
            <span className="block truncate ui-micro text-text-faint">
              {identity.authenticated ? t("identityAccess.keycloakIdentity") : t("identityAccess.signIn")}
            </span>
          </span>
        </button>
      </div>
    </aside>
  );
}
