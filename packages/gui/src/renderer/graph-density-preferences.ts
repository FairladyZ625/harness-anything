import { consumeKnownError } from "../api/error-consumption.ts";

/**
 * 关系图「重点模式」开关的本地记忆(task_5ba031c2)。
 *
 * 与 graph-territory-preferences.ts 同形:判定本体在 model/taskFilters.ts
 * (isTaskGraphFocusSeed,与看板共用),这里只管开关的 localStorage 读写。
 * 默认 **开**(重点模式):200+ task 的台账默认铺满不可读。语义与 archived 开关
 * 镜像 —— 只有显式 false 才关,null(未设)/坏 JSON/其他值一律回落默认:开。
 * 读坏永不挡视图;写坏(隐私模式/quota 满)只是本会话不记忆。
 */
const storageKey = "harness:gui:graph-density-focus-mode";

/** renderer 的 localStorage;非 DOM 环境(如 SSR 渲染)返回 null,偏好回落默认。 */
export function graphDensityPreferenceStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function readGraphDensityFocusMode(
  storage: { getItem(key: string): string | null } | null | undefined,
): boolean {
  if (!storage) return true;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    // 只有显式 false 才关;未设/坏 JSON/其他值回落默认开。
    return parsed !== false;
  } catch (cause) {
    consumeKnownError(cause);
    return true;
  }
}

export function writeGraphDensityFocusMode(
  storage: { setItem(key: string, value: string): void } | null | undefined,
  focusMode: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(focusMode));
  } catch (cause) {
    // 隐私模式/quota 满:本会话开关仍生效,只是不跨会话记忆(显式消费,不静默吞)。
    consumeKnownError(cause);
  }
}
