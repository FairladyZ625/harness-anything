import { useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type SerializedDockview } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { ArrowCounterClockwise, ArrowUUpLeft } from "@phosphor-icons/react";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import { directionalPane, type PaneBox, type PaneDirection } from "../../terminal-pane-focus.ts";
import {
  PageRegionHostContext,
  RegionControlsContext,
  RegionHandleContext,
  type PageRegionHostActions,
  type PageRegionSpec,
  type RegionDockZone,
} from "./page-region-context.ts";
import { RegionPanel, regionPanelComponent } from "./page-region-pane.tsx";
import {
  readSplitPreferences,
  setSplitSlot,
  splitPreferenceStorage,
  writeSplitPreferences,
} from "../../split-layout-preferences.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 页面区域停靠分屏(任务 task_033760e2…):拖区域标题把手到另一区域的四边半区,预览遮罩
 * 指示落位,放下按该方向二分(初始各占目标原空间一半),源位置由布局树自动合并填满。布局
 * 树、分隔条拖拽与空容器清理全部复用 dockview(与终端分屏同一裁剪:隐藏 group header、
 * 关掉 dockview 自带 DnD/浮动组,一个 group 恒定一个区域),不再有 swap 排列的第二套树。
 * 偏好仍是连接+仓+页面槽的本地 localStorage,存整棵布局快照;键盘路径(方向键停靠、
 * Alt+方向键调缝)、单步撤销与重置在把手与控件组上。
 */

/** 组件注册表必须稳定,否则 dockview 每次渲染都会重建面板渲染器。 */
const components = { [regionPanelComponent]: RegionPanel };

/** 区域最小可用尺寸(px):分隔条与键盘调缝都按它夹住,两侧不会被拖成不可用。 */
const REGION_MIN_WIDTH = 200,
  REGION_MIN_HEIGHT = 120;

export type PageRegion = PageRegionSpec;
export function RegionDragHandle() {
  return useContext(RegionHandleContext);
}
export function RegionLayoutControls() {
  return useContext(RegionControlsContext);
}

interface Scope {
  readonly connectionId: string | null;
  readonly repoId: string;
  readonly slot: string;
}

/** 序列化树的叶子深度优先序(= 布局顺序)。 */
function flatLeafOrder(root: unknown): string[] {
  const order: string[] = [];
  const flatten = (node: unknown): void => {
    const record = node as { type?: string; data?: unknown };
    if (record?.type === "branch") {
      for (const child of (record.data as unknown[]) ?? []) flatten(child);
      return;
    }
    const view = (record?.data as { views?: string[] })?.views?.[0];
    if (view !== undefined) order.push(view);
  };
  flatten(root);
  return order;
}

/** 把序列化布局树里不在保留集中的叶子剪掉,空枝收敛;返回 null 表示一棵不剩。
 * 用于快照恢复:恢复时只保留当前区域集里已有的面板,投影没追平的区域不提前占位。 */
function pruneSnapshot(node: unknown, keep: ReadonlySet<string>): unknown | null {
  const record = node as { type?: string; data?: unknown };
  if (record?.type !== "branch") {
    const view = (record?.data as { views?: string[] })?.views?.[0];
    return view !== undefined && keep.has(view) ? node : null;
  }
  const children = ((record.data as unknown[]) ?? [])
    .map((child) => pruneSnapshot(child, keep))
    .filter((child) => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...record, data: children };
}

/** 单步撤销的逆操作:把 source 停回原邻居旁,并恢复它沿原轴的尺寸。 */
interface UndoEntry {
  readonly source: string;
  readonly anchor: string;
  readonly position: "left" | "right" | "above" | "below";
  readonly size: { readonly axis: "width" | "height"; readonly px: number } | null;
}

export function PageRegions(
  props: Scope & {
    readonly regions: readonly PageRegion[];
    readonly columns: readonly (readonly string[])[];
    readonly testId: string;
    readonly defaultRatio?: number;
  },
) {
  const [reset, setReset] = useState(0);
  const { connectionId, repoId, slot } = props;
  return (
    <PageRegionsHost
      key={`${connectionId}:${repoId}:${slot}:${reset}`}
      {...props}
      onReset={() => {
        if (connectionId !== null) {
          const storage = splitPreferenceStorage();
          const slots = readSplitPreferences(storage, connectionId, repoId);
          delete slots[slot];
          writeSplitPreferences(storage, connectionId, repoId, slots);
        }
        setReset((value) => value + 1);
      }}
    />
  );
}

