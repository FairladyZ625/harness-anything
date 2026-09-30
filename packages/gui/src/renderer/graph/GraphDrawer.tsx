import { PinButton } from "../components/PinButton.tsx";
import { X, GitBranch, ArrowSquareOut, ArrowsOutSimple } from "@phosphor-icons/react";
import type { RelationEdge, TaskRow } from "../model/types";
import { CloseoutBadge, DecisionStateBadge, EngineBadge, FreshnessTag } from "../components/badges";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { Drawer } from "../components/primitives/Drawer.tsx";
import { StatusTag } from "../components/primitives/StatusTag";
import { isExternal } from "../model/types";
import { KIND_LABEL, KIND_LABEL_IN } from "./constants";
import type { NodePos } from "./endpoint";
import { endpointToNodeId } from "./endpoint";
import type { DecisionRow, FactRef } from "../model/types";
import { t } from "../i18n/index.tsx";
import { EntityRefLink } from "../components/EntityRefLink.tsx";

/**
 * 关系详情抽屉(视觉基线 v1 §2.6):复用共享 Drawer 原语的右侧覆盖式抽屉,
 * 画布铺满内容区,抽屉只在选中节点/边时出现。非模态:点画布那一次点击直接生效。
 * 内容(节点五类 / 关系边)由本组件组合;关闭走 Esc / 点背景 / 关闭钮(Drawer 壳层)。
 */

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
  onSetTaskPin?: (task: TaskRow, pinned: boolean) => void;
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
  onSetTaskPin,
}: Props) {
  return (
    <Drawer open onClose={onClose} modal={false} ariaLabel={t("graph.graphDrawer.ariaLabel")}>
      {focusEdge ? (
        <EdgeBody focusEdge={focusEdge} onNavigateEntity={onNavigateEntity} onFocus={onFocus} onClose={onClose} />
      ) : focusNode ? (
        <NodeBody
          focusNode={focusNode}
          nodes={nodes}
          edges={edges}
          upCount={upCount}
          downCount={downCount}
          onNavigateEntity={onNavigateEntity}
          onFocus={onFocus}
          onSetTaskPin={onSetTaskPin}
          onClose={onClose}
        />
      ) : null}
    </Drawer>
  );
}

function DrawerHead({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 border-b border-border pb-2.5">
      <GitBranch weight="duotone" className="shrink-0 text-text-muted" />
      {children}
      <button
        onClick={onClose}
        title={t("graph.graphDrawer.exitFocusEsc")}
        className="ml-auto grid size-6 shrink-0 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
      >
        <X weight="bold" />
      </button>
    </div>
  );
}

