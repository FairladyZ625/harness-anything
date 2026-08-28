import { consumeKnownError } from "../api/error-consumption.ts";

/**
 * 关系图领地视图「显示已归档」开关的本地记忆(task_b92c5138)。
 *
 * 判定本体在 model/taskFilters.ts(isTaskArchiveNoise,与看板共用,不第二份);
 * 这里只管开关状态的 localStorage 读写。偏好语义与 terminal-preferences 同款:
 * 默认 false(隐藏 cancelled/archived),坏值/坏存储回落默认,偏好读坏绝不挡视图。
 * 按视图记忆:聚光灯不受此开关影响,也不共享这个键。
 */
const storageKey = "harness:gui:graph-territory-show-archived";

/** renderer 的 localStorage;非 DOM 环境(如 SSR 渲染)返回 null,偏好回落默认。 */
export function graphTerritoryPreferenceStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function readGraphTerritoryShowArchived(
  storage: { getItem(key: string): string | null } | null | undefined,
): boolean {
  if (!storage) return false;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    // 只有显式 true 才打开;null(未设)/坏 JSON/其他值一律回落默认:隐藏。
    return parsed === true;
  } catch (cause) {
    consumeKnownError(cause);
    return false;
  }
}

export function writeGraphTerritoryShowArchived(
  storage: { setItem(key: string, value: string): void } | null | undefined,
  showArchived: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(showArchived));
  } catch (cause) {
    // 隐私模式/quota 满:本会话开关仍生效,只是不跨会话记忆(显式消费,不静默吞)。
    consumeKnownError(cause);
  }
}
