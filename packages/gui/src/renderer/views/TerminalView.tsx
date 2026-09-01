import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DockviewApi } from "dockview-react";
import type { TerminalSessionRow } from "../../../../daemon/src/gui-s3-control.ts";
import {
  closeTerminalTab,
  mostRecentAttachableTerminal,
  reconcileTerminalGeneration,
  reduceTerminalStream,
  requestTerminalTermination,
  type TerminalTab,
} from "../terminal-model.ts";
import {
  terminalClient,
  terminalQueryKeys,
  type TerminalAttachInitial,
  type TerminalSpawnInput,
} from "../terminal-client.ts";
import {
  readTerminalPreferences,
  writeTerminalPreferences,
  type TerminalPreferences,
} from "../terminal-preferences.ts";
import {
  groupPaneRefs,
  gridPaneRefs,
  layoutSessionIds,
  readTerminalLayout,
  writeTerminalLayout,
  type TerminalGridSnapshot,
  type TerminalGroupLayout,
} from "../terminal-layout.ts";
import { directionalPane, type PaneBox, type PaneDirection } from "../terminal-pane-focus.ts";
import { terminalLinkTargetOf, type TerminalLinkMatch } from "../components/terminal/terminal-links.ts";
import {
  TerminalChrome,
  type TerminalSpawnDraft,
  type TerminalTabChip,
} from "../components/terminal/TerminalChrome.tsx";
import { TerminalSplitGrid, terminalPaneComponent } from "../components/terminal/TerminalSplitGrid.tsx";
import {
  TerminalPaneContext,
  type TerminalPaneActions,
  type TerminalSplitDirection,
} from "../components/terminal/terminal-pane-context.ts";
import { t } from "../i18n/index.tsx";

/**
 * 终端一等页面(PLT-TerminalWorkspace W0 + W1)。
 *
 * W0 语义不变:多 tab、快速新建、attach 已有会话、断线重连(generation 对账)、gap 提示、
 * exit 只读、tmux/direct-pty 双后端;进入页面 = 打开终端面,离开页面(或切仓)= 停止全部流
 * 并 detach 全部附件。会话状态机仍是 terminal-model,传输仍是 terminal-client。
 *
 * W1 在其上加二级模型(抄 VS Code):**tab = group**,group 内才是 split pane 树。
 * pane 树由 dockview 承载(见 TerminalSplitGrid),布局快照按仓存 localStorage,重启后
 * 按 pane 载荷里的 sessionId 逐个 re-attach,会话已消失的 pane 渲染可关闭占位。每个 pane
 * 自带 ResizeObserver + fit,cols/rows 各自走既有 resize 通道上报,互不干扰。
 *
 * W2 链接:pane 里的 URL/仓库路径/实体 id 可点(识别见 components/terminal/terminal-links.ts)。
 * 实体经 onNavigateEntity 推栈可回撤;文档经 onOpenDocument 落既有预览浮层;URL 走
 * openUrl 接缝(缺省 web-links 默认行为)。
 */
interface Props {
  readonly repoId: string;
  readonly daemonGeneration: number | null;
  readonly tasks: readonly { readonly taskId: string; readonly title: string }[];
  /** 仓库(canonical)根绝对路径;相对路径链接的解析基座(其次才用会话 cwd)。 */
  readonly repoRoot: string | null;
  /** 实体链接出口(App 的 navigateToEntity:详情页推栈,回撤原路返回终端页)。 */
  readonly onNavigateEntity: (ref: string) => void;
  /** 文档链接出口(App 的本机文档预览浮层;存在性由只读桥在打开时校验)。 */
  readonly onOpenDocument: (path: string) => void;
  /** URL 打开接缝(W3 内嵌浏览器接线点);缺省走 web-links 默认行为(新窗口)。 */
  readonly openUrl?: (uri: string) => void;
}
type AttachRow = Pick<
  TerminalSessionRow,
  | "sessionId"
  | "name"
  | "status"
  | "outputSeq"
  | "cwd"
  | "requestedBackend"
  | "backend"
  | "durability"
  | "warning"
  | "attachable"
>;
/** 新会话的落位:开新 tab(group),还是在当前 group 里从某个 pane 分割出来。 */
type Placement =
  | { readonly kind: "group" }
  | { readonly kind: "split"; readonly referencePanelId: string; readonly direction: TerminalSplitDirection };

