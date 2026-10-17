import { useCallback, useEffect, useState } from "react";
import { isRedesignViewId, type NavViewId, type RedesignViewId } from "./navConfig.tsx";
import type { AppLocation, ViewId } from "./viewHistory.ts";

/** 重构区尚不属于全局历史栈；导航到旧页面或实体后离开该临时页面状态。 */
export function useRedesignNavigation(location: AppLocation, goto: (id: ViewId) => void) {
  const [redesignView, setRedesignView] = useState<RedesignViewId | null>(null);
  useEffect(() => setRedesignView(null), [location]);
  const gotoNav = useCallback(
    (id: NavViewId) => {
      if (isRedesignViewId(id)) setRedesignView(id);
      else {
        setRedesignView(null);
        goto(id);
      }
    },
    [goto],
  );
  return { redesignView, gotoNav };
}