function PageRegionsHost({
  regions,
  columns,
  testId,
  defaultRatio,
  onReset,
  ...scope
}: Scope & {
  readonly regions: readonly PageRegion[];
  readonly columns: readonly (readonly string[])[];
  readonly testId: string;
  readonly defaultRatio?: number;
  readonly onReset: () => void;
}) {
  const { connectionId, repoId, slot } = scope;
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<DockviewApi | null>(null);
  const undoRef = useRef<UndoEntry | null>(null);
  // 只有用户改动(停靠/调缝/撤销/收起/区域增减)才落盘;默认布局的首次搭建不写偏好,
  // 「没有偏好的槽位 = 默认布局」保持成立。
  const touchedRef = useRef(false);
  // 从快照恢复过:此后调用方的列序不再是布局权威,区域增减走增量。
  const restoredRef = useRef(false);
  // 待恢复的布局快照:等首个非空区域集到来时剪枝应用。
  const pendingSnapshotRef = useRef<unknown>(undefined);
  const [ready, setReady] = useState(false);
  const [undoable, setUndoable] = useState(false);
  const registry = useMemo(() => new Map(regions.map((region) => [region.id, region])), [regions]);
  const available = useMemo(() => columns.flat().filter((id) => registry.has(id)), [columns, registry]);

  const persist = useCallback(
    (snapshot: SerializedDockview) => {
      // 连接身份未解析(如系统状态未就绪):只改本会话布局,不猜键落盘。
      if (connectionId === null) return;
      const storage = splitPreferenceStorage();
      const slots = setSplitSlot(readSplitPreferences(storage, connectionId, repoId), slot, { snapshot });
      writeSplitPreferences(storage, connectionId, repoId, slots);
    },
    [connectionId, repoId, slot],
  );

  /** 撤销按叶子深度优先序找 source 的前后邻居。 */
  const neighborOf = useCallback((id: string): { prev?: string; next?: string } | null => {
    const order = flatLeafOrder(apiRef.current?.toJSON().grid.root);
    const index = order.indexOf(id);
    if (index < 0) return null;
    return { prev: order[index - 1], next: order[index + 1] };
  }, []);

  const recordUndo = useCallback(
    (source: string) => {
      const api = apiRef.current,
        panel = api?.getPanel(source);
      if (api === null || panel === undefined) return;
      const neighbors = neighborOf(source);
      const anchor = neighbors?.prev ?? neighbors?.next;
      if (anchor === undefined) {
        undoRef.current = null;
        setUndoable(false);
        return;
      }
      const rect = panel.api.group.element.getBoundingClientRect(),
        anchorRect = api.getPanel(anchor)?.api.group.element.getBoundingClientRect();
      // 有真实几何时按相对方位回停;测试环境无几何时按布局顺序默认右侧。
      let position: UndoEntry["position"] = neighbors?.prev !== undefined ? "right" : "left";
      let size: UndoEntry["size"] = null;
      if (rect.width > 0 && anchorRect !== undefined && anchorRect.width > 0) {
        if (anchorRect.right <= rect.left + 1) position = "right";
        else if (anchorRect.left >= rect.right - 1) position = "left";
        else if (anchorRect.bottom <= rect.top + 1) position = "below";
        else position = "above";
        size =
          position === "left" || position === "right"
            ? { axis: "width", px: rect.width }
            : { axis: "height", px: rect.height };
      }
      undoRef.current = { source, anchor, position, size };
      setUndoable(true);
    },
    [neighborOf],
  );

  /** 停靠:moveTo 挪的是 dockview group(DOM 原地搬家,内容不重挂);再统一收敛为各占目标原空间一半。 */
  const dock = useCallback(
    (source: string, target: string, zone: RegionDockZone) => {
      const api = apiRef.current,
        sourcePanel = api?.getPanel(source),
        targetPanel = api?.getPanel(target);
      if (api === undefined || sourcePanel === undefined || targetPanel === undefined || source === target) return;
      recordUndo(source);
      touchedRef.current = true;
      const axis = zone === "left" || zone === "right" ? "width" : "height";
      const targetSize = targetPanel.api.group.element.getBoundingClientRect()[axis];
      sourcePanel.api.moveTo({
        group: targetPanel.api.group,
        position: zone === "above" ? "top" : zone === "below" ? "bottom" : zone,
      });
      // 同向同支的停靠走 dockview 的索引快路径(保留旧尺寸),其余情况均分目标;两种都
      // 收敛到「各占原目标一半」。无真实几何(测试)时跳过,结构仍正确。
      if (targetSize > 0)
        sourcePanel.api.group.api.setSize({ [axis]: Math.round(targetSize / 2) } as { [k: string]: number });
    },
    [recordUndo],
  );

  const regionBoxes = useCallback((): readonly PaneBox[] => {
    return [...(hostRef.current?.querySelectorAll<HTMLElement>("[data-region]") ?? [])].flatMap((element) => {
      const panelId = element.dataset.region;
      if (!panelId) return [];
      const rect = element.getBoundingClientRect();
      return [{ panelId, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }];
    });
  }, []);

  const dockKeyboard = useCallback(
    (id: string, direction: PaneDirection) => {
      const target = directionalPane(regionBoxes(), id, direction);
      if (target === null) return;
      dock(id, target, direction === "up" ? "above" : direction === "down" ? "below" : direction);
    },
    [dock, regionBoxes],
  );

  const resizeSeam = useCallback((id: string, direction: PaneDirection, delta: number) => {
    const group = apiRef.current?.getPanel(id)?.api.group;
    if (group === undefined) return;
    touchedRef.current = true;
    const axis = direction === "left" || direction === "right" ? "width" : "height";
    const current = group.element.getBoundingClientRect()[axis];
    if (current <= 0) return;
    const step = Math.max(16, Math.round(current * 0.05));
    group.api.setSize({ [axis]: current + delta * step } as { [k: string]: number });
  }, []);

  const undo = useCallback(() => {
    const entry = undoRef.current;
    const api = apiRef.current,
      source = api?.getPanel(entry?.source ?? ""),
      anchor = api?.getPanel(entry?.anchor ?? "");
    if (api === undefined || entry === null || source === undefined || anchor === undefined) return;
    touchedRef.current = true;
    source.api.moveTo({
      group: anchor.api.group,
      position: entry.position === "above" ? "top" : entry.position === "below" ? "bottom" : entry.position,
    });
    if (entry.size !== null)
      source.api.group.api.setSize({ [entry.size.axis]: entry.size.px } as { [k: string]: number });
    undoRef.current = null;
    setUndoable(false);
  }, []);

  const controls = useMemo(
    () => (
      <RegionLayoutControlsGroup testId={`${testId}-controls`} undoable={undoable} onUndo={undo} onReset={onReset} />
    ),
    [onReset, testId, undo, undoable],
  );

  /** 按 columns 搭默认布局:首列占比、列内按权重;两遍加的面板序即布局序。 */
  const buildDefault = useCallback(
    (api: DockviewApi) => {
      const groups = columns
        .map((column) => column.filter((id) => registry.has(id)))
        .filter((group) => group.length > 0);
      const width = hostRef.current?.clientWidth ?? 0,
        height = hostRef.current?.clientHeight ?? 0;
      const weightOf = (id: string) => registry.get(id)?.weight ?? 1;
      const firstShare =
        groups.length > 1 && defaultRatio !== undefined ? Math.min(0.8, Math.max(0.2, defaultRatio)) : undefined;
      const addRegion = (
        id: string,
        position: { referencePanel: string; direction: "right" | "below" } | undefined,
        initial: { initialWidth?: number; initialHeight?: number },
      ) =>
        api.addPanel({
          id,
          component: regionPanelComponent,
          params: { id },
          minimumWidth: REGION_MIN_WIDTH,
          minimumHeight: REGION_MIN_HEIGHT,
          ...(position === undefined ? {} : { position }),
          ...initial,
        });
      // 两遍搭:先立各列首面板(根级并排),再往列内向下叠——一遍混着加会把后一列嵌进前一列。
      groups.forEach((group, groupIndex) => {
        // 列宽:首列按调用方默认占比,其余均分余量。
        const initialWidth =
          groupIndex > 0 && width > 0 && firstShare !== undefined
            ? groupIndex === 1
              ? Math.round((1 - firstShare) * width)
              : Math.round(((1 - firstShare) * width) / (groups.length - 1))
            : undefined;
        addRegion(
          group[0]!,
          groupIndex === 0 ? undefined : { referencePanel: groups[groupIndex - 1]![0]!, direction: "right" },
          initialWidth === undefined ? {} : { initialWidth },
        );
      });
      groups.forEach((group) => {
        const totalWeight = group.reduce((sum, id) => sum + weightOf(id), 0);
        for (let index = 1; index < group.length; index++) {
          const id = group[index]!;
          // 列内按权重分配高度。
          const initialHeight = height > 0 ? { initialHeight: Math.round((weightOf(id) / totalWeight) * height) } : {};
          addRegion(id, { referencePanel: group[index - 1]!, direction: "below" }, initialHeight);
        }
      });
    },
    [columns, defaultRatio, registry],
  );

  const reconcile = useCallback(
    (api: DockviewApi) => {
      // 有待恢复快照时先不动布局:区域集是投影驱动、陆续到位的,等它稳定(去抖)后
      // 一次性剪枝恢复,而不是按首个非空集合剪、再把后到的区域追加到末尾。
      if (pendingSnapshotRef.current !== undefined) return;
      const wanted = regions.map((region) => region.id);
      // 区域集增减是数据驱动(投影追平有时差),不算用户改动:不置 touched,重载后由
      // 快照+reconcile 重新收敛,而不是把「暂时缺席的区域被移除」当成布局写进偏好。
      for (const panel of [...api.panels]) if (!wanted.includes(panel.id)) api.removePanel(panel);
      if (api.panels.length === 0) {
        buildDefault(api);
        return;
      }
      if (!touchedRef.current && !restoredRef.current) {
        // 用户未动过且无快照:调用方的列序是布局权威(总览按 daemon 权重落位),
        // 区域集或次序变了就按新默认重建;一旦动过/恢复过,布局只归增量 reconcile。
        const desired = columns.flat().filter((id) => registry.has(id));
        const current = flatLeafOrder(api.toJSON().grid.root);
        if (desired.length !== current.length || desired.some((id, index) => id !== current[index])) {
          api.clear();
          buildDefault(api);
          return;
        }
      }
      let last = api.panels[api.panels.length - 1]?.id;
      for (const id of wanted)
        if (api.getPanel(id) === undefined) {
          api.addPanel({
            id,
            component: regionPanelComponent,
            params: { id },
            minimumWidth: REGION_MIN_WIDTH,
            minimumHeight: REGION_MIN_HEIGHT,
            ...(last !== undefined ? { position: { referencePanel: last, direction: "right" as const } } : {}),
          });
          last = id;
        }
    },
    [buildDefault, columns, regions, registry],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      for (const group of api.groups) group.header.hidden = true;
      api.onDidAddGroup((group) => {
        group.header.hidden = true;
      });
      // 网格先量出真实尺寸,默认布局的初始列宽/行高才有意义(happy-dom 里为 0,跳过 px)。
      const host = hostRef.current;
      if (host !== null && host.clientWidth > 0 && host.clientHeight > 0)
        api.layout(host.clientWidth, host.clientHeight);
      // 快照不立即恢复:区域集是投影驱动的,首次非空集合稳定后再按已知面板剪枝恢复,
      // 否则「还没到的区域」会在恢复后被当成多余面板移除、再被追加到末尾,毁掉停靠。
      pendingSnapshotRef.current =
        connectionId === null
          ? undefined
          : readSplitPreferences(splitPreferenceStorage(), connectionId, repoId)[slot]?.snapshot;
      api.onDidLayoutChange(() => {
        // 卸载/换页后迟到的布局事件(自适应量尺走 rAF)不再落盘,不覆盖下一页的槽位。
        if (apiRef.current !== api) return;
        if (touchedRef.current) persist(api.toJSON());
      });
      reconcile(api);
      setReady(true);
    },
    [connectionId, persist, reconcile, repoId, slot],
  );

  useEffect(() => {
    // 区域集在挂载后变化(时间线出现/总览区域增减):增量补齐或回收,不重建整棵树。
    if (!ready || apiRef.current === null) return;
    if (pendingSnapshotRef.current !== undefined) {
      // 去抖等投影追平:区域集最后一次变化后 250ms 才恢复快照。
      const snapshot = pendingSnapshotRef.current;
      const timer = setTimeout(() => {
        const api = apiRef.current;
        if (api === null) return;
        pendingSnapshotRef.current = undefined;
        const pruned = pruneSnapshot(
          (snapshot as { grid?: { root?: unknown } })?.grid?.root,
          new Set(regions.map((region) => region.id)),
        );
        if (pruned !== null) {
          try {
            api.clear();
            api.fromJSON({
              ...(snapshot as object),
              grid: { ...(snapshot as { grid?: object }).grid, root: pruned },
            } as SerializedDockview);
            restoredRef.current = true;
          } catch (cause) {
            // 快照与当前面板集不匹配等损坏:回落默认布局,不静默吞。
            consumeKnownError(cause);
            api.clear();
          }
        }
        reconcile(api);
      }, 250);
      return () => clearTimeout(timer);
    }
    reconcile(apiRef.current);
  }, [ready, reconcile, regions]);

  useEffect(
    () => () => {
      apiRef.current = null;
    },
    [],
  );

  const actions = useMemo<PageRegionHostActions>(
    () => ({
      regions: registry,
      controls: (id) => (id === available[0] ? controls : null),
      dock,
      dockKeyboard,
      resizeSeam,
    }),
    [available, controls, dock, dockKeyboard, registry, resizeSeam],
  );

  if (regions.length === 0) return <div data-testid={testId} className="min-h-0 min-w-0 flex-1" />;
  return (
    <PageRegionHostContext.Provider value={actions}>
      <div
        ref={hostRef}
        data-testid={testId}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-1 overflow-hidden"
        style={
          {
            // 页面区域不借 dockview 主题的底色:分隔缝用产品描边色,sash 悬停用产品悬浮色。
            "--dv-group-view-background-color": "transparent",
            "--dv-separator-border": "var(--color-border)",
            "--dv-active-sash-color": "var(--color-border-strong)",
          } as CSSProperties
        }
      >
        <DockviewReact
          components={components}
          onReady={onReady}
          className="min-h-0 flex-1"
          disableDnd
          disableFloatingGroups
        />
      </div>
    </PageRegionHostContext.Provider>
  );
}

