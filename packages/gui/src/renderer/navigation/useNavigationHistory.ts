import { useCallback, useEffect, useState } from "react";
import type { AppLocation, NavigationHistoryState } from "./navigationHistory.ts";
import {
  canGoBack,
  canGoForward,
  currentLocation,
  goBack as historyGoBack,
  goForward as historyGoForward,
  patchCurrent,
  pushLocation,
} from "./navigationHistory.ts";
import {
  readNavigationHistory,
  writeNavigationHistory,
} from "./navigationHistoryStorage.ts";

/**
 * AppShell 全局导航历史 hook。
 *
 * 历史栈是应用位置的**唯一真源**:entries[index] 即当前位置,所有读取走
 * `location.*`,所有变更走 `navigate()` 或 `updateLocation()`。
 *
 * - `navigate(patch)`:合并 patch 到当前位置 → 推入历史(截断 forward)。
 *   用于视图切换、跨实体跳转、打开任务详情等「导航」。
 * - `updateLocation(patch)`:合并 patch 到当前位置 → 原地改(不推栈)。
 *   用于过滤器微调、抽屉开关等「精修」——不该单独占一个历史条目。
 *
 * 这个设计让「所有导航都进历史栈」成为**结构性不变量**:没有独立的
 * setView / setSelectedId / ... —— 下一个改 App.tsx 的人想绕过历史栈,
 * 得先把 setter 加回来,而 navigationHistory.vitest.ts 的源码扫描会拦住。
 */
export function useNavigationHistory(projectId: string, initial: AppLocation) {
  const [history, setHistory] = useState<NavigationHistoryState>(() =>
    readNavigationHistory(window.sessionStorage, projectId, initial),
  );

  useEffect(() => {
    writeNavigationHistory(window.sessionStorage, projectId, history);
  }, [history, projectId]);

  const location = currentLocation(history);

  const navigate = useCallback((patch: Partial<AppLocation>) => {
    setHistory((prev) => {
      const next: AppLocation = { ...currentLocation(prev), ...patch };
      return pushLocation(prev, next);
    });
  }, []);

  const updateLocation = useCallback((patch: Partial<AppLocation>) => {
    setHistory((prev) => patchCurrent(prev, patch));
  }, []);

  const back = useCallback(() => {
    setHistory((prev) => historyGoBack(prev));
  }, []);

  const forward = useCallback(() => {
    setHistory((prev) => historyGoForward(prev));
  }, []);

  return {
    location,
    navigate,
    updateLocation,
    back,
    forward,
    canBack: canGoBack(history),
    canForward: canGoForward(history),
  };
}