export function TerminalView({
  repoId,
  daemonGeneration,
  tasks,
  repoRoot,
  onNavigateEntity,
  onOpenDocument,
  openUrl,
}: Props) {
  const queryClient = useQueryClient(),
    [tabs, setTabs] = useState<readonly TerminalTab[]>([]),
    [groups, setGroups] = useState<readonly TerminalGroupLayout[]>([]),
    [activeGroupId, setActiveGroupId] = useState<string | null>(null),
    [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  const tabsRef = useRef(tabs),
    groupsRef = useRef(groups),
    focusedPanelIdRef = useRef(focusedPanelId),
    gridApi = useRef<DockviewApi | null>(null),
    regionRef = useRef<HTMLDivElement>(null),
    stops = useRef(new Map<string, () => void>()),
    repoIdRef = useRef(repoId),
    repoRootRef = useRef(repoRoot),
    onNavigateEntityRef = useRef(onNavigateEntity),
    onOpenDocumentRef = useRef(onOpenDocument),
    mountedRef = useRef(true);
  repoRootRef.current = repoRoot;
  onNavigateEntityRef.current = onNavigateEntity;
  onOpenDocumentRef.current = onOpenDocument;
  const ackSeq = useRef(new Map<string, number>()),
    inflight = useRef(new Map<string, Promise<void>>());
  const initialised = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null),
    [confirmId, setConfirmId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<TerminalPreferences>(() =>
    readTerminalPreferences(window.localStorage),
  );
  const [spawn, setSpawn] = useState<TerminalSpawnDraft>({
    name: t("terminal.view.title"),
    cwdScope: "repo-root",
    path: "",
    shellProfileId: "default",
    taskId: "",
  });
  const sessions = useQuery({
    queryKey: terminalQueryKeys.sessions(repoId),
    queryFn: () => terminalClient.list(repoId),
    enabled: repoId !== "unselected",
    staleTime: 1_000,
  });
  const generation = daemonGeneration ?? sessions.data?.daemonGeneration;
  tabsRef.current = tabs;
  groupsRef.current = groups;
  focusedPanelIdRef.current = focusedPanelId;
  useEffect(() => {
    writeTerminalPreferences(window.localStorage, preferences);
  }, [preferences]);
  // 布局只在该仓已完成一次恢复之后才回写,否则切仓瞬间的空布局会覆盖新仓的存档。
  useEffect(() => {
    if (repoId === "unselected" || !initialised.current.has(repoId)) return;
    writeTerminalLayout(window.localStorage, repoId, { activeGroupId, groups });
  }, [activeGroupId, groups, repoId]);

  /** 离开页面/切仓:停止全部流并 detach 全部附件;tab/pane 布局随页面状态一并清空。 */
  const releaseTabs = useCallback(async (detachRepoId: string): Promise<void> => {
    const current = [...tabsRef.current];
    for (const stop of stops.current.values()) stop();
    stops.current.clear();
    setTabs([]);
    setGroups([]);
    setActiveGroupId(null);
    setFocusedPanelId(null);
    await Promise.all(
      current.flatMap((tab) =>
        tab.attachmentId
          ? [terminalClient.detach(detachRepoId, tab.sessionId, tab.attachmentId).catch(consumeKnownError)]
          : [],
      ),
    );
  }, []);
  useEffect(
    () => () => {
      mountedRef.current = false;
      void releaseTabs(repoIdRef.current);
    },
    [releaseTabs],
  );
  // 仓内 session 全部按 repoId 限定:切仓而页面未卸载时,旧仓 tab 必须先释放,
  // 否则后续 input/resize 会以新 repoId 打到旧仓 session 上。
  useEffect(() => {
    if (repoIdRef.current === repoId) return;
    const previous = repoIdRef.current;
    repoIdRef.current = repoId;
    initialised.current.delete(previous);
    void releaseTabs(previous);
  }, [repoId, releaseTabs]);

  /** 只接会话流,不管落位;布局恢复走这条,不会给已有 pane 再造一个。 */
  const attachStream = useCallback(
    (row: AttachRow, afterSeq: number) => {
      stops.current.get(row.sessionId)?.();
      setTabs((current) => {
        const found = current.find((tab) => tab.sessionId === row.sessionId);
        const next = tabFromRow(row, generation ?? 0, found, afterSeq);
        return found ? current.map((tab) => (tab.sessionId === row.sessionId ? next : tab)) : [...current, next];
      });
      setError(null);
      try {
        const stop = terminalClient.attach(repoId, row.sessionId, afterSeq, (value) =>
          setTabs((current) =>
            current.map((tab) => {
              if (tab.sessionId !== row.sessionId) return tab;
              if (!isInitial(value)) return reduceTerminalStream(tab, value);
              return {
                ...tab,
                daemonGeneration: value.daemonGeneration,
                attachmentId: value.attachmentId,
                notice: value.status === "gap" ? t("terminal.view.replayGap") : tab.notice,
              };
            }),
          ),
        );
        stops.current.set(row.sessionId, stop);
      } catch (cause) {
        consumeKnownError(cause);
        setError(message(cause));
      }
    },
    [generation, repoId],
  );

  /** 把会话放进布局:开新 group,或在当前 group 内从 referencePanel 分割。 */
  const placeSession = useCallback((sessionId: string, placement: Placement) => {
    const existing = paneOfSession(groupsRef.current, sessionId);
    if (existing) {
      setActiveGroupId(existing.groupId);
      setFocusedPanelId(existing.panelId);
      return;
    }
    const panelId = `pane-${crypto.randomUUID()}`;
    const api = gridApi.current;
    if (placement.kind === "split" && api?.getPanel(placement.referencePanelId)) {
      api.addPanel({
        id: panelId,
        component: terminalPaneComponent,
        params: { sessionId },
        position: { referencePanel: placement.referencePanelId, direction: placement.direction },
      });
      setFocusedPanelId(panelId);
      return;
    }
    const groupId = `group-${crypto.randomUUID()}`;
    const next = [...groupsRef.current, { groupId, seeds: [{ panelId, sessionId }], grid: null }];
    groupsRef.current = next;
    setGroups(next);
    setActiveGroupId(groupId);
    setFocusedPanelId(panelId);
  }, []);

  const attach = useCallback(
    (row: AttachRow, afterSeq = 0, placement: Placement = { kind: "group" }) => {
      if (!row.attachable || row.status !== "running") {
        setError(t("terminal.view.sessionNotAttachable"));
        return;
      }
      attachStream(row, afterSeq);
      placeSession(row.sessionId, placement);
    },
    [attachStream, placeSession],
  );

  const start = useCallback(
    async (custom: boolean, placement: Placement = { kind: "group" }) => {
      setError(null);
      const cwd: TerminalSpawnInput["cwd"] =
        custom && spawn.cwdScope === "repo-relative"
          ? { scope: "repo-relative", path: spawn.path }
          : { scope: "repo-root" };
      const name = custom ? spawn.name : t("terminal.view.title");
      try {
        const receipt = await terminalClient.spawn(repoId, {
          idempotencyKey: `terminal-gui-${crypto.randomUUID()}`,
          backend: preferences.backend,
          name: name || undefined,
          cwd,
          shellProfileId: custom ? spawn.shellProfileId || undefined : "default",
          taskId: custom ? spawn.taskId || undefined : undefined,
        });
        if (receipt.outcome !== "applied" || !receipt.sessionId)
          throw new Error(
            typeof receipt.error?.hint === "string"
              ? receipt.error.hint
              : t("terminal.view.spawnRejected", { operationId: receipt.operationId }),
          );
        // spawn 往返期间页面可能已离开/切仓:此时不再 attach(会话在 daemon 侧仍持久,
        // 重新进页时由自动附加路径接回),避免给已卸载的壳留下无主流/附件。
        if (!mountedRef.current || repoIdRef.current !== repoId) return;
        const listed = await terminalClient.list(repoId);
        queryClient.setQueryData(terminalQueryKeys.sessions(repoId), listed);
        const row = listed.sessions.find((item) => item.sessionId === receipt.sessionId);
        if (!row) throw new Error(t("terminal.view.spawnMissing"));
        attach(row, 0, placement);
      } catch (cause) {
        consumeKnownError(cause);
        setError(message(cause));
      }
    },
    [attach, preferences.backend, queryClient, repoId, spawn],
  );

  useEffect(() => {
    if (generation !== null && generation !== undefined)
      setTabs((current) => reconcileTerminalGeneration(current, generation));
  }, [generation]);
  // 进页(或换仓后首次拿到会话表)的恢复入口:优先按存档的 pane 树恢复,
  // 存档里的会话逐个 re-attach;没有存档时退回 W0 的「附加最近会话 / 新建」。
  useEffect(() => {
    const shouldSkip =
      repoId === "unselected" || !sessions.isSuccess || groupsRef.current.length > 0 || initialised.current.has(repoId);
    if (shouldSkip) return;
    initialised.current.add(repoId);
    const stored = readTerminalLayout(window.localStorage, repoId);
    if (stored.groups.length > 0) {
      setGroups(stored.groups);
      groupsRef.current = stored.groups;
      setActiveGroupId(stored.activeGroupId);
      for (const sessionId of layoutSessionIds(stored)) {
        const row = sessions.data.sessions.find((item) => item.sessionId === sessionId);
        if (row?.attachable && row.status === "running") attachStream(row, 0);
      }
      return;
    }
    const restored = mostRecentAttachableTerminal(sessions.data.sessions);
    if (restored) attach(restored, 0);
    else void start(false);
  }, [attach, attachStream, repoId, sessions.data, sessions.isSuccess, start]);

  const create = (event: FormEvent) => {
    event.preventDefault();
    void start(true);
  };
  /** 只关会话(停流 + detach + 移出 tab 表),不动布局。 */
  const closeSession = useCallback(
    async (tab: TerminalTab) => {
      try {
        await closeTerminalTab(repoId, tab, {
          stopStream: stops.current.get(tab.sessionId) ?? (() => undefined),
          detach: terminalClient.detach,
        });
      } catch (cause) {
        consumeKnownError(cause);
        setError(message(cause));
      }
      stops.current.delete(tab.sessionId);
      setTabs((current) => current.filter((item) => item.sessionId !== tab.sessionId));
    },
    [repoId],
  );
  const dropGroup = useCallback((groupId: string) => {
    const remaining = groupsRef.current.filter((group) => group.groupId !== groupId);
    groupsRef.current = remaining;
    setGroups(remaining);
    setActiveGroupId((current) => (current === groupId ? (remaining[remaining.length - 1]?.groupId ?? null) : current));
  }, []);
  const closeGroup = useCallback(
    async (groupId: string) => {
      const group = groupsRef.current.find(({ groupId: id }) => id === groupId);
      const refs = group ? groupPaneRefs(group) : [];
      dropGroup(groupId);
      for (const ref of refs) {
        const tab = tabsRef.current.find((item) => item.sessionId === ref.sessionId);
        if (tab) await closeSession(tab);
      }
    },
    [closeSession, dropGroup],
  );
  const closePane = useCallback(
    async (panelId: string, sessionId: string) => {
      // 最后一个 pane 关掉后 dockview 会给出空布局,group 由 onLayoutChange 一并回收。
      // 只有当前 group 是挂载着的,所以拿不到 panel 时不动布局,只把会话收掉。
      gridApi.current?.getPanel(panelId)?.api.close();
      const tab = tabsRef.current.find((item) => item.sessionId === sessionId);
      if (tab) await closeSession(tab);
    },
    [closeSession],
  );
  const send = useCallback(
    (sessionId: string, utf8: string) => {
      const tail = inflight.current.get(sessionId) ?? Promise.resolve();
      const next = tail
        .then(async () => {
          const seq = (ackSeq.current.get(sessionId) ?? 0) + 1;
          ackSeq.current.set(sessionId, await terminalClient.input(repoId, sessionId, seq, utf8));
        })
        .catch((cause: unknown) => {
          consumeKnownError(cause);
          setError(message(cause));
        });
      inflight.current.set(sessionId, next);
    },
    [repoId],
  );
  const refit = useCallback(
    (sessionId: string, cols: number, rows: number) => {
      void terminalClient.resize(repoId, sessionId, cols, rows).catch((cause: unknown) => {
        consumeKnownError(cause);
        setError(message(cause));
      });
    },
    [repoId],
  );
  const terminate = useCallback(
    async (sessionId: string) => {
      const tab = tabsRef.current.find((item) => item.sessionId === sessionId);
      if (!tab) return;
      try {
        await requestTerminalTermination(repoId, tab, true, { terminate: terminalClient.terminate });
        setTabs((current) =>
          current.map((item) =>
            item.sessionId === sessionId
              ? { ...item, state: "exited", attachable: false, notice: t("terminal.view.terminationConfirmed") }
              : item,
          ),
        );
        setConfirmId(null);
      } catch (cause) {
        consumeKnownError(cause);
        setError(message(cause));
      }
    },
    [repoId],
  );

  /** dockview 报告布局变化:快照回流到 group;空 group 直接回收。 */
  const applyGrid = useCallback(
    (groupId: string, grid: TerminalGridSnapshot) => {
      if (gridPaneRefs(grid).length === 0) {
        dropGroup(groupId);
        return;
      }
      const next = groupsRef.current.map((group) => (group.groupId === groupId ? { ...group, grid } : group));
      groupsRef.current = next;
      setGroups(next);
    },
    [dropGroup],
  );
  const splitPane = useCallback(
    (panelId: string, direction: TerminalSplitDirection) => {
      void start(false, { kind: "split", referencePanelId: panelId, direction });
    },
    [start],
  );
  const focusPane = useCallback((panelId: string) => {
    setFocusedPanelId((current) => (current === panelId ? current : panelId));
  }, []);
  /** W2 链接分发:实体 → App 实体导航(推栈);路径 → 文档预览;无基座可解析时复制原文。 */
  const openLink = useCallback((match: TerminalLinkMatch, text: string, cwd: string | null) => {
    const target = terminalLinkTargetOf(match, { repoRoot: repoRootRef.current, cwd });
    if (target === null) {
      void navigator.clipboard?.writeText(text)?.catch(consumeKnownError);
      return;
    }
    if (target.kind === "entity") onNavigateEntityRef.current(target.ref);
    else onOpenDocumentRef.current(target.path);
  }, []);
  const moveFocus = useCallback((direction: PaneDirection) => {
    const target = directionalPane(paneBoxes(regionRef.current), focusedPanelIdRef.current, direction);
    if (!target) return;
    gridApi.current?.getPanel(target)?.api.setActive();
    setFocusedPanelId(target);
    focusPaneInput(regionRef.current, target);
  }, []);

  // 分屏快捷键(与 useAppShortcuts 同一惯例:window keydown + preventDefault)。
  // Ctrl+Shift+5/6 分割,Ctrl+Shift+W 关 pane,Ctrl+Alt+方向键 移动焦点。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return;
      const arrow = arrowDirection(event.key);
      if (event.shiftKey && ["5", "%"].includes(event.key)) run(event, () => splitFocused("right"));
      else if (event.shiftKey && ["6", "^"].includes(event.key)) run(event, () => splitFocused("below"));
      else if (event.shiftKey && event.key.toLowerCase() === "w") run(event, closeFocused);
      else if (event.altKey && arrow) run(event, () => moveFocus(arrow));
    };
    const run = (event: KeyboardEvent, action: () => void) => {
      event.preventDefault();
      action();
    };
    const splitFocused = (direction: TerminalSplitDirection) => {
      const panelId = focusedPanelIdRef.current;
      if (panelId) splitPane(panelId, direction);
      else void start(false);
    };
    const closeFocused = () => {
      const panelId = focusedPanelIdRef.current;
      const sessionId = panelId ? sessionOfPane(groupsRef.current, panelId) : null;
      if (panelId && sessionId) void closePane(panelId, sessionId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePane, moveFocus, splitPane, start]);

  const activeGroup = groups.find((group) => group.groupId === activeGroupId) ?? null;
  const paneActions = useMemo<TerminalPaneActions>(
    () => ({
      session: (sessionId) => tabs.find((tab) => tab.sessionId === sessionId) ?? null,
      focusedPanelId,
      confirmSessionId: confirmId,
      setConfirmSessionId: setConfirmId,
      onInput: send,
      onFit: refit,
      onFocusPane: focusPane,
      onClosePane: (panelId, sessionId) => void closePane(panelId, sessionId),
      onSplitPane: splitPane,
      onTerminate: (sessionId) => void terminate(sessionId),
      openLink,
      openUrl: openUrl ?? null,
    }),
    [closePane, confirmId, focusPane, focusedPanelId, openLink, openUrl, refit, send, splitPane, tabs, terminate],
  );

  return (
    <section
      aria-label={t("terminal.view.title")}
      data-testid="terminal-view"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <TerminalChrome
        repoId={repoId}
        generation={generation}
        preferences={preferences}
        onPreferenceChange={(update) => setPreferences((current) => ({ ...current, ...update }))}
        chips={tabChips(groups, tabs)}
        activeGroupId={activeGroupId}
        onSelectGroup={setActiveGroupId}
        onCloseGroup={(groupId) => void closeGroup(groupId)}
        onNewTab={() => void start(false)}
        sessions={sessions.data?.sessions ?? []}
        openSessionIds={groups.flatMap((group) => groupPaneRefs(group).map((pane) => pane.sessionId))}
        onAttachSession={(sessionId) => {
          const row = sessions.data?.sessions.find((item) => item.sessionId === sessionId);
          if (row) attach(row, 0);
        }}
        spawn={spawn}
        onSpawnChange={(update) => setSpawn((current) => ({ ...current, ...update }))}
        onCreate={create}
        tasks={tasks}
      />
      {/* pane 区:一个 tab(group)一棵 pane 树,切 tab 即换 dockview 实例。 */}
      <div ref={regionRef} data-testid="terminal-pane-region" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeGroup ? (
          <TerminalPaneContext.Provider value={paneActions}>
            <TerminalSplitGrid
              key={activeGroup.groupId}
              seeds={activeGroup.seeds}
              grid={activeGroup.grid}
              onApiReady={(api) => {
                gridApi.current = api;
              }}
              onLayoutChange={(grid) => applyGrid(activeGroup.groupId, grid)}
              onActivePaneChange={(panelId) => {
                if (panelId) focusPane(panelId);
              }}
            />
          </TerminalPaneContext.Provider>
        ) : (
          <div className="grid h-full place-items-center px-4 text-center text-[12px] text-text-faint">
            {t("terminal.view.startHint")}
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="border-t border-status-blocked/30 px-3 py-1 text-[11px] text-status-blocked">
          {error}
        </p>
      )}
    </section>
  );
}

