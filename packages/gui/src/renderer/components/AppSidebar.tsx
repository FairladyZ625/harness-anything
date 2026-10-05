import { TitleText } from "./primitives/TitleText.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { FolderSimple, CaretUpDown, CloudSlash, PushPinSlash } from "@phosphor-icons/react";
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
import { useWorkIndexQuery } from "../task-data.ts";
import { workIndexOf } from "../model/work-collections.ts";

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
  /** 全部置顶任务(App 从议程读面取);侧栏只展示其中的工作根,其余在总览置顶区。 */
  readonly pinnedWork: readonly { readonly taskId: string; readonly title: string }[];
  /** 置顶项的打开位:App 按「根任务即工作」分流到工作页或任务详情。 */
  readonly onOpenPinned: (taskId: string) => void;
  /** 解除置顶(pin 写通道)。侧栏置顶块与总览置顶区各自带取消入口。 */
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
  const identityTarget = useRef(activeRepoId);
  identityTarget.current = activeRepoId;
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [identity, setIdentity] = useState<{ readonly authenticated: boolean; readonly personId?: string }>({
    authenticated: false,
  });
  const authCandidate = guiHostBridge()?.auth,
    auth = authCandidate && typeof authCandidate.status === "function" ? authCandidate : undefined;
  const refreshIdentity = () => {
    if (!auth) return;
    void auth.status(activeRepoId ?? undefined).then((value) => {
      if (identityTarget.current !== activeRepoId) return;
      const status = value as { readonly authenticated?: boolean; readonly personId?: string };
      setIdentity({
        authenticated: status.authenticated === true,
        ...(status.personId ? { personId: status.personId } : {}),
      });
    }, consumeKnownError);
  };
  useEffect(() => {
    setIdentity({ authenticated: false });
    refreshIdentity();
  }, [activeRepoId]);
  useEffect(() => {
    window.addEventListener("harness-auth-changed", refreshIdentity);
    return () => window.removeEventListener("harness-auth-changed", refreshIdentity);
  }, [activeRepoId]);
  // 当前仓的模式徽标与端点(PLT-EdgeGUI-W3,设计稿 §3.4):端点来自连接表,
  // local 仓挂在隐含本机连接下、无端点,不显示端点行。
  const activeRepo = repos.find((repo) => repo.repoId === activeRepoId) ?? null,
    connections = useConnectionsQuery().data ?? [],
    endpoint = activeRepo
      ? connections.find((connection) => connection.id === activeRepo.connectionId)?.endpoint
      : undefined;
  // 舰队专用入口(如协作页)在选中任一仓库时显示:本地仓也是舰队中心
  // (业主 2026-10-05 裁定,中心机器要看协作大盘),不再按模式隐藏;
  // 未选中仓(home)没有仓库视角,同样不显示。
  const navGroups =
    activeRepo === null
      ? NAV_GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => item.fleetOnly !== true) }))
      : NAV_GROUPS;
  // 置顶块只列工作根:App 传入的是全部置顶任务,这里按 daemon 工作索引
  // (repo.works.index,与总览同一读面、同一 react-query 缓存)筛出「本身是一个工作」
  // 的行;其余置顶任务的去处是总览的置顶区。索引未落地时一块不出现(判不了工作根
  // 就不猜),落地后随台账切面换代一起刷新。
  const worksQuery = useWorkIndexQuery(activeRepoId);
  const workIndex = useMemo(() => workIndexOf(worksQuery.data), [worksQuery.data]);
  const pinnedWorks = useMemo(
    () => pinnedWork.filter((item) => workIndex.isWorkRoot(item.taskId)),
    [pinnedWork, workIndex],
  );
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

      {/* 置顶工作块:只列置顶的工作根(判据来自 daemon 工作索引,不在 GUI 沿父链推);
          最多露 5 行、超出在块内滚动,滚动容器按整行高度取整,任何时候不裁半行
          (2026-10-01 业主:只有工作能单独拎出来,限 5 个)。没有置顶的工作时整块不出现。 */}
      {pinnedWorks.length ? (
        <div
          data-testid="app-sidebar-pinned"
          className="flex shrink-0 flex-col border-b border-border [--pinned-row:2.25rem]"
        >
          <div className="flex min-h-0 flex-col px-2 pb-2" data-testid="sidebar-pinned-work">
            <button
              type="button"
              data-testid="sidebar-pinned-toggle"
              aria-expanded={pinnedOpen}
              onClick={() => setPinnedOpen((open) => !open)}
              className="flex w-full items-center gap-1 px-1 pb-1 text-left font-mono ui-meta uppercase tracking-wide text-text-faint hover:text-text-muted"
            >
              <span aria-hidden>{pinnedOpen ? "▾" : "▸"}</span>
              <span>{t("components.appSidebar.pinnedWorkTitle")}</span>
              <span className="ml-auto tabular-nums">{pinnedWorks.length}</span>
            </button>
            {/* 限高 5 行 = 5 × 整行高度(同一处定义行高与上限,行高变了上限跟着变);
                行高固定 + 上限取整 → 滚动容器任何静止时刻都露整行;snap 让滚动停在行界。 */}
            <div
              data-testid="sidebar-pinned-list"
              className={
                pinnedOpen ? "max-h-[calc(var(--pinned-row)*5)] snap-y snap-mandatory overflow-y-auto" : "hidden"
              }
            >
              {pinnedWorks.map((item) => (
                <div
                  key={item.taskId}
                  className="group flex h-[var(--pinned-row)] w-full snap-start items-center gap-1 rounded pr-1 text-text-muted hover:bg-surface-raised hover:text-text"
                >
                  <button
                    type="button"
                    onClick={() => onOpenPinned(item.taskId)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left ui-body"
                  >
                    <span aria-hidden>◆</span>
                    <span className="truncate">
                      <TitleText title={item.title} />
                    </span>
                  </button>
                  {/* 无边框小图标,只在该行悬停或键盘聚焦时出现,平时不占视觉
                      (评审第 6 条:一列带边框的方块是全页最抢眼的重复图形)。 */}
                  <button
                    type="button"
                    data-testid={`sidebar-unpin-${item.taskId}`}
                    onClick={() => onUnpinWork(item.taskId)}
                    aria-label={t("components.appSidebar.unpinWorkLabel", { title: item.title })}
                    title={t("components.appSidebar.unpinWorkLabel", { title: item.title })}
                    className="grid size-6 shrink-0 place-items-center rounded text-text-faint opacity-0
                      transition-opacity hover:bg-surface-raised hover:text-text
                      group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                  >
                    <PushPinSlash weight="bold" className="size-3.5" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* 导航滚动区:侧栏唯一纵向滚动容器;窗口够高时不出现滚动条。 */}
      <div data-testid="app-sidebar-scroll" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {navGroups.map((group, groupIndex) => (
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
          data-testid="sidebar-account"
          title={t("identityAccess.title")}
          onClick={() => onNavigate("identityAccess")}
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
