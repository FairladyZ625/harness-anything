import { useCallback, useEffect, useState } from "react";
import type { AppLocation, ViewHistoryState } from "./viewHistory.ts";
import {
  canGoBack,
  canGoForward,
  currentLocation,
  goBack,
  goForward,
  patchCurrent,
  pushLocation,
} from "./viewHistory.ts";
import { readViewHistory, writeViewHistory } from "./viewHistoryStorage.ts";

/**
 * AppShell 全局视图导航历史 hook(移植老 main 线 useNavigationHistory)。
 *
 * 历史栈是应用位置的唯一真源:entries[index] 即当前位置,读取走 location.*,
 * 变更走 navigate()(推栈、截断 forward)或 updateLocation()(原地改,不推栈)。
 *
 * - navigate:视图切换、跨实体跳转、打开任务详情等「导航」。
 * - updateLocation:过滤器微调、抽屉开关等「精修」,不单独占历史条目。
 * - 按 projectId 分键持久化(sessionStorage):切仓时同步重读该仓自己的栈
 *   (render 期派生 state,避免旧栈被写到新仓的键下)。
 */
export function useViewHistory(projectId: string, initial: AppLocation) {
  const [state, setState] = useState(() => ({
    projectId,
    history: readViewHistory(window.sessionStorage, projectId, initial),
  }));

  if (state.projectId !== projectId) {
    // 切仓:丢弃旧仓栈,读新仓栈。render 期 setState 是 React 官方派生模式。
    setState({
      projectId,
      history: readViewHistory(window.sessionStorage, projectId, initial),
    });
  }

  const { history } = state;
  const location = currentLocation(history);

  useEffect(() => {
    writeViewHistory(window.sessionStorage, projectId, history);
  }, [history, projectId]);

  const setHistory = useCallback((update: (prev: ViewHistoryState) => ViewHistoryState) => {
    setState((prev) => ({ ...prev, history: update(prev.history) }));
  }, []);

  const navigate = useCallback((fields: Partial<AppLocation>) => {
    setHistory((prev) => pushLocation(prev, { ...currentLocation(prev), ...fields }));
  }, [setHistory]);

  const updateLocation = useCallback((fields: Partial<AppLocation>) => {
    setHistory((prev) => patchCurrent(prev, fields));
  }, [setHistory]);

  const back = useCallback(() => {
    setHistory((prev) => goBack(prev));
  }, [setHistory]);

  const forward = useCallback(() => {
    setHistory((prev) => goForward(prev));
  }, [setHistory]);

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
