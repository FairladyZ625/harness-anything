import type { TaskWipRead } from "../../api/renderer-dto.ts";
import type { TaskRow } from "../model/types.ts";

export function TaskWipSummary({ snapshot }: { readonly snapshot?: TaskWipRead }) {
  if (!snapshot) return null;
  const declared = snapshot.roots.filter((root) => root.reason === "declared"),
    derived = snapshot.roots.filter((root) => root.reason === "derived"),
    rootDetail = [
      `declared milestone: ${declared.map((root) => root.taskId).join(", ") || "none"}`,
      `derived root: ${
        derived.map((root) => `${root.taskId} (${root.directChildCount} children)`).join(", ") || "none"
      }`,
    ].join("; ");
  return (
    <div className="flex items-center gap-2 font-mono ui-meta text-text-muted" data-testid="task-wip-summary">
      <span title={`上限来源: ${snapshot.limitLabel}`}>
        WIP {snapshot.counted.length}/{snapshot.limit}
      </span>
      <span title={rootDetail}>root {snapshot.roots.length}</span>
    </div>
  );
}

export function TaskRootBadge({ task }: { readonly task: TaskRow }) {
  const root = task.rootAssessment;
  if (!root) return null;
  const label = root.reason === "declared" ? "milestone" : `derived ${root.directChildCount} children`;
  return (
    <span
      className="inline-flex shrink-0 rounded border border-border px-1 font-mono ui-micro text-text-muted"
      data-testid={`task-root-badge-${task.taskId}`}
      title={`root threshold ${root.threshold}`}
    >
      {label}
    </span>
  );
}