const CONTROL_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-sm border border-border text-text-faint " +
  "hover:border-border-strong hover:bg-surface-raised hover:text-text " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
  "aria-pressed:border-accent/50 aria-pressed:bg-accent/10 aria-pressed:text-accent " +
  "disabled:pointer-events-none disabled:opacity-40";

/** 区域头控件组:撤销上一步停靠、恢复默认布局。 */
function RegionLayoutControlsGroup({
  testId,
  undoable,
  onUndo,
  onReset,
}: {
  readonly testId: string;
  readonly undoable: boolean;
  readonly onUndo: () => void;
  readonly onReset: () => void;
}) {
  return (
    <div
      className="flex items-center gap-1"
      role="group"
      aria-label={t("components.pageRegions.layoutGroup")}
      onClick={(event) => event.stopPropagation()}
      data-testid={testId}
    >
      <button
        type="button"
        disabled={!undoable}
        aria-label={t("components.pageRegions.undoDock")}
        title={t("components.pageRegions.undoDockTitle")}
        onClick={onUndo}
        data-testid={`${testId}-undo`}
        className={CONTROL_BUTTON}
      >
        <ArrowUUpLeft weight="bold" className="ui-meta" />
      </button>
      <button
        type="button"
        aria-label={t("components.splitLayout.reset")}
        title={t("components.splitLayout.resetTitle")}
        onClick={onReset}
        data-testid={`${testId}-reset`}
        className={CONTROL_BUTTON}
      >
        <ArrowCounterClockwise weight="bold" className="ui-meta" />
      </button>
    </div>
  );
}
