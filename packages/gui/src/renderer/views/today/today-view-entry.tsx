import type { AgendaSuccess } from "../../api-client.ts";
import type { NavViewId } from "../../navigation/navConfig.tsx";
import { TodayView } from "./TodayView.tsx";

/** App-shell 注入的稳定读面与导航出口；具体页面留在独立重构区目录。 */
export function todayViewEntry(
  repoId: string,
  agenda: AgendaSuccess | undefined,
  agendaError: string | null,
  titles: ReadonlyMap<string, string>,
  onNavigateEntity: (ref: string) => void,
  onOpenTask: (taskId: string) => void,
  gotoNav: (id: NavViewId) => void,
) {
  return (
    <TodayView
      repoId={repoId}
      agenda={agenda}
      agendaError={agendaError}
      titles={titles}
      onNavigateEntity={onNavigateEntity}
      onOpenTask={onOpenTask}
      onOpenAgenda={() => gotoNav("agenda")}
      onOpenSessions={() => gotoNav("sessions")}
    />
  );
}
