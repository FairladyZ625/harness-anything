import { MyAsksView } from "./MyAsksView.tsx";

/** App-shell 注入的稳定读面与导航出口;具体页面留在独立重构区目录。 */
export function myAsksViewEntry(
  repoId: string,
  onOpenTask: (taskId: string) => void,
  onNavigateEntity: (ref: string) => void,
) {
  return <MyAsksView repoId={repoId} onOpenTask={onOpenTask} onNavigateEntity={onNavigateEntity} />;
}
