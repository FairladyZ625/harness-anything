import { DEFAULT_TASK_FILTERS, type TaskFilters } from "../model/taskFilters.ts";
import { ATTESTATION_POOL_TABS, type AttestationPoolTabId } from "../model/attestation-pool.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";
import {
  createViewHistory,
  type AppLocation,
  type DrillState,
  type ViewId,
  type ViewHistoryState,
} from "./viewHistory.ts";
import type { LaneGroupBy } from "../views/SwimlaneBoard.tsx";
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
  "work",
  "agenda",
  "overviewNext",
  "workspace",
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

/**
 * 旧存储的 taskFilters 可能带 `module` 键(模块分组已随 dec_5F7E74F1 删除):
 * 这里只挑出现存字段重建筛选,把它丢掉而不是拒绝整条位置——已存的导航栈照样可读。
 */
function restoreTaskFilters(value: unknown): TaskFilters | null {
  if (!isRendererRecord(value)) return null;
  const { query, engine, status, closeout, freshness, favoritesOnly, expandColdTerminal } = value;
  if (
    typeof query !== "string" ||
    typeof engine !== "string" ||
    !Array.isArray(status) ||
    !status.every((entry) => typeof entry === "string") ||
    typeof closeout !== "string" ||
    typeof freshness !== "string" ||
    typeof favoritesOnly !== "boolean" ||
    typeof expandColdTerminal !== "boolean"
  )
    return null;
  return {
    query,
    engine,
    status,
    closeout,
    freshness,
    favoritesOnly,
    expandColdTerminal,
  } as TaskFilters;
}

const LANE_GROUP_BYS: ReadonlySet<unknown> = new Set<LaneGroupBy>(["root", "engine", "productLine"]);

/**
 * drill 还原:合法 → 原样;旧存储里按已删除的 `module` 维度下钻的 drill 丢成 null
 * (lane 是模块名,对现存维度没有意义),位置本身保留;其余形状 → undefined(拒绝)。
 */
function restoreDrill(drill: unknown): DrillState | null | undefined {
  if (drill === null) return null;
  if (!isRendererRecord(drill) || typeof drill.lane !== "string" || typeof drill.status !== "string") return undefined;
  if (drill.groupBy === "module") return null;
  return LANE_GROUP_BYS.has(drill.groupBy) ? (drill as unknown as DrillState) : undefined;
}

function restoreAppLocation(value: unknown): AppLocation | null {
  if (!isRendererRecord(value) || typeof value.view !== "string" || !VIEW_IDS.has(value.view)) return null;
  if (
    !isNullableString(value.selectedId) ||
    !isNullableString(value.previewId) ||
    !isNullableString(value.focusedEntityRef) ||
    !(value.browserUrl === undefined || isNullableString(value.browserUrl)) ||
    !(value.scopeRootTaskId === undefined || isNullableString(value.scopeRootTaskId)) ||
    !isCanonicalFocusedRef(value.focusedEntityRef)
  )
    return null;
  // poolTab 是后加字段:旧存储没有它照样可读,消费侧按 "decisions" 解释。
  if (value.poolTab !== undefined && !ATTESTATION_POOL_TABS.includes(value.poolTab as AttestationPoolTabId))
    return null;
  const taskFilters = restoreTaskFilters(value.taskFilters);
  const drill = restoreDrill(value.drill);
  if (taskFilters === null || drill === undefined) return null;
  return { ...(value as unknown as AppLocation), taskFilters, drill };
}

function restoreStoredViewHistory(value: unknown): ViewHistoryState | null {
  if (!isRendererRecord(value) || value.schema !== VIEW_HISTORY_SCHEMA) return null;
  const history: unknown = value.history;
  if (!isRendererRecord(history) || !Array.isArray(history.entries) || history.entries.length === 0) return null;
  const index: unknown = history.index;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= history.entries.length) return null;
  const entries: AppLocation[] = [];
  for (const entry of history.entries as unknown[]) {
    const location = restoreAppLocation(entry);
    if (location === null) return null;
    entries.push(location);
  }
  return { entries, index: index as number };
}

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}:${projectId}`;
}

export function initialLocation(filters?: TaskFilters): AppLocation {
  return {
    view: "overview",
    scopeRootTaskId: null,
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
    return restoreStoredViewHistory(JSON.parse(raw)) ?? createViewHistory(fallback);
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
