import type { MouseEvent } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { PushPin, X, Crosshair, ArrowsOutSimple } from "@phosphor-icons/react";
import type { TaskRow, DecisionRow, FactRef } from "../../model/types";
import type { AgentNodeRow, ScheduleNodeRow } from "../runtimeEntities.ts";
import { entityKindVisual } from "../kindVisuals";
import type { EgoFlowNode } from "../egoCanvas.ts";
import {
  EgoTaskSummaryBody,
  EgoDecisionSummaryBody,
  EgoFactSummaryBody,
  EgoAgentSummaryBody,
  EgoScheduleSummaryBody,
} from "../entityCardBodies.tsx";
import { t } from "../../i18n/index.tsx";

/**
 * 无限画布 ego 节点(dec_01KXBGJQFQARSZHHQW1WADFDNC)。图场景 2026-10-02 恢复
 * 原位展开(task_baca8e2b3e32c288fbd14b71f0,业主批准):一个组件两态 ——
 *   chip — 紧凑一条(默认),单击就地展开成卡片并长出下一环邻居;再点卡片收起
 *         (已展开邻居保留)。
 *   card — 原位阅读卡片:实体摘要 + 「设为焦点/详情/收起」动作,内容超出时内部
 *         滚动(不静默剪裁)。完整详情走独立实体页(onNavigate → onNavigateEntity),
 *         不在节点里另造面板。
 *
 * 交互回调由宿主经 data 注入(onCollapse / onRefocus / onNavigate / onSetPin);
 * 卡片上的按钮 click 与 dblclick 都 stopPropagation —— 不触发节点的单击展开/收起
 * 与双击重聚焦(操作按钮 ≠ 节点手势)。五类实体共用这一个组件
 * (task/decision/fact/agent/schedule),不另立第二套节点组件。
 */

const HANDLE_CLS = "!h-2 !w-2 !min-w-2 !min-h-2 !border-0 !bg-[var(--color-border-strong)]";

function EgoHandles() {
  return (
    <>
      <Handle type="target" position={Position.Left} className={HANDLE_CLS} />
      <Handle type="source" position={Position.Right} className={HANDLE_CLS} />
    </>
  );
}

/**
 * 卡片内的链接不拦冒泡,由卡片在捕获期替它拦,避免点链接同时触发展开/收起与双击重聚焦。
 * 按钮不在这里拦:捕获期 stopPropagation 会让事件到不了按钮自己的 onClick(按钮在
 * 自身 onClick/onDoubleClick 里已各自 stopPropagation)。
 */
function stopEmbeddedAction(event: MouseEvent) {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("a") && !event.target.closest("button")) event.stopPropagation();
}

