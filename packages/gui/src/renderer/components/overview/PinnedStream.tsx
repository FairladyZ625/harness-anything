import { PushPin } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { SnapshotStatus, TaskRow } from "../../model/types";
import { STATUS_META, StatusBadge } from "../badges.tsx";
import { t } from "../../i18n/index.tsx";
import { StreamBody, StreamEmpty, streamTime } from "./streamParts.tsx";
import type { AgendaSuccess } from "../../api-client.ts";

export interface PinnedAgendaItem {
  readonly taskId: string;
  readonly title: string;
  readonly status: SnapshotStatus;
  readonly updatedAt: string;
}

const PINNED_ROW_CLASS_NAME = [
  "flex items-center gap-2 rounded-md border border-border bg-accent-fg/40 px-2 py-1",
  "[contain-intrinsic-size:auto_1.75rem] [content-visibility:auto] hover:border-accent/60",
].join(" ");

const PIN_TOGGLE_CLASS_NAME = [
  "inline-flex shrink-0 items-center justify-center rounded p-0.5 text-[13px]",
  "text-accent hover:bg-surface",
].join(" ");

/**
 * `repo.agenda.read` 的 pinned-first 四组收拢为一个 task 集。active task 可能同时
 * 出现在「在飞」和「球在别人手里」,所以 taskId 去重;待复核 execution 还原为
 * 其所属的 in_review task。排序只用投影携带的时间,不依赖尚未水化完的 task list。
 */
export function pinnedAgendaItems(agenda: AgendaSuccess): readonly PinnedAgendaItem[] {
  const rows = new Map<string, PinnedAgendaItem>();
  const accept = (item: PinnedAgendaItem) => {
    const current = rows.get(item.taskId);
    if (!current || item.updatedAt > current.updatedAt) rows.set(item.taskId, item);
  };
  for (const group of [agenda.inFlight, agenda.waitingOnOthers, agenda.dispatchable]) {
    for (const row of group) {
      if (row.pinned !== true) continue;
      accept({ taskId: row.taskId, title: row.title, status: row.status, updatedAt: row.updatedAt });
    }
  }
  for (const row of agenda.awaitingDecision) {
    if (row.kind !== "execution" || row.pinned !== true) continue;
    accept({ taskId: row.taskId, title: row.title, status: "in_review", updatedAt: row.submittedAt });
  }
  return [...rows.values()].sort(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.taskId.localeCompare(left.taskId),
  );
}

/**
 * 总览「Pin 在做」直接使用 `ha agenda` 的 `repo.agenda.read` 结果,而不是等待
 * repo.tasks.list 的 cursor 水化走到碰巧包含 pinned task 的页。pin 与「进行中」
 * 正交:进行中未必在做,在做未必进行中。
 *
 * 不分批(判据,留给下一个人核对):本流成员的唯一来源是「被人手动 `ha task pin` 过」,
 * 每一行都是一次显式的人为动作,unpin 即移除;规模由人的当前关注集决定,
 * 不会仅因历史台账增长而增长。
 * 全站已不再用「再显示」分批(2026-08-25 泽宇裁决):行集增长也走完整渲染 +
 * content-visibility,按 TaskStream 同款类名即可。
 */
export function PinnedStream({
  agenda,
  onOpenPreview,
  onSetPin,
}: {
  agenda: AgendaSuccess | undefined;
  onOpenPreview: (taskId: string) => void;
  onSetPin?: (task: Pick<TaskRow, "taskId">, pinned: boolean) => void;
}) {
  const rows = useMemo(() => (agenda ? pinnedAgendaItems(agenda) : []), [agenda]);

  if (!agenda) return <StreamEmpty>{t("views.overviewView.pinnedLoading")}</StreamEmpty>;

  if (rows.length === 0) {
    return (
      <StreamEmpty>
        {t("views.overviewView.pinnedEmpty")}{" "}
        <span className="font-mono text-[12px] text-text-faint">{t("views.overviewView.pinnedHint")}</span>
      </StreamEmpty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="shrink-0 font-mono text-[10px] text-text-faint" data-testid="pinned-projection-cut">
        {t("views.overviewView.pinnedProjection", {
          count: rows.length,
          watermark: String(agenda.watermark),
        })}
      </p>
      <StreamBody testId="pinned-stream-rows">
        {rows.map((task) => (
          <div key={task.taskId} className={PINNED_ROW_CLASS_NAME}>
            <button
              type="button"
              onClick={() => onOpenPreview(task.taskId)}
              title={`${task.taskId} · ${task.title}`}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="shrink-0 text-[13px]" style={{ color: STATUS_META[task.status].color }}>
                {STATUS_META[task.status].icon}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{task.title}</span>
              <StatusBadge status={task.status} />
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-faint">
                {streamTime(task.updatedAt)}
              </span>
            </button>
            {onSetPin ? (
              <button
                type="button"
                data-testid={`overview-pin-toggle-${task.taskId}`}
                onClick={() => onSetPin(task, false)}
                aria-pressed="true"
                title={t("views.overviewView.unpinTitle")}
                className={PIN_TOGGLE_CLASS_NAME}
              >
                <PushPin weight="fill" />
              </button>
            ) : (
              <PushPin weight="fill" className="shrink-0 text-[13px] text-accent" />
            )}
          </div>
        ))}
      </StreamBody>
    </div>
  );
}
