import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types.ts";
import { formatActorAxes } from "../views/decision-pool-helpers.ts";

interface DecisionDetailDrawerProps {
  decision: DecisionRow | null;
  tasks: readonly TaskRow[];
  facts: readonly FactRef[];
  relations: readonly RelationEdge[];
  onClose: () => void;
  onOpenTask: (id: string) => void;
}

export function DecisionDetailDrawer({ decision, tasks, facts, relations, onClose, onOpenTask }: DecisionDetailDrawerProps) {
  if (!decision) return null;
  const decisionRef = `decision/${decision.decisionId}`;
  const linkedRefs = new Set<string>();
  for (const relation of relations) {
    if (entityRef(relation.from) === decisionRef) linkedRefs.add(entityRef(relation.to));
    if (entityRef(relation.to) === decisionRef) linkedRefs.add(entityRef(relation.from));
  }
  const linkedTasks = tasks.filter((task) => linkedRefs.has(`task/${task.taskId}`));
  const linkedFacts = facts.filter((fact) => linkedRefs.has(entityRef(fact.anchor.startsWith("fact/") ? fact.anchor : `fact/${fact.anchor}`)));
  const actor = decision.attribution.latestActor ?? decision.attribution.originator;

  return (
    <div
      data-testid="decision-drawer-overlay"
      className="fixed inset-0 z-[100] isolate flex justify-end bg-bg/80"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <aside
        data-testid="decision-drawer-panel"
        className="relative z-[101] h-full w-full max-w-2xl overflow-y-auto border-l border-border-strong bg-surface shadow-2xl shadow-black/50"
        style={{ backgroundColor: "var(--color-surface)" }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="decision-drawer-title"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-border bg-surface px-6 py-5">
          <div className="min-w-0 pr-6"><p className="font-mono text-xs text-text-faint">{decision.decisionId}</p><h2 id="decision-drawer-title" className="mt-1 text-xl font-semibold text-text">{decision.title}</h2></div>
          <button type="button" className="rounded border border-border px-3 py-1.5 text-sm text-text-muted hover:border-border-strong hover:bg-surface-raised hover:text-text" onClick={onClose}>Close</button>
        </header>
        <div className="space-y-8 px-6 py-6">
          <DecisionTextSection label="Question" text={decision.question} />
          <DecisionClaims label="Chosen" claims={decision.chosen} />
          <DecisionClaims label="Rejected" claims={decision.rejected} rejected />
          <section><h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-faint">Accepted by</h3><div className="rounded-md border border-border bg-surface-raised p-4 text-sm"><div>{formatActorAxes(actor)}</div><time className="mt-1 block font-mono text-xs text-text-faint">{decision.decidedAt ?? "Not accepted"}</time></div></section>
          <section><h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-faint">Related tasks · {linkedTasks.length}</h3><div className="divide-y divide-border border-y border-border">{linkedTasks.map((task) => <button key={task.taskId} type="button" className="flex w-full justify-between gap-4 py-3 text-left text-sm hover:text-accent" onClick={() => onOpenTask(task.taskId)}><span>{task.title}</span><span className="font-mono text-xs text-text-faint">{task.taskId}</span></button>)}</div></section>
          <section><h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-faint">Related facts · {linkedFacts.length}</h3><div className="space-y-2">{linkedFacts.map((fact) => <div key={fact.anchor} className="rounded-md border border-border bg-surface-raised p-3"><p className="text-sm leading-6">{fact.text}</p><p className="mt-2 font-mono text-xs text-text-faint">{fact.anchor}</p></div>)}</div></section>
        </div>
      </aside>
    </div>
  );
}

function DecisionTextSection({ label, text }: { label: string; text: string }) {
  return <section><h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-faint">{label}</h3><p className="whitespace-pre-wrap text-sm leading-7 text-text">{text}</p></section>;
}

function DecisionClaims({ label, claims, rejected = false }: { label: string; claims: DecisionRow["chosen"]; rejected?: boolean }) {
  return <section><h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-faint">{label}</h3><div className="space-y-3">{claims.map((claim) => <div key={claim.id} className={`rounded-md border p-4 ${rejected ? "border-danger/30 bg-danger/10" : "border-border bg-surface-raised"}`}><p className="whitespace-pre-wrap text-sm leading-6 text-text">{claim.text}</p>{claim.whyNot && <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">{claim.whyNot}</p>}</div>)}</div></section>;
}

function entityRef(ref: string): string {
  const parts = ref.split("/");
  if (parts[0] === "fact" && parts.length >= 3) return `${parts[0]}/${parts[1]}/${parts[2]}`;
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : ref;
}
