import { useState } from "react";
import type { WorkspaceScopeRead } from "../../api/renderer-dto.ts";
import { useTaskDocumentQuery } from "../task-data.ts";
import { DocReader } from "./DocReader.tsx";

export function WorkspaceGoal({
  scope,
  repoId,
  onOpenTask,
}: {
  readonly scope: WorkspaceScopeRead;
  readonly repoId: string;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-text">完成条件</h2>
      <p className="text-sm text-text-muted">任务完成数反映工作进展，交付条件按任务要求单独验收。</p>
      {scope.goalMaterial ? (
        <>
          <button type="button" className="text-sm text-accent" onClick={() => setOpen(!open)} aria-expanded={open}>
            查看 task_plan.md
          </button>
          {open && repoId !== "unselected" ? <GoalBody repoId={repoId} taskId={scope.goalMaterial.taskId} /> : null}
          <button
            type="button"
            className="block text-sm text-accent"
            onClick={() => onOpenTask(scope.goalMaterial!.taskId)}
          >
            打开任务材料 →
          </button>
        </>
      ) : (
        <p className="text-sm text-text-muted">目标材料未投影</p>
      )}
    </section>
  );
}

function GoalBody({ repoId, taskId }: { readonly repoId: string; readonly taskId: string }) {
  const query = useTaskDocumentQuery(repoId, taskId, "task_plan.md");
  if (query.isPending) return <p className="text-sm text-text-muted">正在读取完成条件…</p>;
  if (!query.data || query.data.status !== "ready")
    return <p className="text-sm text-text-muted">暂时无法读取正文，请打开任务材料。</p>;
  const body = query.data.uncommitted && query.data.worktreeBody !== null ? query.data.worktreeBody : query.data.body;
  return (
    <div className="max-h-96 overflow-auto break-words">
      {query.data.uncommitted ? <p className="text-sm text-warning">工作树内容尚未提交。</p> : null}
      <DocReader content={body} />
    </div>
  );
}
