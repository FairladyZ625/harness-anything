import { derivedTasks, supersedeChain } from "../../model/triadic.ts";
import { localDateTime } from "../../model/local-time.ts";
import type { DecisionRow, RelationEdge, TaskRow } from "../../model/types.ts";
import { t } from "../../i18n/index.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";

export function OverviewPanel({ decision }: { decision: DecisionRow }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-border bg-surface-raised px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
          {t("views.decisionDetailView.question")}
        </span>
        <p className="mt-1 text-[13px] font-medium text-text">{decision.question}</p>
      </div>
      {decision.chosen.length > 0 && (
        <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2">
          <span className="font-mono text-[11px] uppercase tracking-wide text-accent">
            {t("views.decisionsVerdict.chosen")}
          </span>
          {decision.chosen.map((option) => (
            <div key={option.id} className="mt-1 text-[12px] leading-relaxed">
              <span className="font-mono text-text-faint">{option.id} </span>
              <span className="text-text">{option.text}</span>
              {option.rationale && <p className="ml-4 text-[11px] text-text-muted">{option.rationale}</p>}
            </div>
          ))}
        </div>
      )}
      {decision.rejected.length > 0 && (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
          <span className="font-mono text-[11px] uppercase tracking-wide text-danger">
            {t("views.decisionsVerdict.rejected")}
          </span>
          {decision.rejected.map((option) => (
            <div key={option.id} className="mt-1 text-[12px] leading-relaxed">
              <span className="font-mono text-text-faint">{option.id} </span>
              <span className="text-text line-through opacity-70">{option.text}</span>
              {option.whyNot && (
                <p className="ml-4 text-[11px] italic text-text-muted">
                  {t("views.decisionDetailView.whyNot")}: {option.whyNot}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ClaimsPanel({ decision }: { decision: DecisionRow }) {
  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
          {t("views.decisionDetailView.claims")}
        </h2>
        {decision.claims.length === 0 ? (
          <p className="mt-1 text-[12px] text-text-faint">{t("views.decisionDetailView.claimsEmpty")}</p>
        ) : (
          <ul className="mt-1 list-inside list-disc text-[12px] text-text-muted">
            {decision.claims.map((claim) => (
              <li key={claim.id}>
                <span className="font-mono text-text-faint">{claim.id} </span>
                {claim.text}
                <span className="ml-1 font-mono text-[11px] text-text-faint">
                  {t("views.decisionDetailView.fulfillment")}: {claim.fulfillment ?? "—"}
                  {claim.loadBearing ? " · load-bearing" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
          {t("views.decisionDetailView.consents")}
        </h2>
        {decision.judgmentConsents.length === 0 ? (
          <p className="mt-1 text-[12px] text-text-faint">{t("views.decisionDetailView.consentsEmpty")}</p>
        ) : (
          <ul className="mt-1 space-y-1 font-mono text-[11px] text-text-muted">
            {decision.judgmentConsents.map((consent) => (
              <li key={consent.consentId}>
                {consent.action} · {consent.consentId} · {consent.consentedAt}
              </li>
            ))}
          </ul>
        )}
      </section>
      {(decision.provenance?.length ?? 0) > 0 && (
        <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
          <h2 className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
            {t("views.decisionsVerdict.provenance")}
          </h2>
          <ul className="mt-1 space-y-1 font-mono text-[11px] text-text-muted">
            {decision.provenance!.map((entry) => (
              <li key={entry.sessionId}>
                {entry.runtime}:{entry.sessionId} · {localDateTime(entry.boundAt) ?? "—"}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function RelationsPanel({
  decision,
  tasks,
  relations,
  onNavigateDecision,
  onNavigateTask,
  onNavigateEntity,
}: {
  decision: DecisionRow;
  tasks: TaskRow[];
  relations: RelationEdge[];
  onNavigateDecision: (decisionId: string) => void;
  onNavigateTask?: (taskId: string) => void;
  onNavigateEntity: (ref: string) => void;
}) {
  const self = `decision/${decision.decisionId}`;
  const touches = (ref: string) => ref === self || ref.startsWith(`${self}/`);
  const edges = relations.filter((edge) => touches(edge.from) || touches(edge.to));
  const chain = supersedeChain(decision, relations);
  const derived = derivedTasks(decision, relations, tasks);
  return (
    <div className="flex flex-col gap-3">
      {(chain.supersedes.length > 0 || chain.supersededBy.length > 0) && (
        <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {chain.supersedes.length > 0 && (
              <span className="inline-flex items-center gap-1 font-mono text-danger">
                {chain.supersedes.map((id) => (
                  <EntityRefLink
                    key={id}
                    entityRef={`decision/${id}`}
                    onNavigate={() => onNavigateDecision(id)}
                    title={id}
                    className="text-danger hover:underline"
                  />
                ))}
              </span>
            )}
            {chain.supersededBy.length > 0 && (
              <span className="inline-flex items-center gap-1 font-mono text-stale">
                {chain.supersededBy.map((id) => (
                  <EntityRefLink
                    key={id}
                    entityRef={`decision/${id}`}
                    onNavigate={() => onNavigateDecision(id)}
                    title={id}
                    className="text-stale hover:underline"
                  />
                ))}
              </span>
            )}
          </div>
        </section>
      )}
      {derived.length > 0 && (
        <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
          <h2 className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
            {t("views.decisionDetailView.derivedTasks")}
          </h2>
          <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
            {derived.map((task) => (
              <span key={task.taskId} className="inline-flex items-center gap-1 font-mono text-text-muted">
                {onNavigateTask ? (
                  <EntityRefLink
                    entityRef={`task/${task.taskId}`}
                    onNavigate={() => onNavigateTask(task.taskId)}
                    title={task.taskId}
                    className="rounded bg-surface px-1 text-text-muted hover:text-accent hover:underline"
                  />
                ) : (
                  <span className="rounded bg-surface px-1">{task.taskId}</span>
                )}
                <span className="text-text-faint">{task.title}</span>
              </span>
            ))}
          </div>
        </section>
      )}
      <section className="rounded-md border border-border bg-surface-raised px-3 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
          {t("views.decisionDetailView.tabRelations")}
        </h2>
        {edges.length === 0 ? (
          <p className="mt-1 text-[12px] text-text-faint">{t("views.decisionDetailView.relationsEmpty")}</p>
        ) : (
          <ul className="mt-1 space-y-1 font-mono text-[11px] text-text-muted">
            {edges.map((edge) => (
              <li key={edge.relationId} className="break-all">
                <RefLink
                  ref_={edge.from}
                  self={self}
                  onNavigateEntity={onNavigateEntity}
                  onNavigateDecision={onNavigateDecision}
                />
                <span className="mx-1 text-accent">--{edge.kind}--&gt;</span>
                <RefLink
                  ref_={edge.to}
                  self={self}
                  onNavigateEntity={onNavigateEntity}
                  onNavigateDecision={onNavigateDecision}
                />
                {edge.rationale && <span className="ml-1 text-text-faint">({edge.rationale})</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RefLink({
  ref_,
  self,
  onNavigateEntity,
  onNavigateDecision,
}: {
  ref_: string;
  self: string;
  onNavigateEntity: (ref: string) => void;
  onNavigateDecision: (decisionId: string) => void;
}) {
  // 自引用(本决策)导航为 no-op:对等价位置不推栈,但仍走互链出口保持可激活。
  if (ref_.startsWith("decision/")) {
    const id = ref_.split("/")[1]!;
    const navigation = ref_ === self ? () => undefined : () => onNavigateDecision(id);
    return (
      <EntityRefLink
        entityRef={ref_}
        onNavigate={navigation}
        title={id}
        className="hover:text-accent hover:underline"
      />
    );
  }
  return (
    <EntityRefLink
      entityRef={ref_}
      onNavigate={() => onNavigateEntity(ref_)}
      title={ref_}
      className="hover:text-accent hover:underline"
    />
  );
}
