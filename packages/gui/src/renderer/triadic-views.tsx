import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import {
  MOCK_DECISIONS,
  MOCK_FACTS,
  MOCK_RELATIONS,
  factById,
  type DecisionRecord
} from "./mock-triadic-data.ts";

export function DecisionInboxView({ onOpenFact }: { readonly onOpenFact: (factId: string) => void }): ReactElement {
  const [activeId, setActiveId] = useState(MOCK_DECISIONS.find((decision) => decision.state === "proposed")?.id ?? MOCK_DECISIONS[0]?.id);
  const queue = MOCK_DECISIONS.filter((decision) => decision.state === "proposed").sort(compareDecisionPriority);
  const active = queue.find((decision) => decision.id === activeId) ?? queue[0];

  if (!active) return <MockEmptyState title="今日无待裁决策" body="Mock queue is empty." />;

  return (
    <section className="decision-inbox">
      <aside className="queue-list" aria-label="Mock decision queue">
        <div className="section-heading">
          <h2>Queue</h2>
          <DataPill tone="mock">MOCK</DataPill>
        </div>
        {queue.map((decision) => (
          <button
            key={decision.id}
            type="button"
            className={`queue-row ${decision.id === active.id ? "is-active" : ""}`}
            onClick={() => setActiveId(decision.id)}
          >
            <strong>{decision.title}</strong>
            <span>{decision.riskTier} risk · {decision.urgency} urgency</span>
          </button>
        ))}
      </aside>
      <DecisionCard decision={active} onOpenFact={onOpenFact} large />
    </section>
  );
}

export function DecisionPoolView({ onOpenFact }: { readonly onOpenFact: (factId: string) => void }): ReactElement {
  const [state, setState] = useState<"all" | "proposed" | "active" | "retired">("all");
  const decisions = state === "all" ? MOCK_DECISIONS : MOCK_DECISIONS.filter((decision) => decision.state === state);

  return (
    <section className="decision-pool">
      <div className="section-heading">
        <h2>Decision pool</h2>
        <DataPill tone="mock">MOCK</DataPill>
      </div>
      <div className="tabs" role="tablist" aria-label="Decision state filter">
        {(["all", "proposed", "active", "retired"] as const).map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={state === tab} className={state === tab ? "is-active" : ""} onClick={() => setState(tab)}>
            {tab}
          </button>
        ))}
      </div>
      <div className="decision-grid">
        {decisions.map((decision) => (
          <DecisionCard key={decision.id} decision={decision} onOpenFact={onOpenFact} />
        ))}
      </div>
    </section>
  );
}

