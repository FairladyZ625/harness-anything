import { useMemo } from "react";
import type { TaskRow } from "../../model/types";
import { STATUS_META, StatusBadge } from "../badges.tsx";
import { t } from "../../i18n/index.tsx";
import { StreamBody, StreamEmpty, streamTime } from "./streamParts.tsx";

/**
 * 总览「Pin 在做」:`task.pinned === true` 的任务——台账 pin 字段
 * (`ha task pin` 写入),与「进行中」正交:进行中未必在做,在做未必进行中。
 * 无状态切换(它就是单一答案);lastKnownAt 倒序;行点击开任务预览抽屉。
 */
export function PinnedStream({
  tasks,
  onOpenPreview,
}: {
  tasks: ReadonlyArray<TaskRow>;
  onOpenPreview: (taskId: string) => void;
}) {
  const rows = useMemo(
    () =>
      tasks
        .filter((task) => task.pinned === true)
        .sort((left, right) => right.lastKnownAt.localeCompare(left.lastKnownAt) || right.taskId.localeCompare(left.taskId)),
    [tasks],
  );

  if (rows.length === 0) {
    return (
      <StreamEmpty>
        {t("views.overviewView.pinnedEmpty")}{" "}
        <span className="font-mono text-[12px] text-text-faint">{t("views.overviewView.pinnedHint")}</span>
      </StreamEmpty>
    );
  }

  return (
    <StreamBody testId="pinned-stream-rows" maxHeightClass="max-h-[18rem]">
      {rows.map((task) => (
        <button
          key={task.taskId}
          type="button"
          onClick={() => onOpenPreview(task.taskId)}
          title={`${task.taskId} · ${task.title}`}
          className="flex w-full items-center gap-2 rounded-md border border-border bg-accent-fg/40 px-2 py-1 text-left transition-colors duration-100 [contain-intrinsic-size:auto_1.75rem] [content-visibility:auto] hover:border-accent/60"
        >
          <span className="shrink-0 text-[13px]" style={{ color: STATUS_META[task.coordinationStatus].color }}>
            {STATUS_META[task.coordinationStatus].icon}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{task.title}</span>
          <StatusBadge status={task.coordinationStatus} />
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-faint">{streamTime(task.lastKnownAt)}</span>
        </button>
      ))}
    </StreamBody>
  );
}
