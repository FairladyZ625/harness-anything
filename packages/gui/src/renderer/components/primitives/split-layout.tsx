import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
  CaretLeft,
  CaretUp,
  SplitHorizontal,
  SplitVertical,
} from "@phosphor-icons/react";
import { ColumnResizeHandle } from "../ColumnResizeHandle.tsx";
import {
  readSplitPreferences,
  setSplitSlot,
  splitPreferenceStorage,
  writeSplitPreferences,
  type SplitOrientation,
  type SplitPanePreference,
  type SplitSlotMap,
} from "../../split-layout-preferences.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 原页面内容区域的共享分割布局(task_fb3ba20d66…):两处真实消费——任务详情的
 * 「文件树|正文」与工作概况的「主区|最近进展」——同一套「排列(左右/上下) + 拖分隔条
 * 调比例 + 折叠(仅首窗) + 重置」交互。默认(无偏好)完全走调用方既有的自适应布局,
 * DOM 与类名不变;用户显式选了排列或拖过比例后,布局改由「固定两窗 + 显式比例」接管,
 * 重置即回到自适应。偏好按连接+仓+页面槽存 localStorage(split-layout-preferences)。
 *
 * 调用方结构:容器挂 containerRef,自备 auto 类名;显式模式用 splitGridTemplate 生成
 * 内联 grid 模板(首窗 | 6px 分隔条 | 次窗),分隔条是真实 grid 轨道子元素(拖动有独立
 * 命中区,不压在内容点击上)。长内容在各自窗内滚动(模板的 minmax(0,…) 保证不撑开容器)。
 */

/** 分隔条轨道宽度(0.375rem);手柄 12px 命中区居中骑在轨道上。 */
export const SPLIT_GUTTER_PX = 6;

const fr = (fraction: number) => `${(fraction * 100).toFixed(2)}fr`;

/** 显式模式的 grid 模板:首窗占 ratio,中间 6px 分隔条轨道,次窗占余量。 */
export function splitGridTemplate(orientation: SplitOrientation, ratio: number): CSSProperties {
  return orientation === "row"
    ? {
        gridTemplateColumns: `minmax(0,${fr(ratio)}) ${SPLIT_GUTTER_PX}px minmax(0,${fr(1 - ratio)})`,
        gridTemplateRows: "minmax(0,1fr)",
      }
    : {
        gridTemplateRows: `minmax(0,${fr(ratio)}) ${SPLIT_GUTTER_PX}px minmax(0,${fr(1 - ratio)})`,
        gridTemplateColumns: "minmax(0,1fr)",
      };
}

/** 首窗折叠态的模板:只剩恢复条 + 次窗。 */
export function collapsedGridTemplate(orientation: SplitOrientation): CSSProperties {
  return orientation === "row"
    ? { gridTemplateColumns: `1.5rem minmax(0,1fr)`, gridTemplateRows: "minmax(0,1fr)" }
    : { gridTemplateRows: `1.5rem minmax(0,1fr)`, gridTemplateColumns: "minmax(0,1fr)" };
}

export interface UseSplitLayoutOptions {
  /** 偏好归属的连接(system status 仓行的 connectionId);null = 连接未解析,仅会话内态。 */
  readonly connectionId: string | null;
  /** 偏好归属的仓;连接+仓+页面槽组成存储键,跨连接/跨仓不串用。 */
  readonly repoId: string;
  /** 页面槽键,如 "task-detail-docs" / "work-overview"。 */
  readonly slot: string;
  /** 首窗最小/最大占比(不含分隔条);交互 clamp,保证两窗都不可被拖到不可用。 */
  readonly minRatio: number;
  readonly maxRatio: number;
  /** 显式排列下未拖过比例时的起步占比。 */
  readonly defaultRatioRow: number;
  readonly defaultRatioColumn: number;
  /** 自适应模式下按容器宽度决定有效排列(量容器自身,与调用方 @container 断点一致)。 */
  readonly autoBreakpoint: number;
  /** 是否提供首窗折叠(任务详情的文件树导航);工作概况不需要。 */
  readonly collapsible: boolean;
}

export interface SplitLayout {
  /** 挂到分割容器的 ref(量可用空间,auto 模式据此判行列)。 */
  readonly containerRef: (element: HTMLElement | null) => void;
  /** "auto" = 无显式偏好,走调用方自适应类名;否则为用户显式排列。 */
  readonly mode: "auto" | SplitOrientation;
  /** 实际生效的排列(auto 按容器宽度解析;显式即偏好值)。 */
  readonly effectiveOrientation: SplitOrientation;
  /** 当前生效的首窗占比(显式模式下总有效)。 */
  readonly ratio: number;
  readonly collapsed: boolean;
  /** 分隔条手柄的现值与界限(px,随容器实测大小换算)。 */
  readonly dividerProps: {
    readonly orientation: SplitOrientation;
    readonly panePx: number;
    readonly minPx: number;
    readonly maxPx: number;
    readonly onPanePxChange: (px: number) => void;
    readonly onReset: () => void;
  };
  readonly controlsProps: {
    readonly mode: "auto" | SplitOrientation;
    readonly collapsed: boolean;
    readonly collapsible: boolean;
    readonly onOrientation: (orientation: SplitOrientation) => void;
    readonly onToggleCollapse: () => void;
    readonly onReset: () => void;
  };
}

