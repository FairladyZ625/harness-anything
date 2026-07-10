import { ArrowSquareOut, GitBranch, WarningCircle, X } from "@phosphor-icons/react";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types";
import { normalizeDecisionId } from "../model/triadic";

function shortEndpoint(raw: string): string {
  if (raw.startsWith("decision/")) return normalizeDecisionId(raw);
  if (raw.startsWith("fact/")) return raw.replace(/^fact\//, "");
  return raw.replace(/^task\//, "");
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
}: {
  factRef: string;
  facts: FactRef[];
  tasks: TaskRow[];
  decisions: DecisionRow[];
  relations: RelationEdge[];
  onClose: () => void;
  /** W2B 活链接:点击 decision ref 跳转 */
  onNavigateDecision?: (decisionId: string) => void;
  /** W2B 活链接:点击 task ref 跳转 */
  onNavigateTask?: (taskId: string) => void;
}) {
  const anchor = factRef.replace(/^fact\//, "");
  const fullRef = `fact/${anchor}`;
  const fact = facts.find((candidate) => candidate.anchor === anchor);
  const task = fact ? tasks.find((candidate) => candidate.taskId === fact.taskId) : undefined;
  const inbound = relations.filter((relation) => relation.to === fullRef);
  const outbound = relations.filter((relation) => relation.from === fullRef);
  const invalidators = inbound.filter(
    (relation) => relation.kind === "invalidated-by" || relation.kind === "supersedes-fact",
  );
  const supportedDecisions = [...inbound, ...outbound]
    .filter((relation) => relation.from.startsWith("decision/") || relation.to.startsWith("decision/"))
    .map((relation) => {
      const id = normalizeDecisionId(relation.from.startsWith("decision/") ? relation.from : relation.to);
      return { relation, decision: decisions.find((decision) => decision.decisionId === id) };
    });

  return (
    <aside className="flex w-[26rem] shrink-0 flex-col overflow-y-auto border-l border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <GitBranch weight="duotone" className="shrink-0 text-text-muted" />
        <span className="min-w-0 truncate font-mono text-xs text-text-muted">{anchor}</span>
        <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-faint">
          Fact Inspector
        </span>
        <button
          onClick={onClose}
          title="关闭 Fact Inspector"
          className="ml-auto grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
        >
          <X weight="bold" />
        </button>
      </div>

      <div className="flex flex-col gap-3 px-3 py-3">
        {!fact ? (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            <div className="flex items-center gap-1 font-semibold">
              <WarningCircle weight="bold" />
              悬空 fact 引用
            </div>
            <div className="mt-1 font-mono">{factRef}</div>
            <p className="mt-1 leading-relaxed">
              INV-6 会在真实投影中检出该锚不存在。GUI 只渲染告警，不创建或修复 fact。
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-md border border-stale/30 bg-stale/5 px-2.5 py-3">
              <div className="flex items-center gap-2">
                <span className="rounded bg-stale px-1.5 py-0.5 font-mono text-[10px] text-stale-fg">
                  {fact.category}
                </span>
                <span className="font-mono text-[11px] text-text-faint">{fact.at}</span>
                {fact.invalidated && (
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-stale">
                    <WarningCircle weight="bold" />
                    已失效
                  </span>
                )}
              </div>
              <p className="mt-2 text-[13px] font-medium leading-relaxed text-text">{fact.text}</p>
            </div>

            <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
              <div className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                所在 task 包
              </div>
              <div className="mt-1 flex items-center gap-2">
                {onNavigateTask && task ? (
                  <button
                    onClick={() => onNavigateTask(fact.taskId)}
                    className="font-mono text-[12px] text-accent hover:underline"
                    title="跳转到来源 task"
                  >
                    {fact.taskId}
                  </button>
                ) : (
                  <span className="font-mono text-[12px] text-text">{fact.taskId}</span>
                )}
                <span className="min-w-0 truncate text-[12px] text-text-muted">
                  {task?.title ?? "宿主 task 不在当前 task 投影"}
                </span>
              </div>
              {task && (
                <div className="mt-1 font-mono text-[11px] text-text-faint">
                  module {task.module} · source {task.source}
                </div>
              )}
            </div>

            <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
              <div className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                provenance
              </div>
              {task?.provenance?.length ? (
                <div className="mt-1 space-y-1">
                  {task.provenance.map((entry) => (
                    <div key={`${entry.sessionId}-${entry.boundAt}`} className="font-mono text-[11px] text-text-muted">
                      {entry.runtime}:{entry.sessionId.slice(0, 8)}... · {entry.boundAt.slice(0, 16).replace("T", " ")}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-[12px] text-text-faint">
                  当前 task 投影未携带 entity provenance；后续由宿主 task 包投影补齐。
                </p>
              )}
            </div>
          </>
        )}

        <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
          <div className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
            入边 relation
          </div>
          {inbound.length === 0 ? (
            <p className="mt-1 text-[12px] text-text-faint">当前投影没有指向该 fact 的入边。</p>
          ) : (
            <div className="mt-1 space-y-1.5">
              {inbound.map((relation, index) => (
                <div key={`${relation.from}-${relation.kind}-${index}`} className="rounded border border-border bg-surface px-2 py-1.5">
                  <div className="flex items-center gap-1.5 font-mono text-[11px]">
                    <span className="text-text-faint">{shortEndpoint(relation.from)}</span>
                    <ArrowSquareOut weight="bold" className="text-[10px] text-text-faint" />
                    <span className={
                      relation.kind === "invalidated-by" || relation.kind === "supersedes-fact"
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

        {supportedDecisions.length > 0 && (
          <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
            <div className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
              支撑的 decision
            </div>
            <div className="mt-1 space-y-1">
              {supportedDecisions.map(({ relation, decision }) => {
                const decId = normalizeDecisionId(
                  relation.from.startsWith("decision/") ? relation.from : relation.to,
                );
                return (
                <div key={relation.from} className="text-[12px]">
                  {onNavigateDecision ? (
                    <button
                      onClick={() => onNavigateDecision(decId)}
                      className="font-mono text-accent hover:underline"
                      title="跳转到该 decision"
                    >
                      {shortEndpoint(relation.from)}
                    </button>
                  ) : (
                    <span className="font-mono text-accent">{shortEndpoint(relation.from)}</span>
                  )}
                  <span className="ml-1 text-text-muted">{decision?.title ?? "未知 decision"}</span>
                </div>
                );
              })}
            </div>
          </div>
        )}

        {invalidators.length > 0 && (
          <div className="rounded-md border border-stale/40 bg-stale/10 px-2.5 py-2 text-stale">
            <div className="flex items-center gap-1 text-[12px] font-semibold">
              <WarningCircle weight="bold" />
              该 fact 被失效边指向
            </div>
            <div className="mt-1 font-mono text-[11px]">
              {invalidators.map((relation) => shortEndpoint(relation.from)).join(", ")}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
