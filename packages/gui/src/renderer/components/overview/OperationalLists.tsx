import {
  ArrowSquareOut,
  CircleNotch,
  ClockCounterClockwise,
  WarningCircle,
} from "@phosphor-icons/react";
import type { DecisionRow, TaskRow } from "../../model/types.ts";
import { ledgerIdCreatedAt } from "../../model/ledger-overview.ts";
import { DecisionStateBadge, StatusBadge } from "../badges.tsx";
import { t } from "../../i18n/index.tsx";

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const OVERVIEW_LIST_LIMIT = 12;

export function DecisionRecencyList({
  decisions,
  onOpenDecision,
}: {
  decisions: DecisionRow[];
  onOpenDecision: (id: string) => void;
}) {
  const rows = [...decisions]
    .sort((left, right) => {
      const proposedRank = Number(right.state === "proposed") - Number(left.state === "proposed");
      return proposedRank || decisionTime(right).localeCompare(decisionTime(left));
    })
    .slice(0, OVERVIEW_LIST_LIMIT);

  if (rows.length === 0) return <EmptyOverviewList text={t("views.overviewView.noDecisionsYet")} />;

  return (
    <div className="max-h-[30rem] space-y-2 overflow-y-auto pr-1">
      {rows.map((decision) => {
        const proposed = decision.state === "proposed";
        return (
          <button
            key={decision.decisionId}
            type="button"
            className={`group w-full rounded-md border px-3 py-2 text-left ${
              proposed
                ? "border-accent/60 bg-accent/10 hover:border-accent"
                : "border-border bg-surface-raised hover:border-border-strong"
            }`}
            onClick={() => onOpenDecision(decision.decisionId)}
          >
            <span className="flex items-start gap-2">
              <span className={`mt-0.5 shrink-0 ${proposed ? "text-accent" : "text-text-faint"}`}>
                <ClockCounterClockwise weight={proposed ? "bold" : "duotone"} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <time className="font-mono text-[11px] text-text-faint">
                    {formatOverviewTimestamp(decisionTime(decision))}
                  </time>
                  <DecisionStateBadge state={decision.state} />
                </span>
                <span className="mt-1 block truncate text-[13px] font-semibold text-text">{decision.title}</span>
                <span className="mt-0.5 block truncate text-[12px] text-text-muted">{decision.question}</span>
              </span>
              <ArrowSquareOut className="mt-1 shrink-0 text-text-faint group-hover:text-accent" weight="bold" />
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function RunningTaskList({ tasks, onOpenTask }: { tasks: TaskRow[]; onOpenTask: (id: string) => void }) {
  const rows = nonterminalTasks(tasks)
    .sort((left, right) => {
      const livenessRank = taskLivenessRank(left) - taskLivenessRank(right);
      return livenessRank || taskTime(right).localeCompare(taskTime(left));
    })
    .slice(0, OVERVIEW_LIST_LIMIT);

  if (rows.length === 0) return <EmptyOverviewList text={t("views.overviewView.noOpenTasks")} />;

  return (
    <div className="max-h-[30rem] space-y-1.5 overflow-y-auto pr-1">
      {rows.map((task) => (
        <TaskOperationalRow key={task.taskId} task={task} onOpen={() => onOpenTask(task.taskId)} />
      ))}
    </div>
  );
}

export function StaleTaskList({ tasks, onOpenTask }: { tasks: TaskRow[]; onOpenTask: (id: string) => void }) {
  const rows = nonterminalTasks(tasks)
    .filter((task) => task.liveness === "stale")
    .sort((left, right) => taskTime(right).localeCompare(taskTime(left)));

  if (rows.length === 0) return <EmptyOverviewList text={t("views.overviewView.noStaleTasks")} />;

  return (
    <div className="max-h-[30rem] space-y-1.5 overflow-y-auto pr-1">
      {rows.map((task) => (
        <TaskOperationalRow key={task.taskId} task={task} onOpen={() => onOpenTask(task.taskId)} stale />
      ))}
    </div>
  );
}

function TaskOperationalRow({
  task,
  onOpen,
  stale = false,
}: {
  task: TaskRow;
  onOpen: () => void;
  stale?: boolean;
}) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left ${
        stale
          ? "border-stale/35 bg-stale/10 hover:border-stale/60"
          : "border-border bg-surface-raised hover:border-accent/60"
      }`}
      onClick={onOpen}
    >
      {stale
        ? <WarningCircle className="shrink-0 text-stale" weight="bold" />
        : <CircleNotch className={`shrink-0 ${task.liveness === "in_flight" ? "text-accent" : "text-text-faint"}`} weight="bold" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-text">{task.title}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-text-faint">
          {formatOverviewTimestamp(taskTime(task))}
        </span>
      </span>
      {task.liveness === "in_flight" && (
        <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-accent">
          {t("views.overviewView.inFlight")}
        </span>
      )}
      <StatusBadge status={task.coordinationStatus} />
    </button>
  );
}

function EmptyOverviewList({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-border bg-surface-raised px-3 py-4 text-[13px] text-text-faint">
      {text}
    </p>
  );
}

function nonterminalTasks(tasks: TaskRow[]): TaskRow[] {
  return tasks.filter((task) => !TERMINAL_STATUSES.has(task.coordinationStatus));
}

function decisionTime(decision: DecisionRow): string {
  return decision.proposedAt ?? ledgerIdCreatedAt(decision.decisionId) ?? "";
}

function taskTime(task: TaskRow): string {
  return task.createdAt ?? ledgerIdCreatedAt(task.taskId) ?? "";
}

function taskLivenessRank(task: TaskRow): number {
  if (task.liveness === "in_flight") return 0;
  if (task.liveness === "stale") return 1;
  return 2;
}

function formatOverviewTimestamp(value: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
