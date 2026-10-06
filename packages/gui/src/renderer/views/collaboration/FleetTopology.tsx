import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { t } from "../../i18n/index.tsx";
import type { FleetOverviewLink, FleetOverviewNode, FleetOverviewRead } from "../../../api/renderer-dto.ts";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import { fieldText } from "./fleet-labels.ts";
import { computeFleetLayout, curvePath, spinePath, type FleetNodePlacement } from "./fleet-topology-layout.ts";

/**
 * 舰队拓扑画布(协作页视觉重做,task_16c20131):SVG 连线层在底、绝对定位的玻璃
 * 节点卡在上。状态即光——连线与节点外圈用状态色发光(fresh=绿稳定、lag=琥珀、
 * unsynced=红且暗、无副本=灰虚线),中心是持续呼吸的能量核心(径向光晕+细环),
 * 执行中节点扫描环;流光是沿中心→边缘方向推进的虚线光束,速度随 lag 加快。
 * 动画全部走 CSS/SVG(transform/opacity/stroke-dashoffset),hover/选择只在进出时
 * 改一次容器属性,不在动画帧里触发 React 重渲染;`prefers-reduced-motion` 由全局
 * CSS 关停,静态状态色保留。
 */

/** 连线视觉状态:daemon links 可能一节点多行,取最差一行做节点级通道;无行 = absent。 */
type LinkVisualState = "fresh" | "lag" | "unsynced" | "absent";

const LINK_STATE_RANK: Readonly<Record<LinkVisualState, number>> = {
  fresh: 0,
  lag: 1,
  unsynced: 2,
  absent: 3,
};

function linkStateOf(links: readonly FleetOverviewLink[]): LinkVisualState {
  if (links.length === 0) return "absent";
  return links.reduce<LinkVisualState>(
    (worst, link) => (LINK_STATE_RANK[link.state] > LINK_STATE_RANK[worst] ? link.state : worst),
    "fresh",
  );
}

/** 流光速度映射 lag:落后越多越急促;fresh 稳定慢速。 */
function flowDurationOf(state: LinkVisualState, lagRevisions: number | null): string {
  if (state === "lag") return `${Math.max(1.2, 2.6 - 0.35 * (lagRevisions ?? 1)).toFixed(2)}s`;
  return "2.8s";
}

