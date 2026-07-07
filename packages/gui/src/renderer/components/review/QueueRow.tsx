import type { TaskRow } from "../../model/types";
import { isExternal } from "../../model/types";
import { EngineBadge, FreshnessTag } from "../badges";
import { waitLabel } from "./shared";

export function QueueRow({
  task,
  active,
  onSetCurrent,
  onPreview,
}: {
  task: TaskRow;
  active: boolean;
  onSetCurrent: (id: string) => void;
  onPreview: (id: string) => void;
}) {
  const failed = task.gates.filter((gate) => !gate.ok);
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        active ? "border-accent bg-accent/10" : "border-border bg-surface"
      }`}
    >
      <button onClick={() => onPreview(task.taskId)} className="block w-full text-left hover:text-accent">
        <span className="font-mono text-[13px] text-text-faint">{task.taskId}</span>
        <span className="mt-1 line-clamp-2 text-[15px] font-medium leading-snug text-text">
          {task.title}
        </span>
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <EngineBadge engine={task.engine} locked={isExternal(task)} />
        <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
        <span className="font-mono text-[12px] text-text-faint">wait {waitLabel(task.waitingSince)}</span>
      </div>
      {failed.length > 0 && (
        <div className="mt-2 line-clamp-1 text-[13px] text-danger">
          {failed.map((gate) => gate.name).join(", ")}
        </div>
      )}
      <button
        onClick={() => onSetCurrent(task.taskId)}
        className="mt-2 w-full rounded-md border border-border px-2 py-1.5 text-[13px] text-text-muted hover:bg-surface-raised hover:text-text"
      >
        设为当前审阅
      </button>
    </div>
  );
}
