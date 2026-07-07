import { X, GitBranch, ArrowSquareOut } from "@phosphor-icons/react";
import type { RelationEdge } from "../model/types";
import {
  StatusBadge,
  CloseoutBadge,
  EngineBadge,
  FreshnessTag,
} from "../components/badges";
import { isExternal } from "../model/types";
import { DOC_CONTENT, SAMPLE_MARKDOWN } from "../model/mock";
import { KIND_LABEL, KIND_LABEL_IN } from "./constants";
import type { NodePos } from "./endpoint";
import { endpointToNodeId } from "./endpoint";
import type { DecisionRow, FactRef } from "../model/types";

const truncate = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** 从任务 contract.md 提取摘要信息 */
function extractContractDigest(md: string) {
  const lines = md.split("\n");
  let goal = "";
  const goalIdx = lines.findIndex((l) => /^##\s*目标/.test(l));
  if (goalIdx >= 0) {
    for (let i = goalIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith("#")) break;
      if (t) goal += (goal ? " " : "") + t;
    }
  }
  const boxes = md.match(/- \[[ x]\]/g) ?? [];
  const done = md.match(/- \[x\]/g)?.length ?? 0;
  return { goal, acceptTotal: boxes.length, acceptDone: done };
}

interface Props {
  focusNode?: NodePos;
  focusEdge?: RelationEdge;
  nodes: Map<string, NodePos>;
  edges: RelationEdge[];
  upCount: number;
  downCount: number;
  onClose: () => void;
  onFocus: (id: string | null) => void;
}

