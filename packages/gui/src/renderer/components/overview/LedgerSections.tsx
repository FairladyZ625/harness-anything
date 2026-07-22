import { useMemo, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  CheckCircle,
  CircleNotch,
  Scales,
  WarningCircle,
} from "@phosphor-icons/react";
import type { DecisionRow, TaskRow } from "../../model/types.ts";
import {
  buildLedgerOverview,
  type LedgerEvent,
  type PltGroup,
} from "../../model/ledger-overview.ts";
import { StatusBadge } from "../badges.tsx";
import { t } from "../../i18n/index.tsx";
import { Card } from "./parts.tsx";

interface OverviewLedgerSectionsProps {
  tasks: TaskRow[];
  decisions: DecisionRow[];
  onOpenTask: (id: string) => void;
  onOpenDecision: (id: string) => void;
}

export function OverviewLedgerSections({
  tasks,
  decisions,
  onOpenTask,
  onOpenDecision,
}: OverviewLedgerSectionsProps) {
  const model = useMemo(() => buildLedgerOverview(tasks, decisions), [tasks, decisions]);
  const [expandedRoot, setExpandedRoot] = useState<string | null>(null);

  return (
    <>
      <Card title={t("views.ledger.recent")} bodyClassName="p-3">
        <div className="space-y-2">
          {model.events.map((event) => (
            <RecentActivityRow
              key={`${event.kind}:${event.id}:${event.at}`}
              event={event}
              onOpen={() => event.kind === "decision_created"
                ? onOpenDecision(event.id)
                : onOpenTask(event.id)}
            />
          ))}
          {model.events.length === 0 && (
            <p className="rounded-md border border-border bg-surface-raised px-3 py-4 text-[13px] text-text-faint">
              {t("views.ledger.noRecent")}
            </p>
          )}
        </div>
      </Card>

      <Card title="PLT" bodyClassName="max-h-[36rem] space-y-2 overflow-y-auto p-3">
        {model.plt.map((group) => (
          <PltOverviewRow
            key={group.rootId}
            group={group}
            expanded={expandedRoot === group.rootId}
            onToggle={() => setExpandedRoot(expandedRoot === group.rootId ? null : group.rootId)}
            onOpenTask={onOpenTask}
          />
        ))}
        <PltOverviewRow
          group={model.ungrouped}
          expanded={expandedRoot === model.ungrouped.rootId}
          onToggle={() => setExpandedRoot(expandedRoot === model.ungrouped.rootId ? null : model.ungrouped.rootId)}
          onOpenTask={onOpenTask}
          ungrouped
        />
      </Card>
    </>
  );
}

function RecentActivityRow({ event, onOpen }: { event: LedgerEvent; onOpen: () => void }) {
  const visual = eventVisual(event.kind);
  return (
    <button
      type="button"
      className="group flex w-full items-center gap-3 rounded-md border border-border bg-surface-raised px-3 py-2 text-left transition-colors hover:border-accent/60"
      onClick={onOpen}
    >
      <span className="shrink-0 text-[16px]" style={{ color: visual.color }}>
        {visual.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <time className="font-mono text-[11px] text-text-faint">{formatOverviewEventTime(event.at)}</time>
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide"
            style={{
              color: visual.color,
              background: `color-mix(in oklch, ${visual.color} 12%, transparent)`,
            }}
          >
            {visual.label}
          </span>
        </span>
        <span className="mt-1 block truncate text-[13px] font-semibold text-text">{event.title}</span>
      </span>
      <ArrowSquareOut className="shrink-0 text-text-faint group-hover:text-accent" weight="bold" />
    </button>
  );
}

function PltOverviewRow({
  group,
  expanded,
  onToggle,
  onOpenTask,
  ungrouped = false,
}: {
  group: PltGroup;
  expanded: boolean;
  onToggle: () => void;
  onOpenTask: (id: string) => void;
  ungrouped?: boolean;
}) {
  const total = group.tasks.length;
  const percent = total === 0 ? 0 : Math.round((group.terminalCount / total) * 100);
  const staleStyle = group.staleCount > 0
    ? {
        color: "var(--color-stale)",
        borderColor: "color-mix(in oklch, var(--color-stale) 35%, transparent)",
        background: "color-mix(in oklch, var(--color-stale) 12%, transparent)",
      }
    : undefined;

  return (
    <div className={`rounded-md border bg-surface-raised ${ungrouped ? "border-dashed border-border-strong" : "border-border"}`}>
      <button
        type="button"
        aria-expanded={expanded}
        className="w-full px-3 py-2.5 text-left hover:bg-surface"
        onClick={onToggle}
      >
        <span className="flex items-start gap-2.5">
          {expanded
            ? <CaretDown className="mt-0.5 shrink-0 text-accent" weight="bold" />
            : <CaretRight className="mt-0.5 shrink-0 text-text-faint" weight="bold" />}
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">
                {ungrouped ? `${t("views.ledger.noPlt")} (${group.openCount})` : group.title}
              </span>
              <span className="rounded bg-accent/10 px-2 py-0.5 font-mono text-[11px] font-medium text-accent">
                {t("views.ledger.openCount", { open: group.openCount, total })}
              </span>
              <span
                data-testid="plt-stale-badge"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-[11px] text-text-faint"
                style={staleStyle}
              >
                {group.staleCount > 0
                  ? <WarningCircle weight="bold" />
                  : <CheckCircle weight="bold" />}
                {t("views.ledger.stale", { count: group.staleCount })}
              </span>
            </span>
            <span className="mt-2 flex items-center gap-2">
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface ring-1 ring-border">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${percent}%`, background: "var(--color-status-done)" }}
                />
              </span>
              <span className="w-8 text-right font-mono text-[10px] text-text-faint">{percent}%</span>
            </span>
          </span>
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border bg-surface px-3 py-1">
          {group.tasks.map((task) => (
            <button
              key={task.taskId}
              type="button"
              className="flex w-full items-center gap-2 border-b border-border py-2 text-left last:border-0 hover:text-accent"
              onClick={() => onOpenTask(task.taskId)}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background: task.liveness === "in_flight"
                    ? "var(--color-status-active)"
                    : task.liveness === "stale"
                      ? "var(--color-stale)"
                      : "var(--color-text-faint)",
                }}
              />
              <span className="min-w-0 flex-1 truncate text-[12px] text-text-muted">{task.title}</span>
              <StatusBadge status={task.coordinationStatus} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function eventVisual(kind: LedgerEvent["kind"]) {
  if (kind === "decision_created") {
    return {
      icon: <Scales weight="duotone" />,
      label: t("views.ledger.eventDecisionCreated"),
      color: "var(--color-accent)",
    };
  }
  if (kind === "task_terminal") {
    return {
      icon: <CheckCircle weight="duotone" />,
      label: t("views.ledger.eventTaskTerminal"),
      color: "var(--color-status-done)",
    };
  }
  return {
    icon: <CircleNotch weight="bold" />,
    label: t("views.ledger.eventTaskCreated"),
    color: "var(--color-status-active)",
  };
}

function formatOverviewEventTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
