import type { MouseEvent } from "react";
import { Handle, Position } from "@xyflow/react";
import { X, Crosshair, ArrowsOutSimple } from "@phosphor-icons/react";
import { StatusBadge, CloseoutBadge, FreshnessTag } from "../../components/badges";
import type { TaskRow, DecisionRow, FactRef } from "../../model/types";
import { moduleDisplayLabel } from "../moduleAssignment";

/**
 * 无限画布 ego 节点(dec_01KXBGJQFQARSZHHQW1WADFDNC)。一个组件两态:
 *   chip — 紧凑一条(默认),单击就地展开成卡片并长出下一环邻居。
 *   card — 详情卡片,内容超出时内部滚动(不静默剪裁)。
 *
 * 交互回调由 GraphView 注入 data:onCollapse / onRefocus / onNavigate。
 * chip 的「单击展开」走 ReactFlow onNodeClick,不在此处理。
 */

type Entity = "task" | "decision" | "fact";

const AXIS_VAR: Record<Entity, string> = {
  task: "var(--color-axis-execution)",
  decision: "var(--color-axis-authority)",
  fact: "var(--color-axis-evidence)",
};
const KIND_LETTER: Record<Entity, string> = { task: "T", decision: "D", fact: "F" };
const HANDLE_CLS = "!h-2 !w-2 !min-w-2 !min-h-2 !border-0 !bg-[var(--color-border-strong)]";

function EgoHandles() {
  return (
    <>
      <Handle type="target" position={Position.Left} className={HANDLE_CLS} />
      <Handle type="source" position={Position.Right} className={HANDLE_CLS} />
    </>
  );
}

export function EgoNode({ data, selected }: any) {
  const entity: Entity = data.entity;
  const axis = AXIS_VAR[entity];
  const focus = Boolean(data.focus);
  const opacity = data.dimmed ? 0.22 : 1;
  const borderColor = focus || selected ? axis : "var(--color-border-strong)";
  const borderWidth = focus ? 2 : selected ? 1.5 : 1;

  if (!data.expanded) {
    return (
      <div
        data-testid="ego-chip"
        data-entity={entity}
        className="flex h-full w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg border bg-surface-raised pl-0 pr-2.5 transition-shadow duration-150 hover:shadow-md"
        style={{
          borderColor,
          borderWidth,
          boxShadow: focus ? `0 0 0 2px ${axis}` : undefined,
          opacity,
        }}
      >
        <EgoHandles />
        <div className="h-full w-[3px] shrink-0 rounded-l" style={{ backgroundColor: axis }} />
        <span
          className="grid size-[18px] shrink-0 place-items-center rounded ui-micro font-mono font-bold"
          style={{ backgroundColor: `color-mix(in srgb, ${axis} 18%, transparent)`, color: axis }}
        >
          {KIND_LETTER[entity]}
        </span>
        {entity === "task" && (
          <span
            className="size-[7px] shrink-0 rounded-full"
            style={{ backgroundColor: data.color ?? "var(--color-status-unknown)" }}
          />
        )}
        <span className="ui-meta min-w-0 flex-1 truncate text-text">{data.label}</span>
        {data.hiddenCount > 0 && (
          <span
            title="还有未铺开的邻居 —— 点开这张卡片会长出它们"
            className="ui-micro shrink-0 rounded-full bg-surface px-1.5 py-0.5 font-mono text-text-faint"
          >
            +{data.hiddenCount}
          </span>
        )}
      </div>
    );
  }

  const stop = (fn?: (arg: any) => void, arg?: any) => (event: MouseEvent) => {
    event.stopPropagation();
    fn?.(arg);
  };

  return (
    <div
      data-testid="ego-card"
      data-entity={entity}
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-surface shadow-lg"
      style={{
        borderColor,
        borderWidth,
        boxShadow: focus ? `0 0 0 2px ${axis}` : undefined,
        opacity,
      }}
    >
      <EgoHandles />
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <span
          className="grid h-[18px] shrink-0 place-items-center rounded px-1.5 ui-micro font-mono font-bold uppercase tracking-wide"
          style={{ backgroundColor: `color-mix(in srgb, ${axis} 18%, transparent)`, color: axis }}
        >
          {entity}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-1">
          {data.onRefocus && !focus && (
            <button
              onClick={stop(data.onRefocus, data.navRef)}
              title="设为画布中心(重排 ±2 跳)"
              aria-label="设为画布中心"
              className="grid size-5 place-items-center rounded text-text-muted hover:bg-surface-raised hover:text-text"
            >
              <Crosshair weight="bold" className="text-[11px]" />
            </button>
          )}
          {data.onNavigate && (
            <button
              onClick={stop(data.onNavigate, data.navRef)}
              title="打开该实体的详情页"
              aria-label="详情"
              className="grid size-5 place-items-center rounded text-text-muted hover:bg-surface-raised hover:text-accent"
            >
              <ArrowsOutSimple weight="bold" className="text-[11px]" />
            </button>
          )}
          <button
            onClick={stop(data.onCollapse, data.id)}
            title="收起(已展开的邻居保留)"
            aria-label="收起"
            className="grid size-5 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" className="text-[11px]" />
          </button>
        </span>
      </div>

      <div className="shrink-0 px-2.5 pt-2">
        <p className="ui-body font-semibold leading-snug text-text">{data.label}</p>
      </div>

      <div className="nowheel mt-1.5 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2.5 pb-2">
        {entity === "task" && <EgoTaskBody task={data.raw as TaskRow} />}
        {entity === "decision" && <EgoDecisionBody decision={data.raw as DecisionRow} />}
        {entity === "fact" && <EgoFactBody fact={data.raw as FactRef} />}
      </div>

      <div className="ui-micro flex shrink-0 items-center justify-between gap-2 border-t border-border px-2.5 py-1 font-mono text-text-faint">
        <span className="min-w-0 truncate">度 {data.degree ?? 0} · 第 {data.hop ?? 0} 跳</span>
        {data.hiddenCount > 0 && <span className="shrink-0">未铺开 {data.hiddenCount}</span>}
      </div>
    </div>
  );
}

