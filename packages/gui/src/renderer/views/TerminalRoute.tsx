import type { TaskRow } from "../model/types.ts";
import type { AppLocation } from "../navigation/viewHistory.ts";
import { TerminalView, type TerminalLaunchTask } from "./TerminalView.tsx";

/**
 * App 外壳里终端页的接线面(自 App.tsx 按职责拆出):只做 props 适配——任务行裁剪成
 * 终端树需要的字段、URL 出口翻译成一次跨视图 navigate。行为与拆出前逐字相同。
 */
export function TerminalRoute({
  repoId,
  daemonGeneration,
  repoRoot,
  tasks,
  launchTask,
  navigate,
  onNavigateEntity,
  onOpenDocument,
}: {
  readonly repoId: string;
  readonly daemonGeneration: number | null;
  readonly repoRoot: string | null;
  readonly tasks: readonly TaskRow[];
  readonly launchTask: TerminalLaunchTask | null;
  readonly navigate: (fields: Partial<AppLocation>) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onOpenDocument: (path: string) => void;
}) {
  return (
    <TerminalView
      repoId={repoId}
      daemonGeneration={daemonGeneration}
      tasks={tasks.map(({ taskId, title, parentTaskId, coordinationStatus, createdAt }) => ({
        taskId,
        title,
        parentTaskId,
        status: coordinationStatus,
        createdAt,
      }))}
      repoRoot={repoRoot}
      launchTask={launchTask}
      onNavigateEntity={onNavigateEntity}
      onOpenDocument={onOpenDocument}
      openUrl={(uri) =>
        navigate({ view: "browser", browserUrl: uri, focusedEntityRef: null, selectedId: null, previewId: null })
      }
    />
  );
}
