import { useEffect } from "react";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types.ts";
import { formatActorAxes } from "../views/decision-pool-helpers.ts";
import { t } from "../i18n/index.tsx";

interface DecisionDetailDrawerProps {
  decision: DecisionRow | null;
  /** Full decision pool — used to resolve peer decision titles for one-hop links. */
  decisions?: readonly DecisionRow[];
  tasks: readonly TaskRow[];
  facts: readonly FactRef[];
  relations: readonly RelationEdge[];
  onClose: () => void;
  onOpenTask: (id: string) => void;
  /** One-hop jump to a related decision (nav ref without drawer re-entry). */
  onOpenDecision?: (decisionId: string) => void;
  /** One-hop jump to a related fact (fact triage / inspector path). */
  onOpenFact?: (factRef: string) => void;
}

export function DecisionDetailDrawer({
  decision,
  decisions = [],
  tasks,
  facts,
  relations,
  onClose,
  onOpenTask,
  onOpenDecision,
  onOpenFact,
}: DecisionDetailDrawerProps) {
  // Esc closes the drawer so keyboard-only users can dismiss without hunting
  // for the Close button (TaskPreviewDrawer already has this; keep parity).
  useEffect(() => {
    if (!decision) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decision, onClose]);

  if (!decision) return null;
  const decisionRef = `decision/${decision.decisionId}`;
  const linkedRefs = new Set<string>();
  for (const relation of relations) {
    if (entityRef(relation.from) === decisionRef) linkedRefs.add(entityRef(relation.to));
    if (entityRef(relation.to) === decisionRef) linkedRefs.add(entityRef(relation.from));
  }
  const linkedTasks = tasks.filter((task) => linkedRefs.has(`task/${task.taskId}`));
  const linkedFacts = facts.filter((fact) =>
    linkedRefs.has(entityRef(fact.anchor.startsWith("fact/") ? fact.anchor : `fact/${fact.anchor}`)),
  );
  // Peer decisions (refines/narrows/supersedes/relates) — exclude self.
  const linkedDecisions = decisionsFromRefs(linkedRefs, decisions, decision.decisionId);
  const actor = decision.attribution.latestActor ?? decision.attribution.originator;

  return (
    <div
      data-testid="decision-drawer-overlay"
      className="fixed inset-0 z-[100] isolate flex justify-end bg-bg/80"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
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
          <div className="min-w-0 pr-6">
            <p className="font-mono text-xs text-text-faint">{decision.decisionId}</p>
            <h2 id="decision-drawer-title" className="mt-1 text-xl font-semibold text-text">
              {decision.title}
            </h2>
          </div>
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-sm text-text-muted hover:border-border-strong hover:bg-surface-raised hover:text-text"
            onClick={onClose}
            aria-label={t("components.decisionDetailDrawer.close")}
          >
            {t("components.decisionDetailDrawer.close")}
          </button>
        </header>
        <div className="space-y-8 px-6 py-6">
          <DecisionTextSection label={t("components.decisionDetailDrawer.question")} text={decision.question} />
          <DecisionClaims label={t("components.decisionDetailDrawer.chosen")} claims={decision.chosen} />
          <DecisionClaims
            label={t("components.decisionDetailDrawer.rejected")}
            claims={decision.rejected}
            rejected
          />
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-faint">
              {t("components.decisionDetailDrawer.acceptedBy")}
            </h3>
            <div className="rounded-md border border-border bg-surface-raised p-4 text-sm">
              <div>{formatActorAxes(actor)}</div>
              <time className="mt-1 block font-mono text-xs text-text-faint">
                {decision.decidedAt ?? t("components.decisionDetailDrawer.notAccepted")}
              </time>
            </div>
          </section>
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-faint">
              {t("components.decisionDetailDrawer.relatedTasks", { count: linkedTasks.length })}
            </h3>
            <div className="divide-y divide-border border-y border-border">
              {linkedTasks.map((task) => (
                <button
                  key={task.taskId}
                  type="button"
                  className="flex w-full justify-between gap-4 py-3 text-left text-sm hover:text-accent"
                  onClick={() => onOpenTask(task.taskId)}
                  title={t("components.decisionDetailDrawer.jumpTask")}
                >
                  <span>{task.title}</span>
                  <span className="font-mono text-xs text-text-faint">{task.taskId}</span>
                </button>
              ))}
              {linkedTasks.length === 0 && (
                <p className="py-3 text-sm text-text-faint">
                  {t("components.decisionDetailDrawer.noRelatedTasks")}
                </p>
              )}
            </div>
          </section>
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-faint">
              {t("components.decisionDetailDrawer.relatedFacts", { count: linkedFacts.length })}
            </h3>
            <div className="space-y-2">
              {linkedFacts.map((fact) => {
                const factRef = fact.anchor.startsWith("fact/") ? fact.anchor : `fact/${fact.anchor}`;
                const clickable = Boolean(onOpenFact);
                const content = (
                  <>
                    <p className="text-sm leading-6">{fact.text}</p>
                    <p className="mt-2 font-mono text-xs text-text-faint">{fact.anchor}</p>
                  </>
                );
                return clickable ? (
                  <button
                    key={fact.anchor}
                    type="button"
                    data-testid={`decision-drawer-fact-${fact.anchor}`}
                    className="block w-full rounded-md border border-border bg-surface-raised p-3 text-left hover:border-accent/40 hover:text-accent"
                    onClick={() => onOpenFact?.(factRef)}
                    title={t("components.decisionDetailDrawer.jumpFact")}
                  >
                    {content}
                  </button>
                ) : (
                  <div key={fact.anchor} className="rounded-md border border-border bg-surface-raised p-3">
                    {content}
                  </div>
                );
              })}
              {linkedFacts.length === 0 && (
                <p className="text-sm text-text-faint">
                  {t("components.decisionDetailDrawer.noRelatedFacts")}
                </p>
              )}
            </div>
          </section>
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-faint">
              {t("components.decisionDetailDrawer.relatedDecisions", { count: linkedDecisions.length })}
            </h3>
            <div className="divide-y divide-border border-y border-border">
              {linkedDecisions.map((peer) => {
                const clickable = Boolean(onOpenDecision);
                return clickable ? (
                  <button
                    key={peer.decisionId}
                    type="button"
                    data-testid={`decision-drawer-decision-${peer.decisionId}`}
                    className="flex w-full justify-between gap-4 py-3 text-left text-sm hover:text-accent"
                    onClick={() => onOpenDecision?.(peer.decisionId)}
                    title={t("components.decisionDetailDrawer.jumpDecision")}
                  >
                    <span>{peer.title}</span>
                    <span className="font-mono text-xs text-text-faint">{peer.decisionId}</span>
                  </button>
                ) : (
                  <div
                    key={peer.decisionId}
                    className="flex w-full justify-between gap-4 py-3 text-sm text-text-muted"
                  >
                    <span>{peer.title}</span>
                    <span className="font-mono text-xs text-text-faint">{peer.decisionId}</span>
                  </div>
                );
              })}
              {linkedDecisions.length === 0 && (
                <p className="py-3 text-sm text-text-faint">
                  {t("components.decisionDetailDrawer.noRelatedDecisions")}
                </p>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function decisionsFromRefs(
  linkedRefs: ReadonlySet<string>,
  decisions: readonly DecisionRow[],
  selfId: string,
): DecisionRow[] {
  const byId = new Map(decisions.map((d) => [d.decisionId, d]));
  const out: DecisionRow[] = [];
  for (const ref of linkedRefs) {
    if (!ref.startsWith("decision/")) continue;
    const id = ref.slice("decision/".length).split("/")[0];
    if (!id || id === selfId) continue;
    const peer = byId.get(id);
    if (peer) out.push(peer);
  }
  return out;
}

function DecisionTextSection({ label, text }: { label: string; text: string }) {
  return (
    <section>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-faint">{label}</h3>
      <p className="whitespace-pre-wrap text-sm leading-7 text-text">{text}</p>
    </section>
  );
}

function DecisionClaims({
  label,
  claims,
  rejected = false,
}: {
  label: string;
  claims: DecisionRow["chosen"];
  rejected?: boolean;
}) {
  return (
    <section>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-faint">{label}</h3>
      <div className="space-y-3">
        {claims.map((claim) => (
          <div
            key={claim.id}
            className={`rounded-md border p-4 ${
              rejected ? "border-danger/30 bg-danger/10" : "border-border bg-surface-raised"
            }`}
          >
            <p className="whitespace-pre-wrap text-sm leading-6 text-text">{claim.text}</p>
            {claim.whyNot && (
              <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">{claim.whyNot}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function entityRef(ref: string): string {
  const parts = ref.split("/");
  if (parts[0] === "fact" && parts.length >= 3) return `${parts[0]}/${parts[1]}/${parts[2]}`;
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : ref;
}
