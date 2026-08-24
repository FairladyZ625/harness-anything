import { ArrowSquareOut, Graph, GitBranch, WarningCircle, X } from "@phosphor-icons/react";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types";
import { normalizeDecisionId } from "../model/triadic";
import { activeIncomingRelations, incomingRelations } from "../model/relation-direction.ts";
import { CopyContextButton } from "./CopyContextButton";
import { buildEntityJumpContext } from "../model/copy-context";
import type { RelationCoverageRow } from "../../api/renderer-dto";
import { t } from "../i18n/index.tsx";
import { EntityRefLink } from "./EntityRefLink.tsx";
import { localDateTime } from "../model/local-time.ts";

function shortEndpoint(raw: string): string {
  if (raw.startsWith("decision/")) return normalizeDecisionId(raw);
  if (raw.startsWith("fact/")) return raw.replace(/^fact\//, "");
  return raw.replace(/^task\//, "");
}


/** 关系端点的裸引用也必须有路:按 kind 路由到对应实体的导航出口。 */
function EndpointRef({ raw, onNavigateDecision, onNavigateTask, onFocusGraph }: {
  readonly raw: string;
  readonly onNavigateDecision?: (decisionId: string) => void;
  readonly onNavigateTask?: (taskId: string) => void;
  readonly onFocusGraph?: (ref: string) => void;
}) {
  const navigate = (ref: string) => {
    if (ref.startsWith("decision/") && onNavigateDecision) onNavigateDecision(normalizeDecisionId(ref));
    else if (ref.startsWith("task/") && onNavigateTask) onNavigateTask(ref.slice(5).split("/")[0]);
    else if (onFocusGraph) onFocusGraph(ref);
  };
  const routable = raw.startsWith("decision/") ? onNavigateDecision !== undefined
    : raw.startsWith("task/") ? onNavigateTask !== undefined
      : onFocusGraph !== undefined;
  return routable
    ? (
      <EntityRefLink
        entityRef={raw}
        onNavigate={navigate}
        title={raw}
        className="text-text-faint hover:text-accent hover:underline"
      >
        {shortEndpoint(raw)}
      </EntityRefLink>
    )
    : <span className="text-text-faint">{shortEndpoint(raw)}</span>;
}

export function FactInspector({
  factRef,
  facts,
  tasks,
  decisions,
  relations,
  onClose,
  onNavigateDecision,
  onNavigateTask,
  onFocusGraph,
  coverageRows = [],
  side = "left",
}: {
  factRef: string;
  facts: FactRef[];
  tasks: TaskRow[];
  decisions: DecisionRow[];
  relations: RelationEdge[];
  /** 关闭按钮;缺省(详情页整栏复用)不渲染。 */
  onClose?: () => void;
  /** W2B 活链接:点击 decision ref 跳转 */
  onNavigateDecision?: (decisionId: string) => void;
  /** W2B 活链接:点击 task ref 跳转 */
  onNavigateTask?: (taskId: string) => void;
  onFocusGraph?: (ref: string) => void;
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  /** 面板贴哪一侧:列表页内嵌(左)或详情页主栏(右)。 */
  side?: "left" | "right";
}) {
  const anchor = factRef.replace(/^fact\//, "");
  const fullRef = `fact/${anchor}`;
  const fact = facts.find((candidate) => candidate.anchor === anchor);
  const task = fact ? tasks.find((candidate) => candidate.taskId === fact.taskId) : undefined;
  const inbound = relations.filter((relation) => relation.to === fullRef);
  // Current contradiction status follows kernel decision coverage: retired/deleted
  // refuted-by edges remain visible in the incoming audit list, but do not warn here.
  const contradictions = activeIncomingRelations(fullRef, "refuted-by", relations);
  // Kernel fact-liveness criterion: only an active supersedes-fact edge marks the
  // fact replaced; retired/deleted edges are audit history (see activeIncomingRelations).
  const supersedingRelations = activeIncomingRelations(fullRef, "supersedes-fact", relations);
  const directlySupportedDecisionIds = incomingRelations(fullRef, "evidenced-by", relations)
    .map((relation) => normalizeDecisionId(relation.from));
  const coveredDecisionIds = coverageRows
    .filter(
      (row) =>
        /* @gate-identity check-gui-status-judgments/gui-status-005 */
        row.status === "covered" && row.coveringFactRef === fullRef,
    )
    .map((row) => normalizeDecisionId(row.decisionRef));
  const supportedDecisionIds = [
    ...new Set([...directlySupportedDecisionIds, ...coveredDecisionIds]),
  ].sort();

  return (
    <aside
      data-testid="fact-inspector"
      className={`flex w-[26rem] shrink-0 flex-col overflow-y-auto ${side === "left" ? "border-l" : "border-r"} border-border bg-surface`}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <GitBranch weight="duotone" className="shrink-0 text-text-muted" />
        {onFocusGraph ? (
          <EntityRefLink
            entityRef={fullRef}
            onNavigate={onFocusGraph}
            title={fullRef}
            className="min-w-0 truncate font-mono text-xs text-text-muted hover:text-accent hover:underline"
          />
        ) : (
          <span className="min-w-0 truncate font-mono text-xs text-text-muted">{anchor}</span>
        )}
        <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[11px] text-text-faint">
          {t("components.factInspector.title")}
        </span>
        {fact && (
          <CopyContextButton
            compact
            buildText={() =>
              buildEntityJumpContext(
                fullRef,
                relations,
                decisions,
                facts,
                tasks,
                t("components.factInspector.checkingSourceSupportingRelationshipsContradictionsSupersedeStatus"),
              )
            }
          />
        )}
        {onFocusGraph && (
          <button
            onClick={() => onFocusGraph(fullRef)}
            title={t("components.factInspector.focusFactDiagram")}
            className="grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-accent"
          >
            <Graph weight="bold" />
          </button>
        )}
        {onClose && (
          <button
            onClick={onClose}
            title={t("components.factInspector.closeFactInspector")}
            className="ml-auto grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-3 px-3 py-3">
        {!fact ? (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            <div className="flex items-center gap-1 font-semibold">
              <WarningCircle weight="bold" />
              {t("components.factInspector.danglingFactReference")}
            </div>
            <div className="mt-1 font-mono">
              {onFocusGraph ? (
                <EntityRefLink
                  entityRef={factRef}
                  onNavigate={onFocusGraph}
                  title={factRef}
                  className="text-danger hover:underline"
                />
              ) : factRef}
            </div>
            <p className="mt-1 leading-relaxed">
              {t("components.factInspector.inv6WillDetectAnchorNotPresent")}
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-md border border-stale/30 bg-stale/5 px-2.5 py-3">
              <div className="flex items-center gap-2">
                <span className="rounded bg-stale px-1.5 py-0.5 font-mono text-[11px] text-stale-fg">
                  {fact.category}
                </span>
                <span className="font-mono text-[11px] text-text-faint">{fact.at}</span>
                <span className="font-mono text-[11px] text-text-faint">{t("components.factInspector.confidenceValue", { confidence: fact.confidence })}</span>
                {fact.invalidated && (
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-stale">
                    <WarningCircle weight="bold" />
                    已失效
                  </span>
                )}
              </div>
              <p className="mt-2 text-[13px] font-medium leading-relaxed text-text">{fact.text}</p>
              <div className="mt-1 font-mono text-[11px] text-text-faint">{t("components.factInspector.sourceValue", { source: fact.source ?? t("components.factInspector.unknown") })}</div>
            </div>

            <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
              <div className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                {t("components.factInspector.taskPackage")}
              </div>
              <div className="mt-1 flex items-center gap-2">
                {onNavigateTask ? (
                  <EntityRefLink
                    entityRef={`task/${fact.taskId}`}
                    onNavigate={() => onNavigateTask(fact.taskId)}
                    title={t("components.factInspector.jumpSourceTask")}
                    className="font-mono text-[12px] text-accent hover:underline"
                  />
                ) : (
                  <span className="font-mono text-[12px] text-text">{fact.taskId}</span>
                )}
                <span className="min-w-0 truncate text-[12px] text-text-muted">
                  {task?.title ?? t("components.factInspector.hostTaskNotProjectedByCurrentTask")}
                </span>
              </div>
              {task && (
                <div className="mt-1 font-mono text-[11px] text-text-faint">
                  {t("components.factInspector.moduleSourceValue", { module: task.module, source: task.source })}
                </div>
              )}
            </div>

            <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
            <div className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                {t("components.factInspector.provenance")}
              </div>
              {fact.provenance?.length ? (
                <div className="mt-1 space-y-1">
                  {fact.provenance.map((entry) => (
                    <div key={`${entry.sessionId}-${entry.boundAt}`} className="font-mono text-[11px] text-text-muted">
                      {entry.runtime}:{entry.sessionId.slice(0, 8)}... · {localDateTime(entry.boundAt) ?? "—"}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-[12px] text-text-faint">
                  {t("components.factInspector.noProvenance")}
                </p>
              )}
            </div>
          </>
        )}

        <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
          <div className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
            {t("components.factInspector.incomingRelation")}
          </div>
          {inbound.length === 0 ? (
            <p className="mt-1 text-[12px] text-text-faint">{t("components.factInspector.noIncomingRelation")}</p>
          ) : (
            <div className="mt-1 space-y-1.5">
              {inbound.map((relation, index) => (
                <div key={`${relation.from}-${relation.kind}-${index}`} className="rounded border border-border bg-surface px-2 py-1.5">
                  <div className="flex items-center gap-1.5 font-mono text-[11px]">
                    <EndpointRef
                      raw={relation.from}
                      onNavigateDecision={onNavigateDecision}
                      onNavigateTask={onNavigateTask}
                      onFocusGraph={onFocusGraph}
                    />
                    <ArrowSquareOut weight="bold" className="text-[11px] text-text-faint" />
                    <span className={
                      relation.kind === "refuted-by" || relation.kind === "supersedes-fact"
                        ? "text-stale"
                        : "text-accent"
                    }>
                      {relation.kind}
                    </span>
                  </div>
                  {relation.rationale && (
                    <div className="mt-1 text-[11px] leading-snug text-text-muted">
                      {relation.rationale}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {supportedDecisionIds.length > 0 && (
          <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
            <div className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
              {t("components.factInspector.supportingDecisionTitle")}
            </div>
            <div className="mt-1 space-y-1">
              {supportedDecisionIds.map((decId) => {
                const decision = decisions.find(
                  (candidate) => candidate.decisionId === decId,
                );
                return (
                <div key={decId} className="text-[12px]">
                  {onNavigateDecision ? (
                    <button
                      onClick={() => onNavigateDecision(decId)}
                      className="font-mono text-accent hover:underline"
                      title={t("components.factInspector.jumpDecision")}
                    >
                      {decId}
                    </button>
                  ) : (
                    <span className="font-mono text-accent">{decId}</span>
                  )}
                  <span className="ml-1 text-text-muted">{decision?.title ?? t("components.factInspector.unknownDecision")}</span>
                </div>
                );
              })}
            </div>
          </div>
        )}

        {(contradictions.length > 0 || supersedingRelations.length > 0) && (
          <div className="rounded-md border border-stale/40 bg-stale/10 px-2.5 py-2 text-stale">
            <div className="flex items-center gap-1 text-[12px] font-semibold">
              <WarningCircle weight="bold" />
              {t("components.factInspector.dangerousLiaisons")}
            </div>
            {contradictions.length > 0 && (
              <div className="mt-1 font-mono text-[11px]">
                {t("components.factInspector.contradictsValue", { value: contradictions.map((relation) => shortEndpoint(relation.from)).join(", ") })}
              </div>
            )}
            {supersedingRelations.length > 0 && (
              <div className="mt-1 font-mono text-[11px]">
                {t("components.factInspector.replacedByValue", { value: supersedingRelations.map((relation) => shortEndpoint(relation.from)).join(", ") })}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
