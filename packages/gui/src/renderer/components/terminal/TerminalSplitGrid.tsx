import { useCallback, useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  themeAbyss,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type SerializedDockview,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import type { TerminalGridSnapshot, TerminalPaneRef } from "../../terminal-layout.ts";
import { TerminalPaneCard } from "./TerminalPaneCard.tsx";

/** 组件注册表必须是稳定引用,否则 dockview 每次渲染都会重建 panel 渲染器。 */
const components = { terminalPane: TerminalPaneCard };
export const terminalPaneComponent = "terminalPane";

/**
 * 一个终端 tab(= group)内部的 pane 树宿主(PLT-TerminalWorkspace W1)。
 *
 * dockview 的能力在此裁剪到「split + 拖拽调比例」:关掉 tab 拖拽(disableDnd)、浮动组与
 * popout,并隐藏每个 dockview group 的 header——本页的 tab 语义由外层 tab 条承担,pane 不
 * 允许再叠成第二层 tab,所以恒定「一个 dockview group = 一个 pane」。留下的交互只有 sash
 * 拖拽调比例,与 xterm 自身的鼠标选区不重叠(选区在 pane 内部,sash 在 pane 边界之外)。
 *
 * 布局是 dockview 的 `toJSON()` 快照,只在挂载时用 `fromJSON` 恢复一次;之后 dockview 是
 * 布局权威,任何变更经 onLayoutChange 回流给调用方持久化。父组件按 groupId 作 key 重挂。
 */
export function TerminalSplitGrid({
  seeds,
  grid,
  onApiReady,
  onLayoutChange,
  onActivePaneChange,
}: {
  readonly seeds: readonly TerminalPaneRef[];
  readonly grid: TerminalGridSnapshot | null;
  readonly onApiReady: (api: DockviewApi | null) => void;
  readonly onLayoutChange: (grid: TerminalGridSnapshot) => void;
  readonly onActivePaneChange: (panelId: string | null) => void;
}) {
  const [isLight, setIsLight] = useState(() => document.documentElement.dataset.theme === "light");
  const seedsRef = useRef(seeds),
    gridRef = useRef(grid),
    onApiReadyRef = useRef(onApiReady),
    onLayoutChangeRef = useRef(onLayoutChange),
    onActivePaneChangeRef = useRef(onActivePaneChange),
    apiRef = useRef<DockviewApi | null>(null);
  onApiReadyRef.current = onApiReady;
  onLayoutChangeRef.current = onLayoutChange;
  onActivePaneChangeRef.current = onActivePaneChange;

  useEffect(() => {
    const observer = new MutationObserver(() => setIsLight(document.documentElement.dataset.theme === "light"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const ready = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    restore(api, gridRef.current, seedsRef.current);
    for (const group of api.groups) group.header.hidden = true;
    api.onDidAddGroup((group) => {
      group.header.hidden = true;
    });
    const snapshot = () => api.toJSON() as unknown as TerminalGridSnapshot;
    api.onDidLayoutChange(() => onLayoutChangeRef.current(snapshot()));
    api.onDidActivePanelChange((change) => onActivePaneChangeRef.current(change.panel?.id ?? null));
    // 恢复/播种发生在订阅之前(避免损坏快照的 clear 被当成「组已空」),补一帧初始快照,
    // 让「只开了一个 pane、从未再动过布局」的 group 也有可恢复的 grid。
    if (api.panels.length > 0) onLayoutChangeRef.current(snapshot());
    onActivePaneChangeRef.current(api.activePanel?.id ?? null);
    onApiReadyRef.current(api);
  }, []);

  useEffect(
    () => () => {
      apiRef.current = null;
      onApiReadyRef.current(null);
    },
    [],
  );

  return (
    <DockviewReact
      components={components}
      onReady={ready}
      theme={isLight ? themeLight : themeAbyss}
      className="min-h-0 flex-1"
      disableDnd
      disableFloatingGroups
      disableTabsOverflowList
      hideBorders
      singleTabMode="fullwidth"
      noPanelsOverlay="emptyGroup"
    />
  );
}

/** 优先按快照恢复;快照损坏或为空时退回按 seeds 依次向右展开。 */
function restore(api: DockviewApi, grid: TerminalGridSnapshot | null, seeds: readonly TerminalPaneRef[]): void {
  if (grid) {
    try {
      api.fromJSON(grid as unknown as SerializedDockview);
      if (api.panels.length > 0) return;
    } catch (cause) {
      consumeKnownError(cause);
      api.clear();
    }
  }
  seeds.forEach((seed, index) => {
    api.addPanel({
      id: seed.panelId,
      component: terminalPaneComponent,
      params: { sessionId: seed.sessionId },
      ...(index === 0 ? {} : { position: { referencePanel: seeds[index - 1].panelId, direction: "right" as const } }),
    });
  });
}
