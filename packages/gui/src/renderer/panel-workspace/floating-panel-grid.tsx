import { Notice } from "../components/primitives/Notice.tsx";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CornersIn, CornersOut } from "@phosphor-icons/react";
import {
  DockviewReact,
  themeAbyss,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "./floating-panel-grid.css";
import { t } from "../i18n/index.tsx";
import {
  clearPanelWorkspaceLayout,
  panelWorkspacePreferenceStorage,
  readPanelWorkspaceLayout,
  writePanelWorkspaceLayout,
  type PanelGeometry,
  type PanelWorkspaceStorage,
} from "./panel-workspace-layout.ts";

/**
 * 自由面板画板的统一容器(task_f82b0d6058966986403ef1b635)。
 *
 * dockview 8.2.0 的 floating group 提供自由定位、四边四角缩放与视口内最小保留
 * (Overlay 默认至少 20px 留在容器内,画板缩小时面板拉得回来),本组件把它的能力
 * 裁成「每个面板 = 一个完整功能块」的工作台契约:
 * - 拖动只能从面板顶部的淡显拖条发起(dockview 默认 dragHandle 即专用
 *   dv-floating-titlebar,拖动结束经 fireLayoutChange 汇入 onDidLayoutChange),
 *   与面板内容里的图节点拖拽、文字选择、滚动互不重叠;disableDnd 一并关掉重停靠。
 * - 几何读浮窗元素的 offset 位(与 addFloatingGroup 的 x/y 同一坐标原点,见
 *   geometryOf 的注释);写回用 addFloatingGroup,面板内容不重建。
 * - 每面板一个标签头(标题 + 放大/还原);放大经「以全画布几何重挂浮动窗口」实现,
 *   还原回暂存几何。
 * - 布局持久化是「面板身份 → 画布几何」的自有模型(见 panel-workspace-layout.ts),
 *   按工作区(连接目标 + 仓)分槽;拖动/缩放结束即落盘,重置布局清槽并回预设。
 *   存储写失败(quota 满/隐私模式)在这里变成画板上的可见状态,不以成功伪装。
 */
export interface FloatingPanelDescriptor {
  readonly id: string;
  readonly title: string;
  readonly node: React.ReactNode;
}

export interface FloatingPanelCanvas {
  readonly width: number;
  readonly height: number;
}

export interface FloatingPanelGridProps {
  /** 布局持久化分槽键(连接目标 + 仓,由页面拼好传入);同一键下的窗口共享一套几何偏好。 */
  readonly workspaceId: string;
  readonly panels: readonly FloatingPanelDescriptor[];
  /** 预设几何:按实测画布尺寸给出(重置布局与首挂载缺省几何时用)。 */
  readonly presetGeometry: (canvas: FloatingPanelCanvas) => Readonly<Record<string, PanelGeometry>>;
  /** 测试注入的存储;缺省 renderer localStorage。 */
  readonly storage?: PanelWorkspaceStorage | null;
  /** 递增即重置:清掉持久化布局并按预设几何重排(面板内容不重建)。 */
  readonly resetNonce: number;
}

interface FloatingPanelActions {
  readonly maximizedId: string | null;
  readonly toggleMaximize: (panelId: string) => void;
}

const emptyRegistry: ReadonlyMap<string, FloatingPanelDescriptor> = new Map();
const noopActions: FloatingPanelActions = { maximizedId: null, toggleMaximize: () => {} };

const PanelRegistryContext = createContext<ReadonlyMap<string, FloatingPanelDescriptor>>(emptyRegistry);
const PanelActionsContext = createContext<FloatingPanelActions>(noopActions);

/** 组件注册表必须是稳定引用,否则 dockview 每次渲染都会重建 panel 渲染器(同终端页)。 */
const components = { floatingPanelHost: FloatingPanelHost };
const defaultTab = FloatingPanelTab;
export const floatingPanelComponent = "floatingPanelHost";

interface FloatingPanelParams {
  readonly panelId: string;
}

function FloatingPanelHost(props: IDockviewPanelProps<FloatingPanelParams>) {
  const registry = useContext(PanelRegistryContext);
  const descriptor = registry.get(props.params.panelId);
  return (
    <div
      data-panel-id={props.params.panelId}
      data-testid="floating-panel-body"
      className="content-viewport h-full min-h-0 min-w-0 overflow-hidden bg-bg"
    >
      {descriptor ? (
        descriptor.node
      ) : (
        <p className="p-3 ui-meta text-text-faint">{t("views.panelWorkbench.panelRetired")}</p>
      )}
    </div>
  );
}

function FloatingPanelTab(props: IDockviewPanelHeaderProps<FloatingPanelParams>) {
  const registry = useContext(PanelRegistryContext);
  const actions = useContext(PanelActionsContext);
  const panelId = props.params.panelId;
  const title = registry.get(panelId)?.title ?? panelId;
  const maximized = actions.maximizedId === panelId;
  return (
    <div className="floating-panel-tab" data-testid="floating-panel-tab">
      <span className="floating-panel-tab-title" title={title}>
        {title}
      </span>
      <button
        type="button"
        className="floating-panel-tab-maximize"
        data-testid="floating-panel-maximize"
        data-panel-id={panelId}
        aria-pressed={maximized}
        title={maximized ? t("views.panelWorkbench.restorePanel") : t("views.panelWorkbench.maximizePanel")}
        aria-label={maximized ? t("views.panelWorkbench.restorePanel") : t("views.panelWorkbench.maximizePanel")}
        onClick={(event) => {
          event.stopPropagation();
          actions.toggleMaximize(panelId);
        }}
      >
        {maximized ? <CornersIn weight="bold" className="ui-meta" /> : <CornersOut weight="bold" className="ui-meta" />}
      </button>
    </div>
  );
}

export function FloatingPanelGrid({
  workspaceId,
  panels,
  presetGeometry,
  storage = panelWorkspacePreferenceStorage(),
  resetNonce,
}: FloatingPanelGridProps) {
  const [isLight, setIsLight] = useState(() => document.documentElement.dataset.theme === "light");
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [persistUnavailable, setPersistUnavailable] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<DockviewApi | null>(null);
  const builtRef = useRef(false);
  const resetNonceRef = useRef(resetNonce);
  const workspaceRef = useRef(workspaceId);
  const storageRef = useRef(storage);
  const presetGeometryRef = useRef(presetGeometry);
  const panelsRef = useRef(panels);
  const maximizedIdRef = useRef<string | null>(null);
  /** 放大前面板的几何,按面板身份暂存;持久化时放大中的面板写这份几何。 */
  const restoreGeometriesRef = useRef(new Map<string, PanelGeometry>());
  workspaceRef.current = workspaceId;
  storageRef.current = storage;
  presetGeometryRef.current = presetGeometry;
  panelsRef.current = panels;
  maximizedIdRef.current = maximizedId;

  useEffect(() => {
    const observer = new MutationObserver(() => setIsLight(document.documentElement.dataset.theme === "light"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const canvasOf = useCallback((): FloatingPanelCanvas => {
    const element = containerRef.current;
    return {
      width: Math.max(0, element?.clientWidth ?? 0),
      height: Math.max(0, element?.clientHeight ?? 0),
    };
  }, []);

  /**
   * 当前几何:浮窗元素(dv-resize-container)在其 containing block 里的 offset 位。
   * 不读 toJSON 的 position——dockview 拖动近全高面板时会把锚写成 bottom/right
   * (AnchoredBox 联合的另一半),换算回 top/left 又被最小视口 clamp 扭曲;而
   * offsetLeft/offsetTop 与 addFloatingGroup 写入 left/top 用的是同一个坐标原点,
   * 精确往返。面板不在浮动窗口上(无宿主元素)时为 null。
   */
  const geometryOf = useCallback((panelId: string): PanelGeometry | null => {
    const root = containerRef.current;
    const host = root?.querySelector(`[data-panel-id="${CSS.escape(panelId)}"]`)?.closest(".dv-resize-container");
    if (!(host instanceof HTMLElement) || !(host.offsetParent instanceof HTMLElement)) return null;
    return {
      x: host.offsetLeft,
      y: host.offsetTop,
      width: host.offsetWidth,
      height: host.offsetHeight,
    };
  }, []);

  /**
   * 落一次存储操作:失败不外抛,转成画板上的可见失败状态并以 false 传播(quota
   * 满/隐私模式时本会话布局仍生效,只是不跨会话记忆,不伪装成已保存)。
   */
  const storageAttempt = useCallback((run: () => void): boolean => {
    try {
      run();
      setPersistUnavailable(false);
      return true;
    } catch {
      setPersistUnavailable(true);
      return false;
    }
  }, []);

  const persist = useCallback(() => {
    if (!apiRef.current) return;
    const layout: Record<string, PanelGeometry> = {};
    for (const descriptor of panelsRef.current) {
      const geometry = geometryOf(descriptor.id);
      if (geometry === null) continue;
      // 放大中的面板写「放大前几何」,重启后回到用户排好的大小,不是整幅画布。
      const restore =
        maximizedIdRef.current === descriptor.id ? restoreGeometriesRef.current.get(descriptor.id) : undefined;
      layout[descriptor.id] = restore ?? geometry;
    }
    // 页面仍声明这些面板而几何全空 = dockview 拆卸(clear/dispose)触发的末次事件,
    // 不是用户排空了布局;这时落盘会把已保存的偏好清成空布局。
    if (Object.keys(layout).length === 0) return;
    storageAttempt(() => writePanelWorkspaceLayout(storageRef.current, workspaceRef.current, layout));
  }, [geometryOf, storageAttempt]);

  /** 按当前面板清单(重挂浮动窗口,内容不重建)排布:restore 用存量偏好,reset 用预设。 */
  const arrange = useCallback(
    (mode: "restore" | "reset") => {
      const api = apiRef.current;
      if (!api) return;
      const layout = mode === "reset" ? {} : readPanelWorkspaceLayout(storageRef.current, workspaceRef.current);
      if (mode === "reset") {
        storageAttempt(() => clearPanelWorkspaceLayout(storageRef.current, workspaceRef.current));
        restoreGeometriesRef.current.clear();
        maximizedIdRef.current = null;
        setMaximizedId(null);
      }
      const preset = presetGeometryRef.current(canvasOf());
      for (const descriptor of panelsRef.current) {
        const geometry = layout[descriptor.id] ?? preset[descriptor.id] ?? fallbackGeometry;
        const panel = api.getPanel(descriptor.id);
        if (panel) {
          api.addFloatingGroup(panel, geometry);
          continue;
        }
        const added = api.addPanel({
          id: descriptor.id,
          component: floatingPanelComponent,
          params: { panelId: descriptor.id } satisfies FloatingPanelParams,
          title: descriptor.title,
        });
        api.addFloatingGroup(added, geometry);
      }
    },
    [canvasOf, storageAttempt],
  );

  const ready = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      event.api.onDidLayoutChange(() => persist());
      arrange("restore");
      builtRef.current = true;
    },
    [arrange, persist],
  );

  useEffect(
    () => () => {
      apiRef.current = null;
      builtRef.current = false;
    },
    [],
  );

  // 重置布局:递增 resetNonce 触发;不重挂 dockview,面板内容(图/时间线/文档)保活。
  useEffect(() => {
    if (!builtRef.current) return;
    if (resetNonce === resetNonceRef.current) return;
    resetNonceRef.current = resetNonce;
    arrange("reset");
  }, [arrange, resetNonce]);

  const toggleMaximize = useCallback(
    (panelId: string) => {
      const api = apiRef.current;
      if (!api) return;
      const panel = api.getPanel(panelId);
      if (!panel) return;
      // 一次只放大一个:先把上一个放大中的面板放回它的暂存几何,再放大新面板。
      const currentMaximized = maximizedIdRef.current;
      if (currentMaximized !== null && currentMaximized !== panelId) {
        const previous = api.getPanel(currentMaximized);
        const restore = restoreGeometriesRef.current.get(currentMaximized);
        if (previous && restore) api.addFloatingGroup(previous, restore);
      }
      if (currentMaximized === panelId) {
        const restore = restoreGeometriesRef.current.get(panelId);
        restoreGeometriesRef.current.delete(panelId);
        maximizedIdRef.current = null;
        setMaximizedId(null);
        if (restore) api.addFloatingGroup(panel, restore);
        return;
      }
      const current = geometryOf(panelId);
      if (current !== null) restoreGeometriesRef.current.set(panelId, current);
      const canvas = canvasOf();
      maximizedIdRef.current = panelId;
      setMaximizedId(panelId);
      api.addFloatingGroup(panel, {
        x: 0,
        y: 0,
        width: Math.max(fallbackGeometry.width, canvas.width),
        height: Math.max(fallbackGeometry.height, canvas.height),
      });
    },
    [canvasOf, geometryOf],
  );

  const actions = useMemo<FloatingPanelActions>(() => ({ maximizedId, toggleMaximize }), [maximizedId, toggleMaximize]);
  const registry = useMemo(() => new Map(panels.map((panel) => [panel.id, panel])), [panels]);

  return (
    <PanelRegistryContext.Provider value={registry}>
      <PanelActionsContext.Provider value={actions}>
        <section className="flex h-full min-h-0 flex-col">
          {persistUnavailable ? (
            <Notice tone="bad" variant="strip" testId="floating-panel-persist-status">
              {t("views.panelWorkbench.persistUnavailable")}
            </Notice>
          ) : null}
          <div
            ref={containerRef}
            className="floating-panel-grid min-h-0 w-full flex-1"
            data-testid="floating-panel-grid"
          >
            <DockviewReact
              components={components}
              defaultTabComponent={defaultTab}
              onReady={ready}
              theme={isLight ? themeLight : themeAbyss}
              className="h-full w-full"
              disableDnd
              disableTabsOverflowList
              hideBorders
              singleTabMode="fullwidth"
              noPanelsOverlay="emptyGroup"
            />
          </div>
        </section>
      </PanelActionsContext.Provider>
    </PanelRegistryContext.Provider>
  );
}

const fallbackGeometry: PanelGeometry = { x: 24, y: 24, width: 460, height: 340 };
