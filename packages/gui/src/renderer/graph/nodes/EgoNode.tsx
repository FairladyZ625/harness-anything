import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { PushPin } from "@phosphor-icons/react";
import type { TaskRow } from "../../model/types";
import { entityKindVisual } from "../kindVisuals";
import type { EgoFlowNode } from "../egoCanvas.ts";

/**
 * 无限画布 ego 节点(dec_01KXBGJQFQARSZHHQW1WADFDNC)。视觉规范 §5.2(业主
 * 2026-10-01)后只有一种形态:紧凑 chip —— 单击 = 选中(描边高亮,邻居加亮) +
 * 抽屉显示摘要;双击 = 以它为中心重排邻域。节点不再放大、不在节点上铺内容,
 * 原卡片内容已并入 GraphDrawer(内容对等见 ego-neighborhood.vitest.ts)。
 *
 * pin 写回调由宿主经 data:onSetPin 注入;选中态由 ReactFlow 的 selected prop 驱动。
 * 五类实体共用这一个组件(task/decision/fact/agent/schedule),不另立第二套节点组件。
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

export function EgoNode({ data, selected }: NodeProps<EgoFlowNode>) {
  const entity = data.entity;
  const visual = entityKindVisual(entity);
  const axis = visual.axisVar;
  const focus = Boolean(data.focus);
  const opacity = data.dimmed ? 0.22 : 1;
  const borderColor = focus || selected ? axis : "var(--color-border-strong)";
  const borderWidth = focus ? 2 : selected ? 1.5 : 1;

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
          title="还有未铺开的邻居 —— 双击以它为中心重排即可展开"
          className="ui-micro shrink-0 rounded-full bg-surface px-1.5 py-0.5 font-mono text-text-faint"
        >
          +{data.hiddenCount}
        </span>
      )}
    </div>
  );
}
