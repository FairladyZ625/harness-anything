import type { MouseEvent } from "react";
import { Handle, Position, NodeResizer } from "@xyflow/react";
import { X, Crosshair, ArrowsOutSimple } from "@phosphor-icons/react";
import {
  StatusBadge,
  CloseoutBadge,
  EngineBadge,
  FreshnessTag,
} from "../../components/badges";
import { isExternal } from "../../model/types";
import type { TaskRow, DecisionRow, FactRef } from "../../model/types";
import { t } from "../../i18n/index.tsx";

/**
 * 无限画布 ego 节点(dec_01KXBGJQFQARSZHHQW1WADFDNC)。
 * 一个组件两态:
 *   chip — 紧凑一条(默认),点一下就地展开成卡片并长出邻居。
 *   card — 详情卡片(镜像 GraphDrawer 清晰度:徽章 / 轴色分区 / 大字 / 固定高内滚)。
 *
 * 交互回调由 GraphView 在 setNodes 时注入 data:
 *   data.onCollapse(id)  收起卡片(保留已展开邻居)
 *   data.onRefocus(id)   设为画布中心(重排 ±2 跳)
 *   data.onNavigate(ref) 跳转该实体专属详情页(task→详情 / decision→池 / fact→分诊)
 * chip 的"点击展开"走 ReactFlow onNodeClick,不在此处理。
 */

type Entity = "task" | "decision" | "fact";

const AXIS_VAR: Record<Entity, string> = {
  task: "var(--color-axis-execution)",
  decision: "var(--color-axis-authority)",
  fact: "var(--color-axis-evidence)",
};
const KD_LETTER: Record<Entity, string> = { task: "T", decision: "D", fact: "F" };

// NodeResizer 下限:卡片不能拖到比 chip 还小(否则内容无法装下)。
const CARD_MIN_W = 240;
const CARD_MIN_H = 100;

const HANDLE_CLS =
  "!h-2 !w-2 !min-w-2 !min-h-2 !border-0 !bg-[var(--color-border-strong)]";