export function GraphDrawer({
  focusNode,
  focusEdge,
  nodes,
  edges,
  upCount,
  downCount,
  onClose,
  onFocus,
}: Props) {
  if (focusEdge) {
    return (
      <aside className="flex w-[26rem] shrink-0 flex-col overflow-y-auto border-l border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <GitBranch weight="duotone" className="shrink-0 text-text-muted" />
          <span className="font-mono text-xs text-text-muted">Edge (Relation)</span>
          <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-faint">
            {focusEdge.kind}
          </span>
          <button
            onClick={onClose}
            title="退出聚焦 (Esc)"
            className="ml-auto grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-3 py-3">
          <p className="text-[13px] leading-snug text-text">
            这是一个 <strong>{KIND_LABEL[focusEdge.kind] ?? focusEdge.kind}</strong> 关系边。
          </p>
          <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2 flex flex-col gap-2 text-[11px] text-text-muted">
             <div><span className="font-bold text-text">From:</span> {focusEdge.from}</div>
             <div><span className="font-bold text-text">To:</span> {focusEdge.to}</div>
          </div>
          {focusEdge.provenance && (
             <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2 flex flex-col gap-1">
               <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                 Provenance
               </span>
               <div className="font-mono text-[11px] text-text-muted">
                 {focusEdge.provenance}
               </div>
             </div>
          )}
          <div className="flex gap-2">
            <button 
               onClick={() => onFocus(endpointToNodeId(focusEdge.from))}
               className="flex-1 rounded border border-border px-2 py-1.5 text-xs text-text-muted hover:bg-surface-raised hover:text-text"
            >
              跳转源节点
            </button>
            <button 
               onClick={() => onFocus(endpointToNodeId(focusEdge.to))}
               className="flex-1 rounded border border-border px-2 py-1.5 text-xs text-text-muted hover:bg-surface-raised hover:text-text"
            >
              跳转目标节点
            </button>
          </div>
        </div>
      </aside>
    );
  }

  if (!focusNode) return null;

  const focusId = focusNode.id;
  const focusTask = focusNode.task ?? null;
  const directOut = edges.filter((e) => e.from === focusId);
  const directIn = edges.filter((e) => e.to === focusId);

  return (
    <aside className="flex w-[26rem] shrink-0 flex-col overflow-y-auto border-l border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <GitBranch weight="duotone" className="shrink-0 text-text-muted" />
        <span className="font-mono text-xs text-text-muted">{focusNode.id}</span>
        <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-faint">
          {focusNode.entity}
        </span>
        <button
          onClick={onClose}
          title="退出聚焦 (Esc)"
          className="ml-auto grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
        >
          <X weight="bold" />
        </button>
      </div>

      <div className="flex flex-col gap-3 px-3 py-3">
        <p className="text-[13px] leading-snug text-text">{focusNode.label}</p>

        {focusTask ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={focusTask.coordinationStatus} />
              <CloseoutBadge value={focusTask.closeoutReadiness} />
              <EngineBadge engine={focusTask.engine} locked={isExternal(focusTask)} />
            </div>
            <FreshnessTag freshness={focusTask.freshness} lastKnownAt={focusTask.lastKnownAt} />
            <div className="flex gap-3 font-mono text-[11px] text-text-muted">
              <span>module: {focusTask.module}</span>
              <span>raw: {focusTask.rawStatus}</span>
            </div>
            {(() => {
              const digest = extractContractDigest(DOC_CONTENT["contract.md"] ?? SAMPLE_MARKDOWN);
              const missingRequired = focusTask.docs.filter((d) => d.required && !d.present);
              return (
                <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-raised px-2.5 py-2">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                    契约摘要 · contract.md
                  </span>
                  {digest.goal && (
                    <p className="text-xs leading-relaxed text-text-muted">
                      {digest.goal.length > 110 ? `${digest.goal.slice(0, 109)}…` : digest.goal}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px]">
                    {digest.acceptTotal > 0 && (
                      <span className={digest.acceptDone === digest.acceptTotal ? "text-text-muted" : "text-stale"}>
                        验收 {digest.acceptDone}/{digest.acceptTotal}
                      </span>
                    )}
                    <span className="text-text-muted">
                      文档 {focusTask.docs.filter((d) => d.present).length}/{focusTask.docs.length}
                    </span>
                    {missingRequired.length > 0 && (
                      <span className="text-danger">缺必需 {missingRequired.map((d) => d.title).join("、")}</span>
                    )}
                  </div>
                  {focusTask.gates.length > 0 && (
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px]">
                      {focusTask.gates.map((g) => (
                        <span key={g.name} className={g.ok ? "text-text-muted" : "text-danger"} title={g.detail}>
                          {g.ok ? "✓" : "✗"} {g.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        ) : focusNode.entity === "decision" ? (
          <div className="flex flex-col gap-3">
            {(() => {
              const dec = focusNode.raw as DecisionRow;
              return (
                <>
                  <div className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="rounded bg-accent px-1.5 py-0.5 text-accent-fg">
                      {dec.state}
                    </span>
                    <span className="text-text-muted">{dec.riskTier} risk · {dec.urgency} urgency</span>
                  </div>
                  <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
                    <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                      Question
                    </span>
                    <p className="text-[12px] font-medium text-text mt-1">{dec.question}</p>
                  </div>
                  {dec.chosen.length > 0 && (
                    <div className="rounded-md border border-accent/30 bg-accent-fg/5 px-2.5 py-2">
                      <span className="font-mono text-[10px] uppercase tracking-wide text-accent">
                        Chosen
                      </span>
                      {dec.chosen.map(c => (
                        <p key={c.id} className="text-[12px] text-text mt-1">{c.text}</p>
                      ))}
                    </div>
                  )}
                  {dec.claims && dec.claims.length > 0 && (
                    <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
                      <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                        Claims
                      </span>
                      <ul className="list-inside list-disc text-[12px] text-text-muted mt-1">
                        {dec.claims.map(c => (
                          <li key={c.id}>{c.text}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        ) : focusNode.entity === "fact" ? (
          <div className="flex flex-col gap-3">
            {(() => {
              const fact = focusNode.raw as FactRef;
              return (
                <>
                  <div className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="rounded bg-stale px-1.5 py-0.5 text-stale-fg">
                      {fact.category}
                    </span>
                    <span className="text-text-muted">@ {fact.at}</span>
                  </div>
                  <div className="rounded-md border border-stale/30 bg-stale/5 px-2.5 py-3">
                    <span className="font-mono text-[10px] uppercase tracking-wide text-stale">
                      Fact Observation
                    </span>
                    <p className="text-[13px] leading-relaxed text-text mt-1.5 font-medium">{fact.text}</p>
                  </div>
                  <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2 flex flex-col gap-1">
                    <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                      Anchor Details
                    </span>
                    <div className="font-mono text-[11px] text-text-muted">
                       <div>Task ID: {fact.taskId}</div>
                       <div>Anchor: {fact.anchor}</div>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2 text-[11px] text-text-muted">
            {focusNode.entity} 节点
          </div>
        )}

        <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2 font-mono text-[11px] text-text-muted">
          链路：上游 {upCount} · 下游 {downCount}
        </div>

        {directOut.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
              出边 {directOut.length}
            </span>
            {directOut.map((e, i) => {
              const peer = nodes.get(endpointToNodeId(e.to));
              return (
                <button
                  key={`o-${i}`}
                  onClick={() => onFocus(endpointToNodeId(e.to))}
                  className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-surface-raised"
                >
                  <span className="shrink-0 text-[10px] text-text-faint">{KIND_LABEL[e.kind]} →</span>
                  <span className="shrink-0 font-mono text-[11px] text-text-muted">{e.to}</span>
                  <span className="truncate text-text-muted">{peer ? truncate(peer.label, 20) : ""}</span>
                </button>
              );
            })}
          </div>
        )}

        {directIn.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
              入边 {directIn.length}
            </span>
            {directIn.map((e, i) => {
              const peer = nodes.get(endpointToNodeId(e.from));
              return (
                <button
                  key={`i-${i}`}
                  onClick={() => onFocus(endpointToNodeId(e.from))}
                  className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-surface-raised"
                >
                  <ArrowSquareOut weight="bold" className="shrink-0 text-[10px] text-text-faint" />
                  <span className="shrink-0 text-[10px] text-text-faint">← {KIND_LABEL_IN[e.kind]}</span>
                  <span className="shrink-0 font-mono text-[11px] text-text-muted">{e.from}</span>
                  <span className="truncate text-text-muted">{peer ? truncate(peer.label, 20) : ""}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
