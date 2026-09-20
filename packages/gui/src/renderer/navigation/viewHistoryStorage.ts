import { DEFAULT_TASK_FILTERS, type TaskFilters } from "../model/taskFilters.ts";
import { ATTESTATION_POOL_TABS, type AttestationPoolTabId } from "../model/attestation-pool.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";
import { createViewHistory, type AppLocation, type ViewId, type ViewHistoryState } from "./viewHistory.ts";
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

// 恢复白名单必须始终覆盖整个 ViewId 联合:漏一个 id,对应视图的存储位置就会被
// 判非法而回落 overview(freshness/tokenUsage 曾漏)。列表只写这一份,后面的条件
// 类型让新增 ViewId 忘记登记时在编译期变红,不再靠人眼对齐。
const VIEW_ID_LIST = [
  "home",
  "overview",
  "board",
  "decisionPool",
  "freshness",
  "cadence",
  "decisionDetail",
  "factDetail",
  "graph",
  "presets",
  "entities",
  "adapters",
  "sessions",
  "schedules",
  "artifacts",
  "agentSquad",
  "providers",
  "tokenUsage",
  "terminal",
  "browser",
  "system",
  "daemonObserve",
  "settings",
] as const satisfies readonly ViewId[];
type MissingViewId = Exclude<ViewId, (typeof VIEW_ID_LIST)[number]>;
const _viewListExhaustive: MissingViewId extends never ? true : never = true;
void _viewListExhaustive;

const VIEW_IDS: ReadonlySet<string> = new Set<ViewId>(VIEW_ID_LIST);

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isCanonicalFocusedRef(value: unknown): boolean {
  return (
    value === null ||
    typeof value !== "string" ||
    !value.startsWith("fact/") ||
    /^fact\/F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(value)
  );
}

function isTaskFilters(value: unknown): value is TaskFilters {
  if (!isRendererRecord(value)) return false;
  return (
    typeof value.query === "string" &&
    typeof value.module === "string" &&
    typeof value.engine === "string" &&
    Array.isArray(value.status) &&
    value.status.every((status) => typeof status === "string") &&
    typeof value.closeout === "string" &&
    typeof value.freshness === "string" &&
    typeof value.favoritesOnly === "boolean" &&
    typeof value.expandColdTerminal === "boolean"
  );
}

function isAppLocation(value: unknown): value is AppLocation {
  if (!isRendererRecord(value) || typeof value.view !== "string" || !VIEW_IDS.has(value.view)) return false;
  if (
    !isNullableString(value.selectedId) ||
    !isNullableString(value.previewId) ||
    !isNullableString(value.focusedEntityRef) ||
    !(value.browserUrl === undefined || isNullableString(value.browserUrl)) ||
    !isCanonicalFocusedRef(value.focusedEntityRef) ||
    !isTaskFilters(value.taskFilters)
  )
    return false;
  // poolTab 是后加字段:旧存储没有它照样可读,消费侧按 "decisions" 解释。
  if (value.poolTab !== undefined && !ATTESTATION_POOL_TABS.includes(value.poolTab as AttestationPoolTabId))
    return false;
  const drill = value.drill;
  return (
    drill === null ||
    (isRendererRecord(drill) &&
      typeof drill.lane === "string" &&
      typeof drill.status === "string" &&
      (drill.groupBy === "root" ||
        drill.groupBy === "module" ||
        drill.groupBy === "engine" ||
        drill.groupBy === "productLine"))
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
    browserUrl: null,
    selectedId: null,
    previewId: null,
    focusedEntityRef: null,
    taskFilters: filters ?? { ...DEFAULT_TASK_FILTERS },
    drill: null,
    poolTab: "decisions",
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
    storage.setItem(storageKey(projectId), JSON.stringify({ schema: VIEW_HISTORY_SCHEMA, history }));
  } catch (cause) {
    // 导航在存储不可用/写满时必须继续工作;失败被显式消费(不静默吞)。
    consumeKnownError(cause);
  }
}

/** 为指定仓写入干净初始栈(打开项目时复位到 overview + 默认筛选)。 */
export function resetViewHistory(storage: Pick<ViewHistoryStorage, "setItem">, projectId: string): void {
  writeViewHistory(storage, projectId, createViewHistory(initialLocation()));
}
