import type { ComponentProps } from "react";
import { TaskDetailView } from "./TaskDetailView.tsx";
import { taskReviewRef } from "../navigation/entityRoutes.ts";
import type { RelationEdge, TaskRow } from "../model/types.ts";
import type { TaskDecisionRef } from "../components/taskDetail/TaskRelationsTab.tsx";

/**
 * Task 详情的组合入口(从 App.tsx 按职责拆出,App 行数门 file-complexity):三处落点
 * (列表选中、工作页根任务、预览抽屉反向)共用同一份 TaskDetailView 布线;App 只声明
 * 依赖,不在视图文件里重复组合。回调签名直接取 TaskDetailView 的 props 类型,不复制。
 */

type OnProgress = NonNullable<ComponentProps<typeof TaskDetailView>["onProgress"]>;
type OnAttest = NonNullable<ComponentProps<typeof TaskDetailView>["onAttest"]>;

/** App 提供的任务级写通道与导航出口;task 由调用方逐次传入。 */
export interface TaskDetailEntryWires {
  readonly projectId: string;
  readonly connectionId: string | null;
  readonly projectName: string;
  readonly tasks: readonly TaskRow[];
  readonly relations: RelationEdge[];
  readonly decisions: readonly TaskDecisionRef[];
  readonly onSelect: (taskId: string) => void;
  readonly onOpenWork: (taskId: string) => void;
  readonly onNavigateDecision: (decisionId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onFocusGraph: ((ref: string) => void) | undefined;
  readonly getMutationFeedback: (taskId: string) => ComponentProps<typeof TaskDetailView>["mutationFeedback"];
  readonly onProgress: (task: TaskRow, input: Parameters<OnProgress>[0]) => Promise<unknown>;
  readonly onSubmit: (task: TaskRow) => Promise<unknown>;
  readonly onComplete: (task: TaskRow) => Promise<unknown>;
  readonly onAdjudicate: (
    task: TaskRow,
    decision: "forward" | "return",
    reason: string,
    reviewId?: string,
  ) => Promise<unknown>;
  readonly onReturnNote: (task: TaskRow, reason: string, reviewId?: string) => Promise<unknown>;
  readonly onConsentReview: (task: TaskRow, reviewId: string) => Promise<unknown>;
  readonly onAttest: OnAttest;
  readonly onSetPin: (task: TaskRow, pinned: boolean) => void;
  readonly onOpenTerminal: (task: TaskRow) => void;
  readonly focusedEntityRef: string | null;
  readonly recordFocus: { readonly taskId: string; readonly recordRef: string } | null;
  readonly docFocus: { readonly taskId: string; readonly docPath: string } | null;
}

export function taskDetailEntry(
  task: TaskRow,
  framing: { readonly onBack: () => void; readonly fromViewLabel: string; readonly embedded?: boolean },
  wires: TaskDetailEntryWires,
) {
  const work =
    framing.embedded || task.workId === undefined || task.workId === task.taskId
      ? null
      : { taskId: task.workId, title: task.workTitle ?? task.workId };
  return (
    <TaskDetailView
      repoId={wires.projectId}
      connectionId={wires.connectionId}
      task={task}
      tasks={wires.tasks}
      relations={wires.relations}
      decisions={wires.decisions}
      onBack={framing.onBack}
      onSelect={wires.onSelect}
      projectName={wires.projectName}
      fromViewLabel={framing.fromViewLabel}
      work={work}
      onOpenWork={wires.onOpenWork}
      onNavigateDecision={wires.onNavigateDecision}
      onNavigateEntity={wires.onNavigateEntity}
      mutationFeedback={wires.getMutationFeedback(task.taskId)}
      onProgress={(input) => wires.onProgress(task, input)}
      onSubmit={() => wires.onSubmit(task)}
      onComplete={() => wires.onComplete(task)}
      onAdjudicate={(decision, reason, reviewId) => wires.onAdjudicate(task, decision, reason, reviewId)}
      onReturnNote={(reason, reviewId) => wires.onReturnNote(task, reason, reviewId)}
      onConsentReview={(reviewId) => wires.onConsentReview(task, reviewId)}
      onAttest={wires.onAttest}
      onSetPin={wires.onSetPin}
      onOpenTerminal={wires.onOpenTerminal}
      onFocusGraph={wires.onFocusGraph}
      initialTab={!framing.embedded && wires.focusedEntityRef === taskReviewRef(task.taskId) ? "closeout" : undefined}
      initialRecordFocus={
        !framing.embedded && wires.recordFocus !== null && wires.recordFocus.taskId === task.taskId
          ? wires.recordFocus.recordRef
          : undefined
      }
      initialDocFocus={
        !framing.embedded && wires.docFocus !== null && wires.docFocus.taskId === task.taskId
          ? wires.docFocus.docPath
          : undefined
      }
    />
  );
}
