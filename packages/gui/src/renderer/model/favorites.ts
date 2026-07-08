import { useCallback, useEffect, useState } from "react";

/**
 * GUI 本地偏好:收藏的任务集合。
 *
 * 设计取向(见 task_plan 收藏项):
 * - 仅持久化在浏览器/electron renderer 的 localStorage,**不写台账、不发明 kernel 字段**。
 * - 跨端共享需另起 decision(若未来需要,通过 triadic API 写 fact 或新增字段,不在本任务面)。
 * - key 命名空间区分项目,避免不同 root 的 task 撞 id(虽然 taskId 全局唯一,但显式隔离更安全)。
 */
const STORAGE_PREFIX = "harness:gui:favorites";

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}:${projectId}`;
}

function readFavorites(projectId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function writeFavorites(projectId: string, ids: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(projectId), JSON.stringify([...ids]));
  } catch {
    // 隐私模式或 quota 满:静默降级,不阻断 UI。
  }
}

/**
 * 收藏状态 hook。返回当前收藏集合 + toggle/has 三件套。
 * 多组件实例间通过 storage 事件 + 手动 refresh 同步。
 */
export function useFavorites(projectId: string): {
  favorites: Set<string>;
  isFavorite: (taskId: string) => boolean;
  toggleFavorite: (taskId: string) => void;
} {
  const [favorites, setFavorites] = useState<Set<string>>(() => readFavorites(projectId));

  useEffect(() => {
    setFavorites(readFavorites(projectId));
  }, [projectId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey(projectId)) {
        setFavorites(readFavorites(projectId));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [projectId]);

  const toggleFavorite = useCallback((taskId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      writeFavorites(projectId, next);
      return next;
    });
  }, [projectId]);

  const isFavorite = useCallback((taskId: string) => favorites.has(taskId), [favorites]);

  return { favorites, isFavorite, toggleFavorite };
}
