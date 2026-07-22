import { useMemo, useState } from "react";
import type { DecisionRow, TaskRow } from "../model/types.ts";
import { buildLedgerOverview, type PltGroup } from "../model/ledger-overview.ts";
import { t } from "../i18n/index.tsx";

interface LedgerOverviewViewProps {
  tasks: TaskRow[];
  decisions: DecisionRow[];
  dataReady: boolean;
  onOpenTask: (id: string) => void;
  onOpenDecision: (id: string) => void;
}

export function LedgerOverviewView(props: LedgerOverviewViewProps) {
  const { tasks, decisions, dataReady, onOpenTask, onOpenDecision } = props;
  const model = useMemo(() => buildLedgerOverview(tasks, decisions), [tasks, decisions]);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!dataReady) return <div className="p-8 text-sm text-muted-foreground">{t("views.ledger.loading")}</div>;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto max-w-6xl space-y-10 px-6 py-8 lg:px-10">
        <section>
          <div className="mb-4 flex items-end justify-between border-b border-border pb-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t("views.ledger.now")}</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("views.ledger.recent")}</h1>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{model.events.length}</span>
          </div>
          <div className="divide-y divide-border border-y border-border">
            {model.events.map((event) => (
              <button
                key={`${event.kind}:${event.id}:${event.at}`}
                type="button"
                className="grid w-full grid-cols-[9rem_7rem_1fr] items-center gap-4 px-2 py-3 text-left transition-colors hover:bg-muted/50"
                onClick={() => event.kind === "decision_created" ? onOpenDecision(event.id) : onOpenTask(event.id)}
              >
                <time className="font-mono text-xs text-muted-foreground">{formatLedgerTime(event.at)}</time>
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{ledgerEventLabel(event.kind)}</span>
                <span className="truncate text-sm font-medium">{event.title}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-4 border-b border-border pb-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t("views.ledger.structure")}</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">PLT</h2>
          </div>
          <div className="space-y-2">
            {model.plt.map((group) => (
              <PltLedgerRow key={group.rootId} group={group} expanded={expanded === group.rootId} onToggle={() => setExpanded(expanded === group.rootId ? null : group.rootId)} onOpenTask={onOpenTask} />
            ))}
            <PltLedgerRow group={model.ungrouped} expanded={expanded === model.ungrouped.rootId} onToggle={() => setExpanded(expanded === model.ungrouped.rootId ? null : model.ungrouped.rootId)} onOpenTask={onOpenTask} ungrouped />
          </div>
        </section>
      </div>
    </div>
  );
}

function PltLedgerRow({ group, expanded, onToggle, onOpenTask, ungrouped = false }: { group: PltGroup; expanded: boolean; onToggle: () => void; onOpenTask: (id: string) => void; ungrouped?: boolean }) {
  const percent = group.tasks.length === 0 ? 0 : Math.round(group.terminalCount / group.tasks.length * 100);
  return (
    <div className={`border ${ungrouped ? "border-dashed border-border" : "border-border"} bg-card`}>
      <button type="button" className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-6 px-4 py-4 text-left hover:bg-muted/40" onClick={onToggle}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{expanded ? "−" : "+"}</span>
            <span className="truncate text-sm font-semibold">{ungrouped ? `${t("views.ledger.noPlt")} (${group.openCount})` : group.title}</span>
          </div>
          <div className="mt-2 h-1 w-full max-w-md overflow-hidden bg-muted"><div className="h-full bg-foreground" style={{ width: `${percent}%` }} /></div>
        </div>
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{group.openCount} / {group.tasks.length}</span>
        {group.staleCount > 0 ? <span className="whitespace-nowrap border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">{t("views.ledger.stale", { count: group.staleCount })}</span> : <span className="w-20" />}
      </button>
      {expanded && <div className="border-t border-border bg-muted/20 px-4 py-2">{group.tasks.map((task) => <button key={task.taskId} type="button" className="flex w-full items-center gap-3 border-b border-border/60 py-2 text-left text-sm last:border-0 hover:text-primary" onClick={() => onOpenTask(task.taskId)}><span className={`h-1.5 w-1.5 rounded-full ${task.liveness === "in_flight" ? "bg-emerald-500" : "bg-muted-foreground/40"}`} /><span className="min-w-0 flex-1 truncate">{task.title}</span><span className="text-xs text-muted-foreground">{task.coordinationStatus}</span></button>)}</div>}
    </div>
  );
}

function formatLedgerTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function ledgerEventLabel(kind: "decision_created" | "task_created" | "task_terminal"): string {
  if (kind === "decision_created") return t("views.ledger.eventDecisionCreated");
  if (kind === "task_terminal") return t("views.ledger.eventTaskTerminal");
  return t("views.ledger.eventTaskCreated");
}
