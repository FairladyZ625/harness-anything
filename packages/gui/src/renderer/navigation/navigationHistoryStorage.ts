import {
  createNavigationHistory,
  type AppLocation,
  type NavigationHistoryState,
} from "./navigationHistory.ts";

const NAVIGATION_HISTORY_SCHEMA = "gui-navigation-history/v1";
const STORAGE_PREFIX = "harness-navigation-history";

export interface NavigationHistorySessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredNavigationHistory {
  readonly schema: typeof NAVIGATION_HISTORY_SCHEMA;
  readonly history: NavigationHistoryState;
}

const VIEW_IDS = new Set([
  "home",
  "overview",
  "board",
  "decisions",
  "decisionPool",
  "factTriage",
  "executions",
  "graph",
  "presets",
  "adapters",
  "settings",
]);

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableStringValue(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isAppLocation(value: unknown): value is AppLocation {
  if (!isRecordValue(value) || !VIEW_IDS.has(String(value.view))) return false;
  if (
    !isNullableStringValue(value.selectedId)
    || !isNullableStringValue(value.previewId)
    || !isNullableStringValue(value.focusedEntityRef)
    || !(value.entityFacet === null || value.entityFacet === "relations" || value.entityFacet === "lineage")
  ) return false;
  const filters = value.taskFilters;
  if (!isRecordValue(filters)) return false;
  if (
    typeof filters.query !== "string"
    || typeof filters.module !== "string"
    || typeof filters.engine !== "string"
    || !Array.isArray(filters.status)
    || !filters.status.every((status) => typeof status === "string")
    || typeof filters.closeout !== "string"
    || typeof filters.freshness !== "string"
    || typeof filters.includeArchived !== "boolean"
    || typeof filters.favoritesOnly !== "boolean"
  ) return false;
  const drill = value.drill;
  return drill === null || (
    isRecordValue(drill)
    && typeof drill.lane === "string"
    && typeof drill.status === "string"
    && (drill.groupBy === "root" || drill.groupBy === "module")
  );
}

function isStoredNavigationHistory(value: unknown): value is StoredNavigationHistory {
  if (!value || typeof value !== "object") return false;
  const stored = value as Partial<StoredNavigationHistory>;
  const history = stored.history;
  return stored.schema === NAVIGATION_HISTORY_SCHEMA
    && Boolean(history)
    && Array.isArray(history?.entries)
    && history.entries.length > 0
    && history.entries.every(isAppLocation)
    && Number.isInteger(history.index)
    && history.index >= 0
    && history.index < history.entries.length;
}

function navigationHistoryStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}:${projectId}`;
}

export function readNavigationHistory(
  storage: NavigationHistorySessionStorage,
  projectId: string,
  fallback: AppLocation,
): NavigationHistoryState {
  const raw = storage.getItem(navigationHistoryStorageKey(projectId));
  if (!raw) return createNavigationHistory(fallback);
  try {
    const stored: unknown = JSON.parse(raw);
    return isStoredNavigationHistory(stored)
      ? stored.history
      : createNavigationHistory(fallback);
  } catch {
    return createNavigationHistory(fallback);
  }
}

export function writeNavigationHistory(
  storage: NavigationHistorySessionStorage,
  projectId: string,
  history: NavigationHistoryState,
): void {
  const stored: StoredNavigationHistory = {
    schema: NAVIGATION_HISTORY_SCHEMA,
    history,
  };
  try {
    storage.setItem(navigationHistoryStorageKey(projectId), JSON.stringify(stored));
  } catch {
    // Navigation must keep working when session storage is unavailable or full.
  }
}
