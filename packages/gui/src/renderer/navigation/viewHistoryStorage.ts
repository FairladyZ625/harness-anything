import { DEFAULT_TASK_FILTERS, type TaskFilters } from "../model/taskFilters.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";
import {
  createViewHistory,
  type AppLocation,
  type ViewId,
  type ViewHistoryState,
} from "./viewHistory.ts";
import { isRendererRecord } from "../result-validation.ts";

/**
 * 视图导航历史的 sessionStorage 持久化(移植老 main 线 navigationHistoryStorage)。
 * 按 projectId 分键:切仓各自恢复自己的栈;解析失败一律回退到干净初始栈,
 * 绝不让坏存储挡住导航。
 */

const VIEW_HISTORY_SCHEMA = "gui-view-history/v1";
const STORAGE_PREFIX = "harness-view-history";

export interface ViewHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const VIEW_IDS: ReadonlySet<string> = new Set<ViewId>([
  "home",
  "overview",
  "board",
  "decisions",
  "decisionPool",
  "decisionDetail",
  "factDetail",
  "graph",
  "presets",
  "adapters",
  "sessions",
  "agentSquad",
  "providers",
  "system",
  "settings",
]);

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isTaskFilters(value: unknown): value is TaskFilters {
  if (!isRendererRecord(value)) return false;
  return (
    typeof value.query === "string"
    && typeof value.module === "string"
    && typeof value.engine === "string"
    && Array.isArray(value.status)
    && value.status.every((status) => typeof status === "string")
    && typeof value.closeout === "string"
    && typeof value.freshness === "string"
    && typeof value.includeArchived === "boolean"
    && typeof value.favoritesOnly === "boolean"
  );
}

function isAppLocation(value: unknown): value is AppLocation {
  if (!isRendererRecord(value) || typeof value.view !== "string" || !VIEW_IDS.has(value.view)) return false;
  if (
    !isNullableString(value.selectedId)
    || !isNullableString(value.previewId)
    || !isNullableString(value.focusedEntityRef)
    || !isTaskFilters(value.taskFilters)
  ) return false;
  const drill = value.drill;
  return drill === null || (
    isRendererRecord(drill)
    && typeof drill.lane === "string"
    && typeof drill.status === "string"
    && (drill.groupBy === "root" || drill.groupBy === "module" || drill.groupBy === "engine" || drill.groupBy === "productLine")
  );
}

function isStoredViewHistory(value: unknown): value is { schema: string; history: ViewHistoryState } {
  if (!isRendererRecord(value) || value.schema !== VIEW_HISTORY_SCHEMA) return false;
  const history: unknown = value.history;
  if (!isRendererRecord(history) || !Array.isArray(history.entries) || history.entries.length === 0) return false;
  const index: unknown = history.index;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= history.entries.length) return false;
  return history.entries.every(isAppLocation);
}

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}:${projectId}`;
}

export function initialLocation(filters?: TaskFilters): AppLocation {
  return {
    view: "overview",
    selectedId: null,
    previewId: null,
    focusedEntityRef: null,
    taskFilters: filters ?? { ...DEFAULT_TASK_FILTERS },
    drill: null,
  };
}

export function readViewHistory(
  storage: Pick<ViewHistoryStorage, "getItem">,
  projectId: string,
  fallback: AppLocation = initialLocation(),
): ViewHistoryState {
  const raw = storage.getItem(storageKey(projectId));
  if (!raw) return createViewHistory(fallback);
  try {
    const stored: unknown = JSON.parse(raw);
    return isStoredViewHistory(stored) ? stored.history : createViewHistory(fallback);
  } catch {
    return createViewHistory(fallback);
  }
}

export function writeViewHistory(
  storage: Pick<ViewHistoryStorage, "setItem">,
  projectId: string,
  history: ViewHistoryState,
): void {
  try {
    storage.setItem(
      storageKey(projectId),
      JSON.stringify({ schema: VIEW_HISTORY_SCHEMA, history }),
    );
  } catch (cause) {
    // 导航在存储不可用/写满时必须继续工作;失败被显式消费(不静默吞)。
    consumeKnownError(cause);
  }
}

/** 为指定仓写入干净初始栈(打开项目时复位到 overview + 默认筛选)。 */
export function resetViewHistory(
  storage: Pick<ViewHistoryStorage, "setItem">,
  projectId: string,
): void {
  writeViewHistory(storage, projectId, createViewHistory(initialLocation()));
}
