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
 * 指示落位,放下按该方向二分——源与目标各占目标原空间的一半(两块 group 都显式设半宽,
 * 同向多兄弟分支也不把差额摊给无关邻居),源位置由布局树自动合并填满。布局树、分隔条
 * 拖拽与空容器清理全部复用 dockview(与终端分屏同一裁剪:隐藏 group header、关掉 dockview
 * 自带 DnD/浮动组,一个 group 恒定一个区域),停靠/重排/折叠全部走 group 级操作,DOM 节点
 * 原地搬家、内容不重挂。折叠/恢复走 dockview 的 grid 可见性(group.setVisible,不用不可靠
 * 的 maximize):折叠区域 DOM 保留、恢复回原尺寸。快照恢复由调用方声明的区域集协调
 * (settled 或快照面板全部到位),不靠定时器猜数据到齐;未动过的布局随调用方列序增量
 * 重排(group 级 moveTo,不整树重建)。偏好仍是连接+仓+页面槽的本地 localStorage,存
 * 整棵布局快照;键盘路径(方向键停靠、Alt+方向键调缝)、单步撤销与重置在把手与控件组上。
 */

/** 组件注册表必须稳定,否则 dockview 每次渲染都会重建面板渲染器。 */
const components = { [regionPanelComponent]: RegionPanel };

/** 区域最小可用尺寸(px):分隔条与键盘调缝都按它夹住,两侧不会被拖成不可用。 */
const REGION_MIN_WIDTH = 200,
  REGION_MIN_HEIGHT = 120;
const REGION_MIN: Record<"width" | "height", number> = { width: REGION_MIN_WIDTH, height: REGION_MIN_HEIGHT };

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

interface SerializedLeaf {
  readonly type?: string;
  readonly data?: { readonly views?: string[] };
  readonly size?: number;
  readonly visible?: boolean;
}
interface SerializedBranch {
  readonly type?: string;
  readonly data?: readonly unknown[];
}

function asBranch(node: unknown): SerializedBranch | null {
  const record = node as SerializedBranch;
  return record?.type === "branch" ? record : null;
}
function leafView(node: unknown): string | undefined {
  return (node as SerializedLeaf)?.data?.views?.[0];
}

/** 序列化树的叶子深度优先序(= 布局顺序)。 */
function flatLeafOrder(root: unknown): string[] {
  const order: string[] = [];
  const flatten = (node: unknown): void => {
    const branch = asBranch(node);
    if (branch !== null) {
      for (const child of branch.data ?? []) flatten(child);
      return;
    }
    const view = leafView(node);
    if (view !== undefined) order.push(view);
  };
  flatten(root);
  return order;
}

/** 序列化树里被折叠(visible:false)的叶子集合:折叠状态以序列化为唯一事实源。 */
function invisibleLeaves(root: unknown): ReadonlySet<string> {
  const hidden = new Set<string>();
  const walk = (node: unknown): void => {
    const branch = asBranch(node);
    if (branch !== null) {
      for (const child of branch.data ?? []) walk(child);
      return;
    }
    const leaf = node as SerializedLeaf;
    if (leaf?.visible === false) {
      const view = leafView(node);
      if (view !== undefined) hidden.add(view);
    }
  };
  walk(root);
  return hidden;
}

/** 把序列化布局树里不在保留集中的叶子剪掉,空枝收敛;返回 null 表示一棵不剩。
 * 只在恢复条件成立(快照面板全部到位或调用方声明区域集就绪)时调用:剪掉的是本页确实
 * 不再显示的面板,未到位的面板不会被提前从布局里删掉。 */
