import type { TaskFilters } from "../model/taskFilters.ts";
import type { SnapshotStatus } from "../model/types.ts";
import type { LaneGroupBy } from "../views/SwimlaneBoard.tsx";
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
 * AppShell 级全局视图导航历史(移植老 main 线 navigationHistory,贴 rebuild 现状)。
 *
 * focusHistory 只记一个 node id,活在 GraphView 里;本模块把「历史条目」泛化成
 * 完整应用位置快照(AppLocation:view / selectedId / previewId / focusedEntityRef /
 * taskFilters / drill),让后退/前进能跨视图还原用户位置。
 * 迁移逻辑与 focusHistory 共用泛型核心 historyStack.ts。
 *
 * 纯函数 + 显式 state,不挂 React,以便 vitest 直接覆盖。
 */

export type ViewId =
  | "home"
  | "overview"
  | "board"
  | "decisions"
  | "decisionPool"
  | "factTriage"
  | "executionEvidence"
  | "graph"
  | "presets"
  | "adapters"
  | "agents"
  | "system"
  | "settings";

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

export type ViewHistoryState = HistoryState<AppLocation>;

export { canGoBack, canGoForward, goBack, goForward };

export function createViewHistory(initial: AppLocation): ViewHistoryState {
  return { entries: [initial], index: 0 };
}

export function currentLocation(state: ViewHistoryState): AppLocation {
  const head = current(state);
  if (head === null) throw new Error("view history is always seeded with an initial location");
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

/** 推一个新位置(截断 forward;与当前位置相同则 no-op)。 */
export function pushLocation(
  state: ViewHistoryState,
  next: AppLocation,
): ViewHistoryState {
  return push(state, next, locationsEqual);
}

/** 原地更新当前位置(不推栈)。用于过滤器微调等非导航性变更。 */
export function patchCurrent(
  state: ViewHistoryState,
  fields: Partial<AppLocation>,
): ViewHistoryState {
  return patch(state, { ...currentLocation(state), ...fields }, locationsEqual);
}