export function FleetTopology({
  nodes,
  links,
  center,
  centerRevision,
  selectedNode,
  onSelectNode,
  flashNodes,
}: {
  readonly nodes: readonly FleetOverviewNode[];
  readonly links: readonly FleetOverviewLink[];
  readonly center: FleetOverviewRead["center"];
  readonly centerRevision: number | null;
  readonly selectedNode: string | null;
  readonly onSelectNode: (nodeId: string) => void;
  readonly flashNodes: ReadonlySet<string>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const nodeIds = nodes.map((node) => node.nodeId).join("|");
  const layout = useMemo(
    () =>
      computeFleetLayout(
        size.width,
        size.height,
        nodes.map((node) => ({ nodeId: node.nodeId, role: node.role })),
      ),
    // nodes 内容由父级 overview 决定;布局只依赖 id 与角色序列,这里按序列重建。
    [size.width, size.height, nodeIds, nodes],
  );
  const edges = nodes.filter((node) => node.role !== "center");
  // 在飞执行数按整个舰队计(中心卡是枢纽,不是又一个普通节点)。
  const fleetExecuting = nodes.reduce(
    (total, node) =>
      total +
      (Array.isArray(node.leases)
        ? node.leases.filter((lease) => lease.phase === "held" || lease.phase === "reserving").length
        : 0),
    0,
  );
  const linksByNode = new Map<string, FleetOverviewLink[]>();
  for (const link of links) {
    const list = linksByNode.get(link.nodeId) ?? [];
    list.push(link);
    linksByNode.set(link.nodeId, list);
  }
  const dim = (nodeId: string): boolean => hoverNode !== null && hoverNode !== nodeId;
  const centerPlacement = layout.placement.get("center");
  const core = centerPlacement
    ? {
        cx: centerPlacement.left + centerPlacement.width / 2,
        cy: centerPlacement.top + centerPlacement.height / 2,
      }
    : null;
  return (
    <div
      ref={containerRef}
      data-testid="collaboration-topology"
      data-focus={hoverNode ?? undefined}
      className="fleet-canvas fleet-grid relative flex h-full w-full flex-col overflow-y-auto"
    >
      {/* 内容层按节点包围盒收紧尺寸,在(更高的)容器里垂直居中:flex 容器里的
          auto 边距吃掉富余空间,内容比容器高时边距归零、从顶部开始滚动——
          节点群永远在可视中心,不再有贴边的死空白带。 */}
      <div
        className="relative mx-auto my-auto shrink-0"
        style={{ width: layout.canvasWidth, height: layout.canvasHeight }}
      >
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0"
          width={layout.canvasWidth}
          height={layout.canvasHeight}
          viewBox={`0 0 ${layout.canvasWidth} ${layout.canvasHeight}`}
        >
          <defs>
            <radialGradient id="fleet-core-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.5" />
              <stop offset="45%" stopColor="var(--color-accent)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </radialGradient>
          </defs>
          {core === null ? null : (
            <g data-testid="collaboration-core" className="fleet-core">
              <circle className="fleet-core-halo" cx={core.cx} cy={core.cy} r={170} fill="url(#fleet-core-glow)" />
              <circle className="fleet-core-ring" cx={core.cx} cy={core.cy} r={122} />
              <circle className="fleet-core-ring fleet-core-ring--outer" cx={core.cx} cy={core.cy} r={158} />
            </g>
          )}
          {edges.map((node) => {
            const placement = layout.placement.get(node.nodeId);
            if (placement === undefined || centerPlacement === undefined) return null;
            const nodeLinks = linksByNode.get(node.nodeId) ?? [];
            const state = linkStateOf(nodeLinks);
            const path = layout.narrow
              ? spinePath(layout.spineX, centerPlacement, placement)
              : curvePath(centerPlacement, placement);
            const style: CSSProperties = {
              "--fleet-flow-duration": flowDurationOf(
                state,
                nodeLinks[0]?.lagRevisions ?? node.replica?.lagRevisions ?? null,
              ),
            } as CSSProperties;
            return (
              <g
                key={node.nodeId}
                className="fleet-link"
                data-node={node.nodeId}
                data-state={state}
                data-dim={dim(node.nodeId) ? "on" : undefined}
                style={style}
              >
                <path className="fleet-link-base" d={path} />
                {state === "fresh" || state === "lag" ? <path className="fleet-link-flow" d={path} /> : null}
                {state === "fresh" || state === "lag" ? <path className="fleet-link-particles" d={path} /> : null}
              </g>
            );
          })}
        </svg>
        {nodes.map((node) => (
          <TopologyNodeCard
            key={node.nodeId}
            node={node}
            placement={layout.placement.get(node.nodeId)}
            linkState={node.role === "center" ? null : linkStateOf(linksByNode.get(node.nodeId) ?? [])}
            lagSeconds={Math.round((node.replica?.lagMs ?? linksByNode.get(node.nodeId)?.[0]?.lagMs ?? 0) / 1000)}
            center={center}
            centerRevision={centerRevision}
            edgeCount={edges.length}
            fleetExecuting={fleetExecuting}
            selected={node.nodeId === selectedNode}
            dimmed={dim(node.nodeId)}
            flashed={flashNodes.has(node.nodeId)}
            onSelect={() => onSelectNode(node.nodeId)}
            onHover={(hovering) => setHoverNode(hovering ? node.nodeId : null)}
          />
        ))}
      </div>
    </div>
  );
}

function TopologyNodeCard({
  node,
  placement,
  linkState,
  lagSeconds,
  center,
  centerRevision,
  edgeCount,
  fleetExecuting,
  selected,
  dimmed,
  flashed,
  onSelect,
  onHover,
}: {
  readonly node: FleetOverviewNode;
  readonly placement: FleetNodePlacement | undefined;
  readonly linkState: LinkVisualState | null;
  readonly lagSeconds: number;
  readonly center: FleetOverviewRead["center"];
  readonly centerRevision: number | null;
  readonly edgeCount: number;
  readonly fleetExecuting: number;
  readonly selected: boolean;
  readonly dimmed: boolean;
  readonly flashed: boolean;
  readonly onSelect: () => void;
  readonly onHover: (hovering: boolean) => void;
}) {
  if (placement === undefined) return null;
  const leases = Array.isArray(node.leases) ? node.leases : [];
  const executing = leases.filter((lease) => lease.phase === "held" || lease.phase === "reserving").length;
  const stateClass =
    node.role === "center"
      ? "fleet-node--center"
      : linkState === null
        ? "fleet-node--absent"
        : `fleet-node--${linkState}`;
  const stateLabel =
    node.role === "center"
      ? t("collaboration.centerChannel")
      : linkState === null
        ? t("collaboration.state.absent")
        : t(`collaboration.state.${linkState}`);
  return (
    <button
      type="button"
      data-testid={`collaboration-node-${node.nodeId}`}
      data-node={node.nodeId}
      data-state={linkState ?? undefined}
      data-executing={executing > 0 ? "on" : undefined}
      data-flash={flashed ? "on" : undefined}
      data-sel={selected ? "on" : undefined}
      data-dim={dimmed ? "on" : undefined}
      aria-pressed={selected}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      style={{ left: placement.left, top: placement.top, width: placement.width, height: placement.height }}
      className={`fleet-node absolute flex flex-col gap-1.5 px-4 py-3 text-left ${stateClass}`}
    >
      <span className="flex items-center justify-between gap-2">
        {/* 标题只留节点名:daemonId 是无标签裸值,短 id(如夹具的 "g")读作孤立
            碎片;daemon 身份在详情抽屉里有完整带标签的展示(daemonId · version @ sha)。 */}
        <span className="min-w-0 truncate font-semibold ui-body">
          {node.role === "center" ? t("collaboration.centerNode") : node.nodeId}
        </span>
        <StatusTag
          tone={executing > 0 ? "active" : "neutral"}
          label={executing > 0 ? t("collaboration.nodeExecuting", { count: executing }) : t("collaboration.nodeIdle")}
        />
      </span>
      {node.role === "center" ? (
        // 中心卡是能量核心的读数板:枢纽三数(修订/边缘/在飞)放大居中占据卡身,
        // hash 带「head」标签截短,完整值进 title。
        <span
          data-testid="collaboration-core-metrics"
          className="fleet-core-metrics flex flex-1 items-center justify-between gap-2 font-mono"
        >
          <span className="shrink-0" data-testid="collaboration-core-rev">
            rev {centerRevision ?? "—"}
          </span>
          <span className="shrink-0">{t("collaboration.centerEdges", { count: edgeCount })}</span>
          <span className="shrink-0">{t("collaboration.centerInFlight", { count: fleetExecuting })}</span>
        </span>
      ) : (
        <span className="flex min-w-0 items-baseline justify-between gap-2 font-mono text-text-muted fleet-metric">
          <span className="truncate" data-testid={`collaboration-node-owner-${node.nodeId}`}>
            {fieldText(node.owner)}
          </span>
          <span className="shrink-0">
            cut {node.replica === null ? "—" : `${node.replica.ackRevision ?? "—"}/${node.replica.centerRevision}`}
          </span>
        </span>
      )}
      <span className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-1.5 ui-micro text-text-faint">
        <span className="flex min-w-0 items-center gap-1.5">
          <i aria-hidden="true" className="fleet-state-dot" />
          <span className="truncate">{stateLabel}</span>
        </span>
        {node.role === "center" ? (
          <span
            className="shrink-0 truncate font-mono"
            data-testid="collaboration-core-head"
            title={center.commitSha ?? undefined}
          >
            {t("collaboration.centerHead")} {center.commitSha === null ? "unknown" : center.commitSha.slice(0, 8)}
          </span>
        ) : linkState === "lag" && lagSeconds > 0 ? (
          <span className="shrink-0 font-mono fleet-metric-lag">{lagSeconds}s</span>
        ) : null}
      </span>
    </button>
  );
}
