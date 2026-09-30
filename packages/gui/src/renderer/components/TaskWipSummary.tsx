import type { TaskWipRead } from "../../api/renderer-dto.ts";

export function TaskWipSummary({ snapshot }: { readonly snapshot?: TaskWipRead }) {
  if (!snapshot) return null;
  const declared = snapshot.roots.filter((root) => root.reason === "declared"),
    derived = snapshot.roots.filter((root) => root.reason === "derived"),
    rootDetail = [
      `declared work: ${declared.map((root) => root.taskId).join(", ") || "none"}`,
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