export function EgoNode({ data, selected }: NodeProps<EgoFlowNode>) {
  const entity = data.entity;
  const visual = entityKindVisual(entity);
  const axis = visual.axisVar;
  const focus = Boolean(data.focus);
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
        }}
      >
        <EgoHandles />
        <div className="h-full w-[3px] shrink-0 rounded-l" style={{ backgroundColor: axis }} />
        <span
          className="grid size-[18px] shrink-0 place-items-center rounded ui-micro font-mono font-bold"
          style={{ backgroundColor: `color-mix(in srgb, ${axis} 18%, transparent)`, color: axis }}
        >
          {visual.letter}
        </span>
        {entity === "task" && (
          <span
            className="size-[7px] shrink-0 rounded-full"
            style={{ backgroundColor: data.color ?? "var(--color-status-unknown)" }}
          />
        )}
        {entity === "task" &&
          (data.onSetPin ? (
            <button
              type="button"
              data-testid={`ego-pin-toggle-${(data.raw as TaskRow).taskId}`}
              onClick={(event) => {
                event.stopPropagation();
                const task = data.raw as TaskRow;
                data.onSetPin?.(task, task.pinned !== true);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              aria-pressed={(data.raw as TaskRow).pinned === true}
              title={(data.raw as TaskRow).pinned === true ? "解除 pin" : "Pin(今天当前在做)"}
              className={`grid size-5 shrink-0 place-items-center rounded hover:bg-surface ${
                (data.raw as TaskRow).pinned === true ? "text-accent" : "text-text-faint hover:text-text"
              }`}
            >
              <PushPin weight={(data.raw as TaskRow).pinned === true ? "fill" : "bold"} />
            </button>
          ) : (data.raw as TaskRow).pinned === true ? (
            <span title="台账 pinned(在任务列表钉住)——恒在重点集,密度分层不折叠" className="flex shrink-0 items-center">
              <PushPin weight="fill" className="ui-micro text-accent" />
            </span>
          ) : null)}
        <span className="ui-meta min-w-0 flex-1 truncate text-text">{data.label}</span>
        {data.hiddenCount > 0 && (
          <span
            title={t("graph.egoCard.hiddenHint", { count: data.hiddenCount })}
            className="ui-micro shrink-0 rounded-full bg-surface px-1.5 py-0.5 font-mono text-text-faint"
          >
            +{data.hiddenCount}
          </span>
        )}
      </div>
    );
  }

  const stop = (fn?: (arg: string) => void, arg?: string) => (event: MouseEvent) => {
    event.stopPropagation();
    if (fn && arg !== undefined) fn(arg);
  };

  return (
    <div
      data-testid="ego-card"
      data-entity={entity}
      onClickCapture={stopEmbeddedAction}
      onDoubleClickCapture={stopEmbeddedAction}
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-surface shadow-lg"
      style={{
        borderColor,
        borderWidth,
        boxShadow: focus ? `0 0 0 2px ${axis}` : undefined,
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
          {entity === "task" && data.onSetPin && (
            <button
              type="button"
              data-testid={`ego-pin-toggle-${(data.raw as TaskRow).taskId}`}
              onClick={(event) => {
                event.stopPropagation();
                const task = data.raw as TaskRow;
                data.onSetPin?.(task, task.pinned !== true);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              aria-pressed={(data.raw as TaskRow).pinned === true}
              title={(data.raw as TaskRow).pinned === true ? "解除 pin" : "Pin(今天当前在做)"}
              className={`grid size-5 place-items-center rounded hover:bg-surface-raised ${
                (data.raw as TaskRow).pinned === true ? "text-accent" : "text-text-faint hover:text-text"
              }`}
            >
              <PushPin weight={(data.raw as TaskRow).pinned === true ? "fill" : "bold"} className="ui-micro" />
            </button>
          )}
          {data.onRefocus && !focus && (
            <button
              data-testid="ego-card-refocus"
              onClick={stop(data.onRefocus, data.navRef)}
              onDoubleClick={(event) => event.stopPropagation()}
              title={data.refocusTitle ?? t("graph.egoCard.setFocus")}
              aria-label={data.refocusTitle ?? t("graph.egoCard.setFocus")}
              className="grid size-5 place-items-center rounded text-text-muted hover:bg-surface-raised hover:text-text"
            >
              <Crosshair weight="bold" className="ui-micro" />
            </button>
          )}
          {data.onNavigate && (
            <button
              data-testid="ego-card-open"
              onClick={stop(data.onNavigate, data.navRef)}
              onDoubleClick={(event) => event.stopPropagation()}
              title={t("graph.egoCard.openDetail")}
              aria-label={t("graph.egoCard.openDetail")}
              className="grid size-5 place-items-center rounded text-text-muted hover:bg-surface-raised hover:text-accent"
            >
              <ArrowsOutSimple weight="bold" className="ui-micro" />
            </button>
          )}
          <button
            data-testid="ego-card-collapse"
            onClick={stop(data.onCollapse, data.id)}
            onDoubleClick={(event) => event.stopPropagation()}
            title={t("graph.egoCard.collapse")}
            aria-label={t("graph.egoCard.collapse")}
            className="grid size-5 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" className="ui-micro" />
          </button>
        </span>
      </div>

      <div className="shrink-0 px-2.5 pt-2">
        <p className="ui-body font-semibold leading-snug text-text">{data.label}</p>
        {entity === "task" && (data.raw as TaskRow).pinned === true && (
          <p className="ui-micro mt-0.5 flex items-center gap-1 font-mono text-text-faint">
            <PushPin weight="fill" className="ui-micro text-accent" />
            台账 pinned · 恒在重点集
          </p>
        )}
      </div>

      <div className="nowheel mt-1.5 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2.5 pb-2">
        {entity === "task" && <EgoTaskSummaryBody task={data.raw as TaskRow} />}
        {entity === "decision" && <EgoDecisionSummaryBody decision={data.raw as DecisionRow} />}
        {entity === "fact" && (
          <EgoFactSummaryBody
            fact={data.raw as FactRef}
            onNavigate={data.onNavigate as ((ref: string) => void) | undefined}
          />
        )}
        {entity === "agent" && <EgoAgentSummaryBody agent={data.raw as AgentNodeRow} />}
        {entity === "schedule" && <EgoScheduleSummaryBody schedule={data.raw as ScheduleNodeRow} />}
        {entity !== "task" &&
          entity !== "decision" &&
          entity !== "fact" &&
          entity !== "agent" &&
          entity !== "schedule" && (
            <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5 ui-micro text-text-muted">
              {entity}
              {t("graph.graphDrawer.node")}
            </div>
          )}
      </div>

      <div className="ui-micro flex shrink-0 items-center justify-between gap-2 border-t border-border px-2.5 py-1 font-mono text-text-faint">
        <span className="min-w-0 truncate">
          {t("graph.graphDrawer.nodeMeta", { degree: data.degree ?? 0, hop: data.hop ?? 0 })}
        </span>
        {data.hiddenCount > 0 && (
          <span className="shrink-0" title={t("graph.egoCard.hiddenHint", { count: data.hiddenCount })}>
            {t("graph.graphDrawer.hiddenNeighbors", { count: data.hiddenCount })}
          </span>
        )}
      </div>
    </div>
  );
}
