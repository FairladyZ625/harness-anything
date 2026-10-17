import { initialLocation } from "./viewHistoryStorage.ts";
import { useViewHistory } from "./useViewHistory.ts";
import { useLocationRestore } from "./useLocationRestore.ts";

/** 应用位置由跨视图历史栈持有；页面只消费该栈导出的当前位置与导航操作。 */
export function useAppLocation(projectId: string) {
  const locationState = useViewHistory(projectId, initialLocation());
  useLocationRestore(locationState.location, document.body);
  return locationState;
}
