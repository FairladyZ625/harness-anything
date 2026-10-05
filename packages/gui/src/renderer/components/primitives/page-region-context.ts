import { createContext, useContext, type ReactNode } from "react";
import type { PaneDirection } from "../../terminal-pane-focus.ts";

/**
 * 页面区域停靠分屏(任务 task_033760e2…)的渲染层契约:布局树由 dockview 承载(同终端
 * 分屏),面板内容按 region id 从宿主的注册表取——停靠只挪 dockview 的 group(DOM 节点
 * 原地搬家),React 内容不重挂,阅读状态不丢。宿主(PageRegions)与面板(RegionPanel)
 * 之间的全部通道都走这里的 context,不经过 dockview params。
 */

/** 停靠半区:指针落在目标区域的哪条边一侧,放下就按那个方向二分。 */
export type RegionDockZone = "left" | "right" | "above" | "below";

export interface PageRegionHostActions {
  /** 当前渲染帧的区域注册表(id → 区域);面板据此渲染自己的内容。 */
  readonly regions: ReadonlyMap<string, PageRegionSpec>;
  /** 区域头里的布局控件组,只挂在首个区域(与旧 SplitLayoutControls 同位)。 */
  readonly controls: (id: string) => ReactNode;
  /** 指针停靠:把 source 挪到 target 的指定半区,各占目标原空间一半。 */
  readonly dock: (source: string, target: string, zone: RegionDockZone) => void;
  /** 键盘停靠:把本区域挪到该方向相邻区域的那一侧(拖拽的键盘替代)。 */
  readonly dockKeyboard: (id: string, direction: PaneDirection) => void;
  /** 键盘调缝:沿该方向增/减本区域在该轴上的尺寸(拖分隔条的键盘替代)。 */
  readonly resizeSeam: (id: string, direction: PaneDirection, delta: number) => void;
  /** 停靠是否可行(目标未折叠且原空间装得下两块最小尺寸):遮罩只给可行的半区。 */
  readonly dockable: (target: string, zone: RegionDockZone) => boolean;
  /** 折叠本区域(grid 可见性:DOM 保留、尺寸缓存,恢复回原位原尺寸)。 */
  readonly collapse: (id: string) => void;
  /** 恢复折叠的区域;召回入口由宿主的折叠条常驻提供。 */
  readonly expand: (id: string) => void;
}

export interface PageRegionSpec {
  readonly id: string;
  readonly title: string;
  readonly content: ReactNode;
  readonly weight?: number;
  readonly testId?: string;
}

export const PageRegionHostContext = createContext<PageRegionHostActions | null>(null);

/** 区域与文档头消费的同一把手/控件槽位:由面板在每个区域内部提供,正文输入不受牵连。 */
export const RegionHandleContext = createContext<ReactNode>(null);
export const RegionControlsContext = createContext<ReactNode>(null);

export function usePageRegionHost(): PageRegionHostActions {
  const host = useContext(PageRegionHostContext);
  if (host === null) throw new Error("RegionPanel must render inside PageRegions");
  return host;
}
