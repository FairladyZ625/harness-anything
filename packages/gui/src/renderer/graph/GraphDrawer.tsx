import { X, GitBranch, ArrowSquareOut, ArrowsOutSimple, Crosshair } from "@phosphor-icons/react";
import type { RelationEdge } from "../model/types";
import {
  StatusBadge,
  CloseoutBadge,
  EngineBadge,
  FreshnessTag,
} from "../components/badges";
import { isExternal } from "../model/types";
import { KIND_LABEL, KIND_LABEL_IN } from "./constants";
import type { NodePos } from "./endpoint";
import { endpointToNodeId } from "./endpoint";
import type { DecisionRow, FactRef } from "../model/types";
import { t, Trans } from "../i18n/index.tsx";

const truncate = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

interface Props {
  focusNode?: NodePos;
  focusEdge?: RelationEdge;
  nodes: Map<string, NodePos>;
  edges: RelationEdge[];
  upCount: number;
  downCount: number;
  onClose: () => void;
  onFocus: (id: string | null) => void;
  /** W2B 活链接:在列表/详情侧打开该 entity(task→detail, decision→pool, fact→triage) */
  onNavigateEntity?: (ref: string) => void;
  /**
   * 抽屉里当前展示的节点是否已经是焦点(dec_01KXA7811SVVT8P66HNDFZQ7DF — 关系图
   * 可用性)。是 → 隐藏「设为焦点」按钮;否 → 显示,点一下显式换焦点。
   */
  isFocused?: boolean;
  /** 抽屉里「设为焦点」按钮触发的回调;父组件负责推焦点历史。 */
  onSetAsFocus?: () => void;
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
  onNavigateEntity,
  isFocused,
  onSetAsFocus,
}: Props) {
  if (focusEdge) {
    return (
      <aside className="flex w-[26rem] shrink-0 flex-col overflow-y-auto border-l border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <GitBranch weight="duotone" className="shrink-0 text-text-muted" />
          <span className="font-mono ui-meta text-text-muted">{t("graph.graphDrawer.edgeRelation")}</span>
          <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[11px] text-text-faint">
            {focusEdge.kind}
          </span>
          <button
            onClick={onClose}
            title={t("graph.graphDrawer.exitFocusEsc")}
            className="ml-auto grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-3 py-3">
          <p className="ui-body leading-snug text-text">
            <Trans
              message="graph.graphDrawer.edgeKindMessage"
              values={{ kind: <strong>{KIND_LABEL[focusEdge.kind] ?? focusEdge.kind}</strong> }}
            />
          </p>
          <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2 flex flex-col gap-2 ui-meta text-text-muted">
             <div><span className="font-bold text-text">{t("graph.graphDrawer.from")}</span> {focusEdge.from}</div>
             <div><span className="font-bold text-text">{t("graph.graphDrawer.to")}</span> {focusEdge.to}</div>
          </div>
          {focusEdge.provenance && (
             <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2 flex flex-col gap-1">
               <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                 {t("graph.graphDrawer.provenance")}
               </span>
               <div className="font-mono ui-meta text-text-muted">
                 {focusEdge.provenance}
               </div>
             </div>
          )}
          <div className="flex gap-2">
            <button
               onClick={() => onFocus(endpointToNodeId(focusEdge.from))}
               className="flex-1 rounded border border-border px-2 py-1.5 ui-meta text-text-muted hover:bg-surface-raised hover:text-text"
            >
              {t("graph.graphDrawer.jumpSourceNode")}</button>
            <button
               onClick={() => onFocus(endpointToNodeId(focusEdge.to))}
               className="flex-1 rounded border border-border px-2 py-1.5 ui-meta text-text-muted hover:bg-surface-raised hover:text-text"
            >
              {t("graph.graphDrawer.jumpTargetNode")}</button>
          </div>
        </div>
      </aside>
    );
  }

  if (!focusNode) return null;

  const focusId = focusNode.id;
  const focusTask = focusNode.task ?? null;
  const directOut = edges.filter((e) => endpointToNodeId(e.from) === focusId);
  const directIn = edges.filter((e) => endpointToNodeId(e.to) === focusId);

  return (
    <aside className="flex w-[26rem] shrink-0 flex-col overflow-y-auto border-l border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <GitBranch weight="duotone" className="shrink-0 text-text-muted" />
        <span className="font-mono ui-meta text-text-muted">{focusNode.id}</span>
        <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[11px] text-text-faint">
          {focusNode.entity}
        </span>
        {onNavigateEntity && (
          <button
            onClick={() =>
              onNavigateEntity(
                focusNode.entity === "task"
                  ? `task/${focusNode.id}`
                  : focusNode.id,
              )
            }
            title={t("graph.graphDrawer.openSidebarTaskDetailsDecisionDecisionPool")}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-muted hover:border-border-strong hover:text-text"
          >
            <ArrowsOutSimple weight="bold" className="text-[11px]" />
            {t("graph.graphDrawer.open")}</button>
        )}
        {onSetAsFocus && (
          isFocused ? (
            <span
              title={t("graph.graphDrawer.nodeAlreadyFocused")}
              className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent"
            >
              <Crosshair weight="bold" className="text-[11px]" />
              {t("graph.graphDrawer.focus")}</span>
          ) : (
            <button
              onClick={onSetAsFocus}
              title={t("graph.graphDrawer.setNodeAsFocusGraphDoubleClicking")}
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-muted hover:border-accent hover:text-accent"
            >
              <Crosshair weight="bold" className="text-[11px]" />
              {t("graph.graphDrawer.setFocus")}</button>
          )
        )}
        <button
          onClick={onClose}
          title={t("graph.graphDrawer.exitDrawerEsc")}
          className="ml-auto grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
        >
          <X weight="bold" />
        </button>
      </div>

      <div className="flex flex-col gap-3 px-3 py-3">
        <p className="ui-title font-semibold leading-snug text-text">{focusNode.label}</p>

        {focusTask ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={focusTask.coordinationStatus} />
              <CloseoutBadge value={focusTask.closeoutReadiness} />
              <EngineBadge engine={focusTask.engine} locked={isExternal(focusTask)} />
            </div>
            <FreshnessTag freshness={focusTask.freshness} lastKnownAt={focusTask.lastKnownAt} />
            <div className="flex gap-3 font-mono ui-meta text-text-muted">
              <span>{t("graph.graphDrawer.moduleValue", { module: focusTask.module })}</span>
              <span>{t("graph.graphDrawer.rawValue", { raw: focusTask.rawStatus })}</span>
            </div>
          </>
        ) : focusNode.entity === "decision" ? (
          <div className="flex flex-col gap-3">
            {(() => {
              const dec = focusNode.raw as DecisionRow;
              return (
                <>
                  <div className="flex items-center gap-2 font-mono ui-meta">
                    <span className="rounded bg-accent px-1.5 py-0.5 text-accent-fg">
                      {dec.state}
                    </span>
                    <span className="text-text-muted">{t("graph.graphDrawer.riskUrgency", { risk: dec.riskTier ?? t("graph.graphDrawer.unknown"), urgency: dec.urgency ?? t("graph.graphDrawer.unknown") })}</span>
                  </div>
                  <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
                    <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                      {t("graph.graphDrawer.question")}
                    </span>
                    <p className="ui-body font-medium text-text mt-1 max-h-[38vh] overflow-y-auto overscroll-contain pr-1">{dec.question}</p>
                  </div>
                  {dec.chosen.length > 0 && (
                    <div className="rounded-md border border-accent/30 bg-accent-fg/5 px-2.5 py-2">
                      <span className="font-mono text-[11px] uppercase tracking-wide text-accent">
                        {t("graph.graphDrawer.chosen")}
                      </span>
                      <div className="mt-1 max-h-[38vh] overflow-y-auto overscroll-contain pr-1 flex flex-col gap-1">
                        {dec.chosen.map(c => (
                          <p key={c.id} className="ui-body text-text">{c.text}</p>
                        ))}
                      </div>
                    </div>
                  )}
                  {dec.claims && dec.claims.length > 0 && (
                    <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
                      <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                        {t("graph.graphDrawer.claims")}
                      </span>
                      <ul className="list-inside list-disc ui-body text-text-muted mt-1 max-h-[34vh] overflow-y-auto overscroll-contain pr-1">
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
                  <div className="flex items-center gap-2 font-mono ui-meta">
                    <span className="rounded bg-stale px-1.5 py-0.5 text-stale-fg">
                      {fact.category}
                    </span>
                    <span className="text-text-muted">@ {fact.at}</span>
                  </div>
                  <div className="rounded-md border border-stale/30 bg-stale/5 px-2.5 py-3">
                    <span className="font-mono text-[11px] uppercase tracking-wide text-stale">
                      {t("graph.graphDrawer.factObservation")}
                    </span>
                    <p className="ui-body leading-relaxed text-text mt-1.5 font-medium max-h-[42vh] overflow-y-auto overscroll-contain pr-1">{fact.text}</p>
                  </div>
                  <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2 flex flex-col gap-1">
                    <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                      {t("graph.graphDrawer.anchorDetails")}
                    </span>
                    <div className="font-mono ui-meta text-text-muted">
                       <div>{t("graph.graphDrawer.taskIdValue", { taskId: fact.taskId })}</div>
                       <div>{t("graph.graphDrawer.anchorValue", { anchor: fact.anchor })}</div>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2 ui-meta text-text-muted">
            {focusNode.entity} {t("graph.graphDrawer.node")}</div>
        )}

        <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2 font-mono ui-meta text-text-muted">
          {t("graph.graphDrawer.linkUpstream")}{upCount} {t("graph.graphDrawer.downstream")}{downCount}
        </div>

        {directOut.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
              {t("graph.graphDrawer.outSide")}{directOut.length}
            </span>
            <div className="flex flex-col gap-1 max-h-[30vh] overflow-y-auto overscroll-contain pr-1">
              {directOut.map((e, i) => {
                const peer = nodes.get(endpointToNodeId(e.to));
                return (
                  <button
                    key={`o-${i}`}
                    onClick={() => onFocus(endpointToNodeId(e.to))}
                    className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left ui-meta hover:bg-surface-raised"
                  >
                    <span className="shrink-0 text-[11px] text-text-faint">{KIND_LABEL[e.kind]} →</span>
                    <span className="shrink-0 font-mono ui-meta text-text-muted">{e.to}</span>
                    <span className="truncate text-text-muted">{peer ? truncate(peer.label, 20) : ""}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {directIn.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
              {t("graph.graphDrawer.enterEdge")}{directIn.length}
            </span>
            <div className="flex flex-col gap-1 max-h-[30vh] overflow-y-auto overscroll-contain pr-1">
              {directIn.map((e, i) => {
                const peer = nodes.get(endpointToNodeId(e.from));
                return (
                  <button
                    key={`i-${i}`}
                    onClick={() => onFocus(endpointToNodeId(e.from))}
                    className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left ui-meta hover:bg-surface-raised"
                  >
                    <ArrowSquareOut weight="bold" className="shrink-0 text-[11px] text-text-faint" />
                    <span className="shrink-0 text-[11px] text-text-faint">← {KIND_LABEL_IN[e.kind]}</span>
                    <span className="shrink-0 font-mono ui-meta text-text-muted">{e.from}</span>
                    <span className="truncate text-text-muted">{peer ? truncate(peer.label, 20) : ""}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
