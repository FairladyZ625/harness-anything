import type { TaskFilters } from "../model/taskFilters.ts";
import type { SnapshotStatus } from "../model/types.ts";
import type { LaneGroupBy } from "../views/SwimlaneBoard.tsx";
import type { ViewId } from "../shell-config.tsx";
import {
  canGoBack,
  canGoForward,
  current,
  goBack,
  goForward,
  patch,
  push,
  type HistoryState,
} from "./historyStack.ts";

/**
 * AppShell 级全局导航历史(泛化自 graph/focusHistory.ts)。
 *
 * focusHistory 只记一个 node id,活在 GraphView 里,离开图就销毁。本模块把
 * 「历史条目」从 node id 泛化成完整的应用位置快照(AppLocation)——涵盖构成
 * 「我在哪」的全部六个状态(view / selectedId / previewId / focusedEntityRef /
 * taskFilters / drill),让后退/前进能跨视图还原用户的位置。
 *
 * 迁移逻辑(back/forward/前向截断/原地更新)与 focusHistory 共用同一个泛型核心
 * historyStack.ts —— 两者只在「条目类型」与「两个条目算不算同一个」上不同,
 * 不各写一遍。本模块只提供 AppLocation 这一种特化:
 *   - pushLocation 截断 forward 栈(经典浏览器语义):从历史中间换位置后,旧 future 作废。
 *   - 重复推相同位置视为 no-op,避免把栈灌满。
 *   - patchCurrent 原地更新当前位置(不推栈)——用于过滤器微调、抽屉开关等
 *     非导航性变更,不单独占一个历史条目,但快照里保留最新值。
 *
 * 纯函数 + 显式 state,刻意不挂 React,以便 vitest 直接覆盖。
 */

export interface DrillState {
  lane: string;
  status: SnapshotStatus;
  groupBy: LaneGroupBy;
}

export interface AppLocation {
  view: ViewId;
  selectedId: string | null;
  previewId: string | null;
  focusedEntityRef: string | null;
  taskFilters: TaskFilters;
  drill: DrillState | null;
}

export type NavigationHistoryState = HistoryState<AppLocation>;

export { canGoBack, canGoForward, goBack, goForward };

export function createNavigationHistory(initial: AppLocation): NavigationHistoryState {
  return { entries: [initial], index: 0 };
}

export function currentLocation(state: NavigationHistoryState): AppLocation {
  const head = current(state);
  if (head === null) throw new Error("navigation history is always seeded with an initial location");
  return head;
}

/** 结构化比较两个应用位置是否等价(taskFilters / drill 含嵌套结构,走 JSON 序列化)。 */
export function locationsEqual(a: AppLocation, b: AppLocation): boolean {
  return (
    a.view === b.view &&
    a.selectedId === b.selectedId &&
    a.previewId === b.previewId &&
    a.focusedEntityRef === b.focusedEntityRef &&
    JSON.stringify(a.taskFilters) === JSON.stringify(b.taskFilters) &&
    JSON.stringify(a.drill) === JSON.stringify(b.drill)
  );
}

/**
 * 推一个新位置。与当前位置相同则 no-op(防误灌栈)。截断 forward 栈:
 * 从历史中间换位置后,旧 future 作废。
 */
export function pushLocation(
  state: NavigationHistoryState,
  next: AppLocation,
): NavigationHistoryState {
  return push(state, next, locationsEqual);
}

/**
 * 原地更新当前位置(不推栈)。用于过滤器微调等非导航性变更——
 * 用户「调了一下筛选」不该单独占一个历史条目,但下次导航的快照里应带上最新值。
 */
export function patchCurrent(
  state: NavigationHistoryState,
  fields: Partial<AppLocation>,
): NavigationHistoryState {
  return patch(state, { ...currentLocation(state), ...fields }, locationsEqual);
}