function tabChips(groups: readonly TerminalGroupLayout[], tabs: readonly TerminalTab[]): readonly TerminalTabChip[] {
  return groups.map((group) => {
    const refs = groupPaneRefs(group);
    const live = refs.flatMap((ref) => tabs.filter((tab) => tab.sessionId === ref.sessionId));
    return {
      groupId: group.groupId,
      title: live[0]?.name ?? t("terminal.view.title"),
      backend: live[0]?.backend ?? t("views.settingsView.systemUnknownDash"),
      paneCount: refs.length,
    };
  });
}
function paneOfSession(
  groups: readonly TerminalGroupLayout[],
  sessionId: string,
): { readonly groupId: string; readonly panelId: string } | null {
  for (const group of groups)
    for (const pane of groupPaneRefs(group))
      if (pane.sessionId === sessionId) return { groupId: group.groupId, panelId: pane.panelId };
  return null;
}
function sessionOfPane(groups: readonly TerminalGroupLayout[], panelId: string): string | null {
  for (const group of groups)
    for (const pane of groupPaneRefs(group)) if (pane.panelId === panelId) return pane.sessionId;
  return null;
}
function paneBoxes(region: HTMLElement | null): readonly PaneBox[] {
  return [...(region?.querySelectorAll<HTMLElement>("[data-pane-id]") ?? [])].flatMap((element) => {
    const panelId = element.dataset.paneId;
    if (!panelId) return [];
    const rect = element.getBoundingClientRect();
    return [{ panelId, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }];
  });
}
function focusPaneInput(region: HTMLElement | null, panelId: string): void {
  const host = region?.querySelector<HTMLElement>(`[data-pane-id="${panelId}"]`);
  host?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}
function arrowDirection(key: string): PaneDirection | null {
  const map: Record<string, PaneDirection> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
  };
  return map[key] ?? null;
}
function tabFromRow(
  row: AttachRow,
  daemonGeneration: number,
  existing: TerminalTab | undefined,
  afterSeq: number,
): TerminalTab {
  return {
    sessionId: row.sessionId,
    name: row.name,
    state: row.status,
    daemonGeneration,
    attachmentId: null,
    lastSeq: existing?.lastSeq ?? afterSeq,
    output: existing?.output ?? "",
    notice: existing?.notice ?? null,
    cwd: row.cwd,
    requestedBackend: row.requestedBackend,
    backend: row.backend,
    durability: row.durability,
    warning: row.warning,
    attachable: row.attachable,
  };
}
function isInitial(
  value: TerminalAttachInitial | import("../terminal-model.ts").TerminalStreamFrame,
): value is TerminalAttachInitial {
  return value.schema === "terminal-attach/v1";
}
function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
function consumeKnownError(value: unknown): void {
  void value;
}