function pruneSnapshot(node: unknown, keep: ReadonlySet<string>): unknown | null {
  const branch = asBranch(node);
  if (branch === null) {
    const view = leafView(node);
    return view !== undefined && keep.has(view) ? node : null;
  }
  const children = (branch.data ?? []).map((child) => pruneSnapshot(child, keep)).filter((child) => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...branch, data: children };
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
    /** 区域集是否已就绪(投影/查询全部落定);分批到位的调用方传 false 直到就绪。
     * 默认 true:区域集在渲染时已完整的页面(任务详情、区域板)不用声明。 */
    readonly settled?: boolean;
  },
) {
  const [reset, setReset] = useState(0);
  const { connectionId, repoId, slot, settled = true } = props;
  return (
    <PageRegionsHost
      key={`${connectionId}:${repoId}:${slot}:${reset}`}
      {...props}
      settled={settled}
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
  settled = true,
  onReset,
  ...scope
}: Scope & {
  readonly regions: readonly PageRegion[];
  readonly columns: readonly (readonly string[])[];
  readonly testId: string;
  readonly defaultRatio?: number;
  readonly settled: boolean;
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
  // 待恢复的布局快照:恢复条件成立(快照面板全部到位或 settled)前只做成员增减。
  const pendingSnapshotRef = useRef<unknown>(undefined);
  const [ready, setReady] = useState(false);
  const [undoable, setUndoable] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState<readonly string[]>([]);
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

  /** 从序列化树同步折叠集合(恢复/增减后调用;折叠状态不单独存第二份)。 */
  const syncCollapsed = useCallback(() => {
    const api = apiRef.current;
    if (api === null) return;
    setCollapsedIds((current) => {
      const next = [...invisibleLeaves(api.toJSON().grid.root)].filter((id) => registry.has(id));
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [registry]);

  /** 强制网格按宿主尺寸重排一遍:结构操作后各层 splitview 的数值总量只有经过 layout
   * 级联才收敛(真实窗口里观察器会做,这里保证显式钉过的尺寸立即成立)。 */
  const relayout = useCallback(() => {
    const host = hostRef.current,
      api = apiRef.current;
    if (host !== null && api !== null && host.clientWidth > 0 && host.clientHeight > 0)
      api.layout(host.clientWidth, host.clientHeight);
  }, []);

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

  /** 停靠可行:目标未折叠,且原空间至少装得下两块最小尺寸。装不下就拒绝该方向(遮罩
   * 也不给),不用最小尺寸把「二分」挤成别的比例。无几何环境(测试)只挡折叠目标。 */
  const dockable = useCallback(
    (target: string, zone: RegionDockZone): boolean => {
      const api = apiRef.current,
        group = api?.getPanel(target)?.api.group;
      if (api === null || group === undefined || collapsedIds.includes(target)) return false;
      const axis = zone === "left" || zone === "right" ? "width" : "height";
      const size = group.element.getBoundingClientRect()[axis];
      return size === 0 || size >= REGION_MIN[axis] * 2;
    },
    [collapsedIds],
  );

  /** 停靠:group 级 moveTo(DOM 原地搬家,内容不重挂);随后源与目标都显式设为目标原
   * 空间的一半——同向多兄弟分支里 dockview 会把插入差额摊给邻居,只有把目标也钉在
   * 半宽上,「各占目标一半」才成立,其余兄弟的尺寸不被这次停靠挪走。 */
  const dock = useCallback(
    (source: string, target: string, zone: RegionDockZone) => {
      const api = apiRef.current,
        sourceGroup = api?.getPanel(source)?.api.group,
        targetGroup = api?.getPanel(target)?.api.group;
      if (api === null || sourceGroup === undefined || targetGroup === undefined || source === target) return;
      if (!dockable(target, zone)) return;
      recordUndo(source);
      touchedRef.current = true;
      const axis = zone === "left" || zone === "right" ? "width" : "height";
      const targetSize = targetGroup.element.getBoundingClientRect()[axis];
      sourceGroup.api.moveTo({
        group: targetGroup,
        position: zone === "above" ? "top" : zone === "below" ? "bottom" : zone,
        skipSetActive: true,
      });
      // 无真实几何(测试)时跳过,结构仍正确。
      if (targetSize > 0) {
        sourceGroup.api.setSize({ [axis]: Math.round(targetSize / 2) } as { [k: string]: number });
        targetGroup.api.setSize({ [axis]: Math.round(targetSize / 2) } as { [k: string]: number });
        relayout();
        // 源的旧位被合并吸收后,目标所在支可能整体加宽(级联把余量灌进末位):按收敛后的
        // 实际支内总量再平分一次,两半严格相等;目标支未加宽时这是无操作。尺寸读序列化
        // 树的 splitview 数值(同步、不依赖渲染量尺)。
        const sourceSize = leafSizeOf(api, source),
          targetSizeNow = leafSizeOf(api, target);
        if (sourceSize !== null && targetSizeNow !== null && Math.abs(sourceSize - targetSizeNow) > 1) {
          const even = Math.round((sourceSize + targetSizeNow) / 2);
          sourceGroup.api.setSize({ [axis]: even } as { [k: string]: number });
          targetGroup.api.setSize({ [axis]: even } as { [k: string]: number });
          relayout();
        }
      }
    },
    [dockable, recordUndo, relayout],
  );

  const regionBoxes = useCallback((): readonly PaneBox[] => {
    return [...(hostRef.current?.querySelectorAll<HTMLElement>("[data-region]") ?? [])].flatMap((element) => {
      const panelId = element.dataset.region;
      if (!panelId) return [];
      const rect = element.getBoundingClientRect();
      // 折叠区域零尺寸:不是任何方向的几何邻居,不参与键盘停靠选邻。
      if (rect.width <= 0 || rect.height <= 0) return [];
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

  /** 折叠/恢复:grid 可见性(不用 maximize)。折叠区域的 DOM 保留(display 收起)、
   * 尺寸由 grid 缓存,恢复回原尺寸;状态随布局快照持久化。 */
  const collapse = useCallback(
    (id: string) => {
      const group = apiRef.current?.getPanel(id)?.api.group;
      if (group === undefined || !group.api.isVisible) return;
      touchedRef.current = true;
      group.api.setVisible(false);
      syncCollapsed();
    },
    [syncCollapsed],
  );
  const expand = useCallback(
    (id: string) => {
      const group = apiRef.current?.getPanel(id)?.api.group;
      if (group === undefined) {
        // 面板已随区域集消失:只清出折叠条目,不猜测位置。
        setCollapsedIds((current) => current.filter((item) => item !== id));
        return;
      }
      touchedRef.current = true;
      group.api.setVisible(true);
      syncCollapsed();
    },
    [syncCollapsed],
  );

  const undo = useCallback(() => {
    const entry = undoRef.current;
    const api = apiRef.current,
      sourceGroup = api?.getPanel(entry?.source ?? "")?.api.group,
      anchorGroup = api?.getPanel(entry?.anchor ?? "")?.api.group;
    if (api === undefined || entry === null || sourceGroup === undefined || anchorGroup === undefined) return;
    touchedRef.current = true;
    sourceGroup.api.moveTo({
      group: anchorGroup,
      position: entry.position === "above" ? "top" : entry.position === "below" ? "bottom" : entry.position,
      skipSetActive: true,
    });
    if (entry.size !== null) {
      sourceGroup.api.setSize({ [entry.size.axis]: entry.size.px } as { [k: string]: number });
      relayout();
    }
    undoRef.current = null;
    setUndoable(false);
  }, [relayout]);

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

  /** 未动过的默认布局随调用方列序重排:全部走 group 级 moveTo(DOM 不重挂、滚动/阅读
   * 状态保留)。先把所有 group 按目标序拉成一条水平链(此时所有列头都在根级),在根级
   * 钉列宽,再逐列向下叠(链头包进纵向分支并继承其根级宽度),最后在纵向支内按权重钉
   * 行高——与 buildDefault 的尺寸账同一套,只是不销毁重建。 */
  const arrange = useCallback(
    (api: DockviewApi) => {
      const groups = columns
        .map((column) => column.filter((id) => registry.has(id)))
        .filter((group) => group.length > 0);
      const desired = groups.flat();
      const groupOf = (id: string) => api.getPanel(id)?.api.group;
      const move = (id: string, reference: string, position: "right" | "bottom") => {
        const target = groupOf(reference);
        // 参照面板缺席(区域集竞态)时跳过这一步,下一轮 reconcile 再收敛。
        if (target === undefined) return;
        groupOf(id)?.api.moveTo({ group: target, position, skipSetActive: true });
      };
      const current = flatLeafOrder(api.toJSON().grid.root);
      const reorder = desired.length === current.length && desired.some((id, index) => id !== current[index]);
      if (reorder)
        for (let index = 1; index < desired.length; index++) move(desired[index]!, desired[index - 1]!, "right");
      const width = hostRef.current?.clientWidth ?? 0,
        height = hostRef.current?.clientHeight ?? 0;
      if (width <= 0 || height <= 0) return;
      const firstShare =
        groups.length > 1 && defaultRatio !== undefined ? Math.min(0.8, Math.max(0.2, defaultRatio)) : undefined;
      const weightOf = (id: string) => registry.get(id)?.weight ?? 1;
      const hidden = invisibleLeaves(api.toJSON().grid.root);
      const apply = (id: string, target: number) => {
        if (hidden.has(id)) return;
        const size = leafSizeOf(api, id);
        if (size !== null && Math.abs(size - target) > 8)
          groupOf(id)?.api.setSize({ width: Math.round(target) } as { [k: string]: number });
      };
      // 列宽只在重排发生时钉:此时所有列头都还在水平链上(叶子 size 即列宽)。顺序已经
      // 正确时,多成员列头在纵向支里、叶子 size 是高度,不能再按宽读写的;首列吃余量,
      // 其余按占比/均分。
      if (reorder)
        groups.forEach((group, groupIndex) => {
          if (groupIndex > 0 && firstShare !== undefined) {
            const share = groupIndex === 1 ? 1 - firstShare : (1 - firstShare) / Math.max(1, groups.length - 1);
            apply(group[0]!, share * width);
          }
        });
      if (reorder)
        for (const group of groups)
          for (let index = 1; index < group.length; index++) move(group[index]!, group[index - 1]!, "bottom");
      // 行高在纵向支内钉(叶子 size 沿父分支方向,此处是高度)。
      const applyHeight = (id: string, target: number) => {
        if (hidden.has(id)) return;
        const size = leafSizeOf(api, id);
        if (size !== null && Math.abs(size - target) > 8)
          groupOf(id)?.api.setSize({ height: Math.round(target) } as { [k: string]: number });
      };
      groups.forEach((group) => {
        const totalWeight = group.reduce((sum, id) => sum + weightOf(id), 0);
        for (let index = 1; index < group.length; index++)
          applyHeight(group[index]!, (weightOf(group[index]!) / totalWeight) * height);
      });
      relayout();
    },
    [columns, defaultRatio, registry, relayout],
  );

  const reconcile = useCallback(
    (api: DockviewApi) => {
      // 有待恢复快照时只做成员增减(页面先按默认布局活起来),顺序重排等恢复后归零重算。
      const pending = pendingSnapshotRef.current !== undefined;
      const wanted = regions.map((region) => region.id);
      // 区域集增减是数据驱动(投影追平有时差),不算用户改动:不置 touched,重载后由
      // 快照+reconcile 重新收敛,而不是把「暂时缺席的区域被移除」当成布局写进偏好。
      for (const panel of [...api.panels]) if (!wanted.includes(panel.id)) api.removePanel(panel);
      if (api.panels.length === 0) {
        buildDefault(api);
        return;
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
      if (!pending && !touchedRef.current && !restoredRef.current) {
        // 用户未动过且无快照:调用方的列序是布局权威(总览按 daemon 权重落位),区域集或
        // 次序变了就按新默认重排(group 级移动,面板不重挂);一旦动过/恢复过,布局只归用户。
        arrange(api);
      }
    },
    [arrange, buildDefault, regions],
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
      // 快照不立即恢复:由声明区域集协调(快照面板全部到位或调用方 settled),恢复条件
      // 不成立时先按默认布局渲染,条件成立那一刻再整棵换回停靠布局。
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
    const api = apiRef.current;
    const pending = pendingSnapshotRef.current;
    if (pending !== undefined) {
      // 恢复条件:快照里的面板全部到位(无损恢复,一个不剪),或调用方声明区域集就绪
      // (仍缺席的面板是本页确实不再显示的,剪掉不算提前删快照)。
      const present = new Set(regions.map((region) => region.id));
      const lossless = flatLeafOrder((pending as { grid?: { root?: unknown } })?.grid?.root).every((id) =>
        present.has(id),
      );
      if (!lossless && settled !== true) {
        reconcile(api);
        return;
      }
      pendingSnapshotRef.current = undefined;
      const pruned = pruneSnapshot(
        (pending as { grid?: { root?: unknown } })?.grid?.root,
        new Set(regions.map((region) => region.id)),
      );
      if (pruned !== null) {
        try {
          api.clear();
          api.fromJSON({
            ...(pending as object),
            grid: { ...(pending as { grid?: object }).grid, root: pruned },
          } as SerializedDockview);
          restoredRef.current = true;
        } catch (cause) {
          // 快照与当前面板集不匹配等损坏:回落默认布局,不静默吞。
          consumeKnownError(cause);
          api.clear();
        }
      }
      syncCollapsed();
      relayout();
      reconcile(api);
      return;
    }
    reconcile(api);
    syncCollapsed();
  }, [ready, reconcile, regions, relayout, settled, syncCollapsed]);

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
      dockable,
      collapse,
      expand,
    }),
    [available, collapse, controls, dock, dockKeyboard, dockable, expand, registry, resizeSeam],
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
        {collapsedIds.length > 0 && (
          <CollapsedStrip testId={testId} ids={collapsedIds} titles={registry} onExpand={expand} />
        )}
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

/** 序列化树叶子的当前尺寸(splitview 数值,不依赖 DOM 量尺;测试环境也可靠)。
 * 叶子 size 沿父分支方向:水平支里是宽、纵向支里是高,调用方按自己所处的阶段取义。 */
function leafSizeOf(api: DockviewApi, id: string): number | null {
  let found: number | null = null;
  const walk = (node: unknown): void => {
    const branch = asBranch(node);
    if (branch !== null) {
      for (const child of branch.data ?? []) walk(child);
      return;
    }
    if (leafView(node) === id) found = (node as SerializedLeaf).size ?? null;
  };
  walk(api.toJSON().grid.root);
  return found;
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

/** 折叠区域召回条:被折叠区域的 DOM 已收起(把手不可达),召回入口只能由宿主常驻提供。 */
function CollapsedStrip({
  testId,
  ids,
  titles,
  onExpand,
}: {
  readonly testId: string;
  readonly ids: readonly string[];
  readonly titles: ReadonlyMap<string, PageRegionSpec>;
  readonly onExpand: (id: string) => void;
}) {
  return (
    <div
      className="flex flex-none flex-wrap items-center gap-1"
      role="group"
      aria-label={t("components.pageRegions.expandGroup")}
      data-testid={`${testId}-collapsed`}
    >
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          aria-label={t("components.pageRegions.expand", { title: titles.get(id)?.title ?? id })}
          title={t("components.pageRegions.expand", { title: titles.get(id)?.title ?? id })}
          onClick={onExpand.bind(null, id)}
          data-testid={`${testId}-expand-${id}`}
          className="flex h-6 shrink-0 items-center gap-1 rounded-sm border border-border px-1.5 text-text-faint ui-meta hover:border-border-strong hover:bg-surface-raised hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {titles.get(id)?.title ?? id}
        </button>
      ))}
    </div>
  );
}