function EgoTaskBody({ task }: { task: TaskRow }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={task.coordinationStatus} />
        <CloseoutBadge value={task.closeoutReadiness} />
      </div>
      <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
      <div className="ui-micro flex flex-wrap gap-x-3 gap-y-1 font-mono text-text-muted">
        <span>模块 {moduleDisplayLabel(task.module)}</span>
        {task.riskTier && <span>风险 {task.riskTier}</span>}
        {task.urgency && <span>紧迫 {task.urgency}</span>}
      </div>
    </>
  );
}

function EgoDecisionBody({ decision }: { decision: DecisionRow }) {
  return (
    <>
      <div className="ui-micro flex items-center gap-2 font-mono">
        <span className="rounded bg-accent px-1.5 py-0.5 text-accent-fg">{decision.state}</span>
        <span className="text-text-muted">
          风险 {decision.riskTier ?? "未知"} · 紧迫 {decision.urgency ?? "未知"}
        </span>
      </div>
      {decision.question && (
        <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5">
          <span className="ui-micro font-mono uppercase tracking-wide text-text-faint">问题</span>
          <p className="ui-meta mt-0.5 font-medium text-text">{decision.question}</p>
        </div>
      )}
      {decision.chosen?.length > 0 && (
        <div className="rounded-md border border-accent/30 bg-accent-fg/5 px-2 py-1.5">
          <span className="ui-micro font-mono uppercase tracking-wide text-accent">采纳</span>
          <div className="mt-0.5 flex flex-col gap-1">
            {decision.chosen.map((claim) => (
              <p key={claim.id} className="ui-meta text-text">{claim.text}</p>
            ))}
          </div>
        </div>
      )}
      {decision.rejected?.length > 0 && (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5">
          <span className="ui-micro font-mono uppercase tracking-wide text-danger">否决</span>
          <div className="mt-0.5 flex flex-col gap-1">
            {decision.rejected.map((claim) => (
              <div key={claim.id} className="text-text-muted">
                <p className="ui-meta">{claim.text}</p>
                {claim.whyNot && (
                  <p className="ui-micro mt-0.5 leading-snug text-text-faint">↳ {claim.whyNot}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function EgoFactBody({ fact }: { fact: FactRef }) {
  return (
    <>
      <div className="ui-micro flex items-center gap-2 font-mono">
        <span className="rounded bg-stale px-1.5 py-0.5 text-stale-fg">{fact.category}</span>
        {fact.at && <span className="text-text-muted">@ {fact.at}</span>}
      </div>
      <div className="rounded-md border border-stale/30 bg-stale/5 px-2 py-1.5">
        <span className="ui-micro font-mono uppercase tracking-wide text-stale">观察</span>
        {fact.text ? (
          <p className="ui-meta mt-0.5 font-medium leading-relaxed text-text">{fact.text}</p>
        ) : (
          <p className="ui-meta mt-0.5 italic leading-relaxed text-text-faint">
            仅有锚点,正文未投影
          </p>
        )}
      </div>
      <div className="ui-micro rounded-md border border-border bg-surface-raised px-2 py-1.5 font-mono text-text-muted">
        <div>task {fact.taskId}</div>
        <div>anchor {fact.anchor}</div>
      </div>
    </>
  );
}