function Handles() {
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

  if (!data.expanded) {
    // ── chip ──
    return (
      <div
        className="flex h-full w-full items-center gap-2 overflow-hidden rounded-lg border bg-surface-raised pl-0 pr-2.5 cursor-pointer transition-shadow duration-150 hover:shadow-md"
        style={{
          borderColor: focus ? axis : selected ? axis : "var(--color-border-strong)",
          borderWidth: focus ? 2 : 1,
          boxShadow: focus ? `0 0 0 2px ${axis}` : undefined,
        }}
      >
        <Handles />
        <div className="h-full w-[3px] shrink-0 rounded-l" style={{ backgroundColor: axis }} />
        <span
          className="grid size-[18px] shrink-0 place-items-center rounded font-mono text-[10px] font-bold"
          style={{ backgroundColor: `color-mix(in srgb, ${axis} 18%, transparent)`, color: axis }}
        >
          {KD_LETTER[entity]}
        </span>
        {entity === "task" && (
          <span
            className="size-[7px] shrink-0 rounded-full"
            style={{ backgroundColor: data.color ?? "var(--color-status-planned)" }}
          />
        )}
        <span className="ui-meta min-w-0 flex-1 truncate text-text">{data.label}</span>
        {data.hiddenCount > 0 && (
          <span className="shrink-0 rounded-full bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-faint">
            +{data.hiddenCount}
          </span>
        )}
      </div>
    );
  }

  // ── card ──
  const stop = (fn?: (arg: any) => void, arg?: any) => (e: MouseEvent) => {
    e.stopPropagation();
    fn?.(arg);
  };

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-surface shadow-lg"
      style={{
        borderColor: focus ? axis : "var(--color-border-strong)",
        borderWidth: focus ? 2 : 1,
        boxShadow: focus ? `0 0 0 2px ${axis}, 0 8px 28px rgba(0,0,0,0.28)` : undefined,
      }}
    >
      {/* D4:NodeResizer —— 用户「手动拖放大缩小组件」的入口。只在展开卡片上显示。
          onResize 把每个 drag tick 的中间尺寸同步到 sizeOverrides,使布局器立即按新尺寸
          重排——可见的实时缩放(RF 受控模式下 NodeResizer 的内部 dimensionChange 不会经
          onNodesChange 回流到我们的 nodes 状态,所以必须由 EgoNode 主动上报)。
          onResizeEnd 同样上报一次,确保最终尺寸写入。
          minWidth/minHeight 防止拖到 0;nodesDraggable={false} 不影响 resize(RF 独立处理)。*/}
      <NodeResizer
        isVisible={true}
        minWidth={CARD_MIN_W}
        minHeight={CARD_MIN_H}
        onResize={(_evt, params) => {
          if (data.onResizeEnd) {
            data.onResizeEnd(data.id, params.width, params.height);
          }
        }}
        onResizeEnd={(_evt, params) => {
          if (data.onResizeEnd) {
            data.onResizeEnd(data.id, params.width, params.height);
          }
        }}
        handleClassName="!border-[var(--color-border-strong)] !bg-surface-raised"
      />
      <Handles />
      {/* header */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <span
          className="grid h-[18px] shrink-0 place-items-center rounded px-1.5 font-mono text-[9px] font-bold uppercase tracking-wide"
          style={{ backgroundColor: `color-mix(in srgb, ${axis} 18%, transparent)`, color: axis }}
        >
          {entity}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {data.onRefocus && !focus && (
            <button
              onClick={stop(data.onRefocus, data.id ?? undefined)}
              title={t("graph.egoNode.setCenterCanvas2JumpsBeforeAfter")}
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted hover:border-[var(--color-border-strong)] hover:text-text"
            >
              <Crosshair weight="bold" className="text-[10px]" />
              {t("graph.egoNode.setAsCenter")}</button>
          )}
          {data.onNavigate && (
            <button
              onClick={stop(data.onNavigate, data.navRef)}
              title={t("graph.egoNode.openExclusiveDetailsPageTaskDetailsDecision")}
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted hover:border-accent hover:text-accent"
            >
              <ArrowsOutSimple weight="bold" className="text-[10px]" />
              {t("graph.egoNode.details")}</button>
          )}
          <button
            onClick={stop(data.onCollapse, data.id ?? undefined)}
            title={t("graph.egoNode.collapseKeepExpandedNeighbors")}
            className="grid size-5 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" className="text-[11px]" />
          </button>
        </span>
      </div>

      {/* title */}
      <div className="shrink-0 px-2.5 pt-2">
        <p className="ui-body font-semibold leading-snug text-text">{cardTitle(entity, data)}</p>
      </div>

      {/* scrollable body */}
      {/* D4:nowheel 类让 React Flow 的 d3-zoom filter 把滚轮让给此容器(否则滚轮被拿去缩放画布,
          overflow-y-auto 形同虚设)。noWheelClassName 默认就是 "nowheel",无需在 ReactFlow 上配置。
          B1:始终挂 overflow-y-auto —— 内容适配时 Tailwind 不会渲染滚动条(视觉等价 overflow-hidden),
          一旦真实内容超过节点盒(高估或被用户拖小),滚动条自然出现。这避免了 estimateCardHeight
          的启发式低估导致内容被 overflow-hidden 静默剪裁("组件大了,但是滚动不了了")。
          min-h-0 + flex-1 让 flex 子项在父盒固定高时正确收缩,从而能产生 overflow。*/}
      <div className="nowheel mt-1.5 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2.5 pb-2">
        {entity === "task" && <TaskBody t={data.raw as TaskRow} />}
        {entity === "decision" && <DecisionBody d={data.raw as DecisionRow} />}
        {entity === "fact" && <FactBody f={data.raw as FactRef} />}
      </div>

      {/* footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-border px-2.5 py-1 font-mono text-[10px] text-text-faint">
        <span>{t("graph.egoNode.degreeHop", { degree: data.degree ?? 0, hop: data.hop ?? 0 })}</span>
        {data.hiddenCount > 0 && <span>{t("graph.egoNode.hiddenNotExpanded", { count: data.hiddenCount })}</span>}
      </div>
    </div>
  );
}

function cardTitle(entity: Entity, data: any): string {
  if (entity === "fact") return t("graph.egoNode.evidenceValue", { value: (data.raw as FactRef).text?.slice(0, 60) ?? "" });
  return data.label;
}

function TaskBody({ t: task }: { t: TaskRow }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={task.coordinationStatus} />
        <CloseoutBadge value={task.closeoutReadiness} />
        <EngineBadge engine={task.engine} locked={isExternal(task)} />
      </div>
      <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-text-muted">
        <span>{t("graph.egoNode.moduleValue", { module: task.module })}</span>
        {task.riskTier && <span>{t("graph.egoNode.riskValue", { risk: task.riskTier })}</span>}
        {task.urgency && <span>{t("graph.egoNode.urgencyValue", { urgency: task.urgency })}</span>}
      </div>
    </>
  );
}

function DecisionBody({ d }: { d: DecisionRow }) {
  return (
    <>
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="rounded bg-accent px-1.5 py-0.5 text-accent-fg">{d.state}</span>
        <span className="text-text-muted">
          {t("graph.egoNode.riskUrgency", { risk: d.riskTier ?? t("graph.egoNode.unknown"), urgency: d.urgency ?? t("graph.egoNode.unknown") })}
        </span>
      </div>
      {d.question && (
        <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">{t("graph.egoNode.question")}</span>
          <p className="ui-body mt-0.5 font-medium text-text">{d.question}</p>
        </div>
      )}
      {d.chosen && d.chosen.length > 0 && (
        <div className="rounded-md border border-accent/30 bg-accent-fg/5 px-2 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-accent">{t("graph.egoNode.chosen")}</span>
          <div className="mt-0.5 flex flex-col gap-1">
            {d.chosen.map((c) => (
              <p key={c.id} className="ui-body text-text">{c.text}</p>
            ))}
          </div>
        </div>
      )}
      {/* rejected:types.ts:145 标注 ⚠ 必填非空、每条带 whyNot。决策中否决比选择更重要,
          缺画 = 让审查者只看 chosen 半张图。danger 配色与 chosen 对位,强调对立。 */}
      {d.rejected && d.rejected.length > 0 && (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-danger">{t("graph.egoNode.rejected")}</span>
          <div className="mt-0.5 flex flex-col gap-1">
            {d.rejected.map((c) => (
              <div key={c.id} className="text-text-muted">
                <p className="ui-body">{c.text}</p>
                {c.whyNot && (
                  <p className="mt-0.5 text-[11px] leading-snug text-text-faint">↳ {c.whyNot}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {d.claims && d.claims.length > 0 && (
        <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">{t("graph.egoNode.claims")}</span>
          <ul className="ui-body mt-0.5 list-inside list-disc text-text-muted">
            {d.claims.map((c) => (
              <li key={c.id}>{c.text}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function FactBody({ f }: { f: FactRef }) {
  return (
    <>
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="rounded bg-stale px-1.5 py-0.5 text-stale-fg">{f.category}</span>
        <span className="text-text-muted">@ {f.at}</span>
      </div>
      <div className="rounded-md border border-stale/30 bg-stale/5 px-2 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-stale">{t("graph.egoNode.factObservation")}</span>
        <p className="ui-body mt-0.5 font-medium leading-relaxed text-text">{f.text}</p>
      </div>
      <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5 font-mono text-[11px] text-text-muted">
        <div>{t("graph.egoNode.taskValue", { taskId: f.taskId })}</div>
        <div>{t("graph.egoNode.anchorValue", { anchor: f.anchor })}</div>
      </div>
    </>
  );
}