function EdgeBody({
  focusEdge,
  onNavigateEntity,
  onFocus,
  onClose,
}: {
  focusEdge: RelationEdge;
  onNavigateEntity?: (ref: string) => void;
  onFocus: (id: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div data-testid="graph-detail-drawer" className="flex flex-col">
      <DrawerHead onClose={onClose}>
        <span className="font-mono text-xs text-text-muted">{t("graph.graphDrawer.edgeRelation")}</span>
        <StatusTag tone="neutral" label={focusEdge.kind} />
      </DrawerHead>
      <div className="flex flex-col gap-3">
        <p className="ui-body leading-snug text-text">
          {t("graph.graphDrawer.edgeKindMessage", { kind: KIND_LABEL[focusEdge.kind] ?? focusEdge.kind })}
        </p>
        <div className="rounded-sm border border-border bg-surface-raised px-2.5 py-2 flex flex-col gap-2 ui-micro text-text-muted">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="font-bold text-text">{t("graph.graphDrawer.from")}</span>{" "}
            <EntityRefLink
              entityRef={focusEdge.from}
              onNavigate={onNavigateEntity ?? (() => onFocus(endpointToNodeId(focusEdge.from)))}
              title={focusEdge.from}
              className="break-all font-mono ui-micro text-accent hover:underline"
            />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="font-bold text-text">{t("graph.graphDrawer.to")}</span>{" "}
            <EntityRefLink
              entityRef={focusEdge.to}
              onNavigate={onNavigateEntity ?? (() => onFocus(endpointToNodeId(focusEdge.to)))}
              title={focusEdge.to}
              className="break-all font-mono ui-micro text-accent hover:underline"
            />
          </div>
        </div>
        {focusEdge.provenance && (
          <div className="rounded-sm border border-border bg-surface-raised px-2.5 py-2 flex flex-col gap-1">
            <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">
              {t("graph.graphDrawer.provenance")}
            </span>
            <div className="font-mono ui-micro text-text-muted">{focusEdge.provenance}</div>
          </div>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => onFocus(endpointToNodeId(focusEdge.from))}
            className="flex-1 rounded-xs border border-border px-2 py-1.5 text-xs text-text-muted hover:bg-surface-raised hover:text-text"
          >
            {t("graph.graphDrawer.jumpSourceNode")}
          </button>
          <button
            onClick={() => onFocus(endpointToNodeId(focusEdge.to))}
            className="flex-1 rounded-xs border border-border px-2 py-1.5 text-xs text-text-muted hover:bg-surface-raised hover:text-text"
          >
            {t("graph.graphDrawer.jumpTargetNode")}
          </button>
        </div>
      </div>
    </div>
  );
}

function NodeBody({
  focusNode,
  nodes,
  edges,
  upCount,
  downCount,
  onNavigateEntity,
  onFocus,
  onSetTaskPin,
  onClose,
}: {
  focusNode: NodePos;
  nodes: Map<string, NodePos>;
  edges: RelationEdge[];
  upCount: number;
  downCount: number;
  onNavigateEntity?: (ref: string) => void;
  onFocus: (id: string | null) => void;
  onSetTaskPin?: (task: TaskRow, pinned: boolean) => void;
  onClose: () => void;
}) {
  const focusId = focusNode.id;
  const focusTask = focusNode.task ?? null;
  const navRef = focusNode.entity === "task" ? `task/${focusNode.id}` : focusNode.id;
  const directOut = edges.filter((e) => endpointToNodeId(e.from) === focusId);
  const directIn = edges.filter((e) => endpointToNodeId(e.to) === focusId);

  return (
    <div data-testid="graph-detail-drawer" className="flex flex-col">
      <DrawerHead onClose={onClose}>
        <EntityRefLink
          entityRef={navRef}
          onNavigate={onNavigateEntity ?? (() => onFocus(focusId))}
          title={focusNode.id}
          className="font-mono text-xs text-accent hover:underline"
        />
        <StatusTag tone="neutral" label={focusNode.entity} />
        {onNavigateEntity && (
          <button
            onClick={() => onNavigateEntity(navRef)}
            title={t("graph.graphDrawer.openSidebarTaskDetailsDecisionDecisionPool")}
            className="inline-flex items-center gap-1 rounded-xs border border-border px-1.5 py-0.5 ui-micro text-text-muted hover:border-border-strong hover:text-text"
          >
            <ArrowsOutSimple weight="bold" className="ui-micro" />
            {t("graph.graphDrawer.open")}
          </button>
        )}
        {focusTask && onSetTaskPin && (
          <PinButton
            testId={`graph-drawer-pin-toggle-${focusTask.taskId}`}
            onClick={() => onSetTaskPin(focusTask, focusTask.pinned !== true)}
            pinned={focusTask.pinned === true}
          />
        )}
      </DrawerHead>

      <div className="flex flex-col gap-3">
        <p className="ui-body leading-snug text-text">{focusNode.label}</p>

        {focusTask ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusTag status={focusTask.coordinationStatus} />
              <CloseoutBadge value={focusTask.closeoutReadiness} />
              <EngineBadge engine={focusTask.engine} locked={isExternal(focusTask)} />
            </div>
            <FreshnessTag freshness={focusTask.freshness} lastKnownAt={focusTask.lastKnownAt} />
            <div className="flex gap-3 font-mono ui-micro text-text-muted">
              <span>{t("graph.graphDrawer.rawValue", { raw: focusTask.rawStatus })}</span>
            </div>
          </>
        ) : focusNode.entity === "decision" ? (
          <DecisionBody decision={focusNode.raw as DecisionRow} />
        ) : focusNode.entity === "fact" ? (
          <FactBody fact={focusNode.raw as FactRef} onNavigate={onNavigateEntity} onFocus={onFocus} focusId={focusId} />
        ) : (
          <div className="rounded-sm border border-border bg-surface-raised px-2.5 py-2 ui-micro text-text-muted">
            {focusNode.entity}
            {t("graph.graphDrawer.node")}
          </div>
        )}

        <div className="rounded-sm border border-border bg-surface-raised px-2.5 py-2 font-mono ui-micro text-text-muted">
          {t("graph.graphDrawer.chainCounts", { up: upCount, down: downCount })}
        </div>

        {directOut.length > 0 && (
          <div className="flex flex-col">
            <span className="mb-1 font-mono ui-micro uppercase tracking-wide text-text-faint">
              {t("graph.graphDrawer.outEdgesCount", { count: directOut.length })}
            </span>
            {directOut.map((e, i) => (
              <DenseRow
                key={`o-${i}`}
                tag={<span className="ui-micro text-text-faint">{KIND_LABEL[e.kind]} →</span>}
                title={endpointToNodeId(e.to)}
                reason={nodes.get(endpointToNodeId(e.to))?.label}
                onClick={() => onFocus(endpointToNodeId(e.to))}
              />
            ))}
          </div>
        )}

        {directIn.length > 0 && (
          <div className="flex flex-col">
            <span className="mb-1 font-mono ui-micro uppercase tracking-wide text-text-faint">
              {t("graph.graphDrawer.inEdgesCount", { count: directIn.length })}
            </span>
            {directIn.map((e, i) => (
              <DenseRow
                key={`i-${i}`}
                tag={
                  <span className="flex items-center gap-1 ui-micro text-text-faint">
                    <ArrowSquareOut weight="bold" className="shrink-0" />← {KIND_LABEL_IN[e.kind]}
                  </span>
                }
                title={endpointToNodeId(e.from)}
                reason={nodes.get(endpointToNodeId(e.from))?.label}
                onClick={() => onFocus(endpointToNodeId(e.from))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DecisionBody({ decision }: { decision: DecisionRow }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 font-mono ui-micro">
        <DecisionStateBadge state={decision.state} />
        <span className="text-text-muted">
          {t("graph.graphDrawer.riskUrgency", {
            risk: decision.riskTier ?? t("graph.graphDrawer.unknown"),
            urgency: decision.urgency ?? t("graph.graphDrawer.unknown"),
          })}
        </span>
      </div>
      <div className="rounded-sm border border-border bg-surface-raised px-2.5 py-2">
        <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">
          {t("graph.graphDrawer.question")}
        </span>
        <p className="ui-meta font-medium text-text mt-1">{decision.question}</p>
      </div>
      {decision.chosen.length > 0 && (
        <div className="rounded-sm border border-accent/30 bg-accent-fg/5 px-2.5 py-2">
          <span className="font-mono ui-micro uppercase tracking-wide text-accent">
            {t("graph.graphDrawer.chosen")}
          </span>
          {decision.chosen.map((c) => (
            <p key={c.id} className="ui-meta text-text mt-1">
              {c.text}
            </p>
          ))}
        </div>
      )}
      {decision.claims && decision.claims.length > 0 && (
        <div className="rounded-sm border border-border bg-surface-raised px-2.5 py-2">
          <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">
            {t("graph.graphDrawer.claims")}
          </span>
          <ul className="list-inside list-disc ui-meta text-text-muted mt-1">
            {decision.claims.map((c) => (
              <li key={c.id}>{c.text}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FactBody({
  fact,
  onNavigate,
  onFocus,
  focusId,
}: {
  fact: FactRef;
  onNavigate?: (ref: string) => void;
  onFocus: (id: string | null) => void;
  focusId: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 font-mono ui-micro">
        <span className="rounded-xs bg-stale px-1.5 py-px text-stale-fg">{fact.category}</span>
        <span className="text-text-muted">@ {fact.at}</span>
      </div>
      <div className="rounded-sm border border-stale/30 bg-stale/5 px-2.5 py-3">
        <span className="font-mono ui-micro uppercase tracking-wide text-stale">
          {t("graph.graphDrawer.factObservation")}
        </span>
        <p className="ui-body leading-relaxed text-text mt-1.5 font-medium">{fact.text}</p>
      </div>
      <div className="rounded-sm border border-border bg-surface-raised px-2.5 py-2 flex flex-col gap-1">
        <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">
          {t("graph.graphDrawer.anchorDetails")}
        </span>
        <div className="flex flex-col gap-0.5 font-mono ui-micro text-text-muted">
          {fact.taskId && (
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <span className="text-text-faint">{t("graph.graphDrawer.anchorTaskLabel")}</span>{" "}
              <EntityRefLink
                entityRef={`task/${fact.taskId}`}
                onNavigate={onNavigate ?? (() => onFocus(focusId))}
                title={fact.taskId}
                className="text-accent hover:underline"
              />
            </div>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="text-text-faint">{t("graph.graphDrawer.anchorLabel")}</span>{" "}
            <EntityRefLink
              entityRef={fact.anchor.startsWith("fact/") ? fact.anchor : `fact/${fact.anchor}`}
              onNavigate={onNavigate ?? (() => onFocus(focusId))}
              title={fact.anchor}
              className="break-all text-accent hover:underline"
            >
              {fact.anchor}
            </EntityRefLink>
          </div>
        </div>
      </div>
    </div>
  );
}
