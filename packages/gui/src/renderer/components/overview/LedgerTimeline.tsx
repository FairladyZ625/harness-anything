import { ClipboardText, Scales } from "@phosphor-icons/react";
import type { DecisionRow, TaskRow } from "../../model/types.ts";
import { DecisionStateBadge, StatusBadge } from "../badges.tsx";
import { buildLedgerTimeline } from "../../model/ledger-timeline.ts";
import { t } from "../../i18n/index.tsx";

const dateTime = (iso: string) => iso.slice(5, 16).replace("T", " ");

/**
 * 主页任务流:任务 + 决策按创建时间倒序混排(老 Archive 主线的形态)。
 * 内联滚动、不截断——新建的 Task / Decision 出现在最上面,打开主页即可见。
 * 时间语义与排序见 model/ledger-timeline.ts。
 */
export function LedgerTimeline({
  tasks,
  decisions,
  onOpenTask,
  onOpenDecision,
}: {
  tasks: ReadonlyArray<TaskRow>;
  decisions: ReadonlyArray<DecisionRow>;
  onOpenTask: (id: string) => void;
  onOpenDecision: (id: string) => void;
}) {
  const entries = buildLedgerTimeline(tasks, decisions);
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const decisionById = new Map(decisions.map((decision) => [decision.decisionId, decision]));

  if (entries.length === 0) {
    return (
      <p className="rounded-md border border-border bg-surface-raised px-3 py-4 text-[13px] text-text-faint">
        {t("views.overviewView.timelineEmpty")}
      </p>
    );
  }

  return (
    <div className="max-h-[30rem] space-y-1.5 overflow-y-auto pr-1" data-testid="ledger-timeline">
      {entries.map((entry) => {
        const task = entry.kind === "task" ? taskById.get(entry.id) : undefined;
        const decision = entry.kind === "decision" ? decisionById.get(entry.id) : undefined;
        return (
          <button
            key={`${entry.kind}:${entry.id}`}
            type="button"
            onClick={() => (entry.kind === "task" ? onOpenTask(entry.id) : onOpenDecision(entry.id))}
            title={entry.id}
            // 长流不截断;离屏行跳过渲染成本,滚动仍覆盖全部实体。
            className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-2 text-left transition-colors duration-100 [contain-intrinsic-size:auto_2.5rem] [content-visibility:auto] hover:border-accent/60"
          >
            {entry.kind === "task" ? (
              <ClipboardText weight="bold" className="shrink-0 text-text-faint" />
            ) : (
              <Scales weight="bold" className="shrink-0 text-accent" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-text">{entry.title}</span>
              <span className="mt-0.5 block truncate font-mono text-[11px] text-text-faint">
                {entry.at ? dateTime(entry.at) : t("views.overviewView.timelineCreatedUnknown")} · {entry.id}
              </span>
            </span>
            {task && <StatusBadge status={task.coordinationStatus} />}
            {decision && <DecisionStateBadge state={decision.state} />}
          </button>
        );
      })}
    </div>
  );
}