export function useSplitLayout(options: UseSplitLayoutOptions): SplitLayout {
  const { connectionId, repoId, slot, minRatio, maxRatio, autoBreakpoint } = options;
  const [pref, setPref] = useState<SplitPanePreference>(() =>
    connectionId === null ? {} : (readSplitPreferences(splitPreferenceStorage(), connectionId, repoId)[slot] ?? {}),
  );
  // 连接/仓/槽任一切换(多仓导航,或仓被 registry 改挂到另一连接)时重读,不沿用上一身份的偏好。
  useEffect(() => {
    setPref(
      connectionId === null ? {} : (readSplitPreferences(splitPreferenceStorage(), connectionId, repoId)[slot] ?? {}),
    );
  }, [connectionId, repoId, slot]);

  // 写穿透(同看板列宽):每次调整即落 localStorage,重启/重载后保留。
  const commit = useCallback(
    (next: SplitPanePreference) => {
      setPref(next);
      // 连接身份未解析(如系统状态未就绪):只改本会话布局,不猜键落盘。
      if (connectionId === null) return;
      const storage = splitPreferenceStorage();
      const slots: SplitSlotMap = setSplitSlot(readSplitPreferences(storage, connectionId, repoId), slot, next);
      writeSplitPreferences(storage, connectionId, repoId, slots);
    },
    [connectionId, repoId, slot],
  );

  // 容器量尺:ref 回调挂载/换元素时自管 ResizeObserver(auto 排列解析与 px↔比例换算共用)。
  // 值相等时保持原对象:ref 重挂/观察器回调不因新对象身份触发重渲染。
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const containerRef = useCallback((element: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (element === null) return;
    const measure = () =>
      setSize((current) => {
        const width = element.clientWidth,
          height = element.clientHeight;
        return current.width === width && current.height === height ? current : { width, height };
      });
    const observer = new ResizeObserver(measure);
    observerRef.current = observer;
    observer.observe(element);
    measure();
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const mode = pref.orientation ?? "auto";
  const effectiveOrientation = pref.orientation ?? (size.width >= autoBreakpoint ? "row" : "column");
  const ratio = pref.ratio ?? (effectiveOrientation === "row" ? options.defaultRatioRow : options.defaultRatioColumn);
  const collapsed = pref.collapsed === true;
  const splittable = Math.max(0, (effectiveOrientation === "row" ? size.width : size.height) - SPLIT_GUTTER_PX);
  const clampRatio = useCallback(
    (value: number) => Math.min(maxRatio, Math.max(minRatio, value)),
    [minRatio, maxRatio],
  );
  const setPanePx = useCallback(
    (px: number) => {
      if (splittable <= 0) return;
      const next = clampRatio(px / splittable);
      if (pref.ratio !== next) commit({ ...pref, ratio: next });
    },
    [clampRatio, commit, pref, splittable],
  );
  const setOrientation = useCallback(
    (orientation: SplitOrientation) => {
      if (pref.orientation === orientation) return;
      commit({ ...pref, orientation });
    },
    [commit, pref],
  );
  const toggleCollapse = useCallback(() => {
    commit({ ...pref, collapsed: !pref.collapsed });
  }, [commit, pref]);
  const reset = useCallback(() => commit({}), [commit]);

  return {
    containerRef,
    mode,
    effectiveOrientation,
    ratio,
    collapsed,
    dividerProps: {
      orientation: effectiveOrientation,
      panePx: Math.round(ratio * splittable),
      minPx: Math.round(minRatio * splittable),
      maxPx: Math.round(maxRatio * splittable),
      onPanePxChange: setPanePx,
      onReset: reset,
    },
    controlsProps: {
      mode,
      collapsed,
      collapsible: options.collapsible,
      onOrientation: setOrientation,
      onToggleCollapse: toggleCollapse,
      onReset: reset,
    },
  };
}

/** 显式模式的两窗分隔条:6px 轨道 + 骑在轨道上的 12px 拖拽手柄(键盘可达,双击重置)。 */
export function SplitDivider({
  orientation,
  panePx,
  minPx,
  maxPx,
  onPanePxChange,
  onReset,
  label,
  testId,
}: {
  readonly orientation: SplitOrientation;
  readonly panePx: number;
  readonly minPx: number;
  readonly maxPx: number;
  readonly onPanePxChange: (px: number) => void;
  readonly onReset: () => void;
  /** 无障碍名,如「调整任务文件与正文的分隔」。 */
  readonly label: string;
  readonly testId?: string;
}) {
  const vertical = orientation === "row";
  return (
    <div
      className={`relative ${vertical ? "w-[0.375rem]" : "h-[0.375rem]"}`}
      data-testid={testId === undefined ? undefined : `${testId}-track`}
    >
      <ColumnResizeHandle
        label={label}
        orientation={vertical ? "vertical" : "horizontal"}
        width={panePx}
        min={minPx}
        max={maxPx}
        onChange={onPanePxChange}
        onReset={onReset}
        testId={testId}
        // 手柄 12px 命中区居中骑在 6px 轨道上,两侧各溢出 3px,不压内容的可点击主体。
        className={vertical ? "left-1/2 inset-y-0 -translate-x-1/2" : "top-1/2 inset-x-0 -translate-y-1/2"}
      />
    </div>
  );
}

/** 首窗折叠后的恢复条:整条就是一个展开按钮(收起文件树后唯一的召回路径,重置也可)。 */
export function SplitExpandStrip({
  orientation,
  onExpand,
  label,
  testId,
}: {
  readonly orientation: SplitOrientation;
  readonly onExpand: () => void;
  readonly label: string;
  readonly testId?: string;
}) {
  const vertical = orientation === "row";
  return (
    <div
      className={`grid ${vertical ? "w-6 border-r" : "h-6 border-b"} place-items-center border-border bg-surface`}
      data-testid={testId === undefined ? undefined : `${testId}-track`}
    >
      <button
        type="button"
        onClick={onExpand}
        aria-label={label}
        title={label}
        data-testid={testId}
        className="grid size-6 shrink-0 place-items-center rounded-sm text-text-faint hover:bg-surface-raised hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {vertical ? <CaretRight weight="bold" className="ui-meta" /> : <CaretDown weight="bold" className="ui-meta" />}
      </button>
    </div>
  );
}

const CONTROL_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-sm border border-border text-text-faint " +
  "hover:border-border-strong hover:bg-surface-raised hover:text-text " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
  "aria-pressed:border-accent/50 aria-pressed:bg-accent/10 aria-pressed:text-accent";

/** 分割控件组:左右/上下排列(可感知按压态;auto 时均未按)、折叠首窗、重置默认。 */
export function SplitLayoutControls({
  mode,
  collapsed,
  collapsible,
  onOrientation,
  onToggleCollapse,
  onReset,
  testId,
}: {
  readonly mode: "auto" | SplitOrientation;
  readonly collapsed: boolean;
  readonly collapsible: boolean;
  readonly onOrientation: (orientation: SplitOrientation) => void;
  readonly onToggleCollapse: () => void;
  readonly onReset: () => void;
  readonly testId?: string;
}) {
  return (
    <div
      className="flex items-center gap-1"
      role="group"
      aria-label={t("components.splitLayout.group")}
      data-testid={testId}
    >
      <button
        type="button"
        aria-pressed={mode === "row"}
        aria-label={t("components.splitLayout.row")}
        title={t("components.splitLayout.rowTitle")}
        onClick={() => onOrientation("row")}
        data-testid={testId === undefined ? undefined : `${testId}-row`}
        className={CONTROL_BUTTON}
      >
        <SplitHorizontal weight="bold" className="ui-meta" />
      </button>
      <button
        type="button"
        aria-pressed={mode === "column"}
        aria-label={t("components.splitLayout.column")}
        title={t("components.splitLayout.columnTitle")}
        onClick={() => onOrientation("column")}
        data-testid={testId === undefined ? undefined : `${testId}-column`}
        className={CONTROL_BUTTON}
      >
        <SplitVertical weight="bold" className="ui-meta" />
      </button>
      {collapsible ? (
        <button
          type="button"
          aria-pressed={collapsed}
          aria-label={collapsed ? t("components.splitLayout.expand") : t("components.splitLayout.collapse")}
          title={collapsed ? t("components.splitLayout.expand") : t("components.splitLayout.collapse")}
          onClick={onToggleCollapse}
          data-testid={testId === undefined ? undefined : `${testId}-collapse`}
          className={CONTROL_BUTTON}
        >
          {collapsed ? (
            <CaretRight weight="bold" className="ui-meta" />
          ) : mode === "column" ? (
            <CaretUp weight="bold" className="ui-meta" />
          ) : (
            <CaretLeft weight="bold" className="ui-meta" />
          )}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={t("components.splitLayout.reset")}
        title={t("components.splitLayout.resetTitle")}
        onClick={onReset}
        data-testid={testId === undefined ? undefined : `${testId}-reset`}
        className={CONTROL_BUTTON}
      >
        <ArrowCounterClockwise weight="bold" className="ui-meta" />
      </button>
    </div>
  );
}
