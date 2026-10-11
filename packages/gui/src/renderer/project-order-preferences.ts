import { useCallback, useEffect, useState } from "react";
import { consumeKnownError } from "../api/error-consumption.ts";
import { isRendererRecord } from "./result-validation.ts";

/**
 * 项目置顶顺序的本地持久化(业主 2026-10-11:常用项目排前面快速切换):置顶的
 * repoId 按置顶先后存 renderer localStorage(同 favorites/board-column,单观看者
 * 的便利状态,不进台账),换窗口/重启仍保持。排序是稳定划分:置顶行按置顶顺序
 * 排前,其余行保持调用方传入的顺序(不另立第二套排序意见)。
 */
const STORAGE_KEY = "harness:gui:project-order";

export interface ProjectOrderPreferences {
  readonly pinned: readonly string[];
}

export const emptyProjectOrder: ProjectOrderPreferences = { pinned: [] };

export function readProjectOrder(
  storage: { getItem(key: string): string | null } | null | undefined,
): ProjectOrderPreferences {
  if (!storage) return emptyProjectOrder;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    if (!isRendererRecord(parsed) || !Array.isArray(parsed.pinned)) return emptyProjectOrder;
    return { pinned: parsed.pinned.filter((id): id is string => typeof id === "string") };
  } catch (cause) {
    consumeKnownError(cause);
    return emptyProjectOrder;
  }
}

export function writeProjectOrder(
  storage: { setItem(key: string, value: string): void } | null | undefined,
  preferences: ProjectOrderPreferences,
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch (cause) {
    // 偏好在存储不可用/写满时静默降级,不阻断切换器。
    consumeKnownError(cause);
  }
}

/** 置顶/取消置顶:新置顶追加尾部(最后置顶的在最后),取消则移除。 */
export function toggleProjectPin(preferences: ProjectOrderPreferences, repoId: string): ProjectOrderPreferences {
  return preferences.pinned.includes(repoId)
    ? { pinned: preferences.pinned.filter((candidate) => candidate !== repoId) }
    : { pinned: [...preferences.pinned, repoId] };
}

/** 稳定划分:置顶行按置顶顺序在前,其余行保持传入顺序(sort 稳定;已不存在的 repoId 自然失效)。 */
export function orderProjects<T extends { readonly repoId: string }>(
  repos: ReadonlyArray<T>,
  pinned: ReadonlyArray<string>,
): T[] {
  const rank = new Map(pinned.map((repoId, index) => [repoId, index]));
  return [...repos].sort((left, right) => (rank.get(left.repoId) ?? Infinity) - (rank.get(right.repoId) ?? Infinity));
}

/**
 * 置顶顺序 hook:App 持有唯一实例下传(切换器与管理页同一条顺序),多窗口经
 * storage 事件同步(同 favorites 模式)。
 */
export function useProjectOrder(): {
  readonly pinned: readonly string[];
  readonly isPinned: (repoId: string) => boolean;
  readonly togglePin: (repoId: string) => void;
} {
  const [pinned, setPinned] = useState<readonly string[]>(() => readProjectOrder(window.localStorage).pinned);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setPinned(readProjectOrder(window.localStorage).pinned);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const togglePin = useCallback((repoId: string) => {
    setPinned((prev) => {
      const next = toggleProjectPin({ pinned: prev }, repoId);
      writeProjectOrder(window.localStorage, next);
      return next.pinned;
    });
  }, []);

  return { pinned, isPinned: useCallback((repoId: string) => pinned.includes(repoId), [pinned]), togglePin };
}