export function GraphView({ onOpenFact }: { readonly onOpenFact: (factId: string) => void }): ReactElement {
  return (
    <section className="graph-view">
      <div className="section-heading">
        <h2>Relation graph evidence path</h2>
        <DataPill tone="mock">MOCK</DataPill>
      </div>
      <div className="graph-layout">
        <div className="graph-canvas" aria-label="Mock relation graph">
          {MOCK_DECISIONS.map((decision, index) => (
            <article key={decision.id} className="graph-node decision" style={{ gridColumn: 1, gridRow: index + 1 }}>
              <strong>{decision.id}</strong>
              <span>{decision.title}</span>
            </article>
          ))}
          {MOCK_FACTS.map((fact, index) => (
            <button key={fact.id} type="button" className={`graph-node fact is-${fact.state}`} style={{ gridColumn: 2, gridRow: index + 1 }} onClick={() => onOpenFact(fact.id)}>
              <strong>{fact.id}</strong>
              <span>{fact.state}</span>
            </button>
          ))}
        </div>
        <div className="relation-table">
          <h3>Keyboard equivalent relation list</h3>
          {MOCK_RELATIONS.map((relation) => (
            <article key={`${relation.from}-${relation.to}`} className="relation-row">
              <strong>{relation.type}</strong>
              <span>{relation.from}</span>
              <span>{relation.to}</span>
              <p>{relation.rationale}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FactInspector({ factId, onClose }: { readonly factId: string | null; readonly onClose: () => void }): ReactElement | null {
  const closeRef = useRef<HTMLButtonElement>(null);
  const fact = factId ? factById(factId) ?? null : null;

  useEffect(() => {
    if (!fact) return undefined;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fact, onClose]);

  if (!fact) return null;

  const incoming = MOCK_RELATIONS.filter((relation) => relation.to.endsWith(fact.id));

  return (
    <aside className="fact-inspector" aria-label="Fact inspector" aria-modal="true">
      <div className="section-heading">
        <h2>Fact Inspector</h2>
        <DataPill tone="mock">MOCK</DataPill>
      </div>
      <button ref={closeRef} type="button" className="op-button" onClick={onClose}>Close</button>
      <dl>
        <Field label="Anchor" value={fact.id} />
        <Field label="Task" value={fact.taskId} />
        <Field label="State" value={fact.state} />
        <Field label="Observed" value={formatDate(fact.observedAt)} />
        <Field label="Source" value={fact.source} />
      </dl>
      <p>{fact.text}</p>
      <h3>Incoming relations</h3>
      {incoming.length > 0 ? incoming.map((relation) => (
        <article key={`${relation.from}-${relation.to}`} className="relation-row">
          <strong>{relation.type}</strong>
          <span>{relation.from}</span>
          <p>{relation.rationale}</p>
        </article>
      )) : <p className="muted">No mock incoming relation in this slice.</p>}
    </aside>
  );
}

export function DecisionMiniCard({ decision, onOpenFact }: { readonly decision: DecisionRecord; readonly onOpenFact: (factId: string) => void }): ReactElement {
  return (
    <article className="decision-mini-card">
      <div>
        <strong>{decision.title}</strong>
        <span>{decision.riskTier} risk · {decision.urgency} urgency</span>
      </div>
      <FactChip factId={decision.factIds[0] ?? ""} onOpenFact={onOpenFact} />
    </article>
  );
}

export function compareDecisionPriority(a: DecisionRecord, b: DecisionRecord): number {
  return priorityWeight(b.riskTier) - priorityWeight(a.riskTier) || priorityWeight(b.urgency) - priorityWeight(a.urgency);
}

function DecisionCard({
  decision,
  onOpenFact,
  large = false
}: {
  readonly decision: DecisionRecord;
  readonly onOpenFact: (factId: string) => void;
  readonly large?: boolean;
}): ReactElement {
  return (
    <article className={`decision-card ${large ? "is-large" : ""}`}>
      <header>
        <div>
          <p className="op-kicker">{decision.id}</p>
          <h2>{decision.title}</h2>
        </div>
        <ReadinessBadge decision={decision} />
      </header>
      <p>{decision.question}</p>
      <div className="badge-row">
        <StatusBadge value={decision.state} />
        <StatusBadge value={`${decision.riskTier} risk`} />
        <StatusBadge value={`${decision.urgency} urgency`} />
      </div>
      <section>
        <h3>Chosen</h3>
        <ul>{decision.chosen.map((entry) => <li key={entry}>{entry}</li>)}</ul>
      </section>
      <section>
        <h3>Rejected</h3>
        <ul>{decision.rejected.map((entry) => <li key={entry.text}><strong>{entry.text}</strong>: {entry.whyNot}</li>)}</ul>
      </section>
      <section>
        <h3>Evidence facts</h3>
        <div className="fact-chip-row">
          {decision.factIds.map((factId) => <FactChip key={factId} factId={factId} onOpenFact={onOpenFact} />)}
        </div>
      </section>
      <footer>{decision.provenance}</footer>
    </article>
  );
}

function FactChip({ factId, onOpenFact }: { readonly factId: string; readonly onOpenFact: (factId: string) => void }): ReactElement {
  const fact = factById(factId);
  return (
    <button type="button" className={`fact-chip is-${fact?.state ?? "dangling"}`} onClick={() => onOpenFact(factId)} disabled={!factId}>
      {factId || "no fact"}
    </button>
  );
}

function DataPill({ tone, children }: { readonly tone: "real" | "mock" | "mixed"; readonly children: string }): ReactElement {
  return <span className={`data-pill is-${tone}`}>{children}</span>;
}

function Field({ label, value }: { readonly label: string; readonly value: string | number | undefined }): ReactElement {
  return (
    <div className="field-row">
      <dt>{label}</dt>
      <dd>{value ?? "n/a"}</dd>
    </div>
  );
}

function StatusBadge({ value }: { readonly value: string }): ReactElement {
  return <span className={`status-badge status-${value.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`}>{value}</span>;
}

function ReadinessBadge({ decision }: { readonly decision: DecisionRecord }): ReactElement {
  return <span className={`readiness is-${decision.readiness}`}>{decision.readiness.toUpperCase()} · {decision.readinessReason}</span>;
}

function MockEmptyState({ title, body }: { readonly title: string; readonly body: string }): ReactElement {
  return (
    <section className="empty-state">
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  );
}

function priorityWeight(priority: "low" | "medium" | "high"): number {
  return priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

function formatDate(value: string | undefined): string {
  if (!value) return "n/a";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
