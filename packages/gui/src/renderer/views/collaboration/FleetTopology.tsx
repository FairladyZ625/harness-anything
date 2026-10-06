import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { t } from "../../i18n/index.tsx";
import type { FleetOverviewLink, FleetOverviewNode, FleetOverviewRead } from "../../../api/renderer-dto.ts";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import { fieldText } from "./fleet-labels.ts";
import { computeFleetLayout, curvePath, spinePath, type FleetNodePlacement } from "./fleet-topology-layout.ts";

/**
 * 舰队拓扑画布(协作页视觉重做,task_16c20131):SVG 连线层在底、绝对定位的玻璃
 * 节点卡在上。状态即光——连线与节点外圈用状态色发光(fresh=绿稳定、lag=琥珀、
 * unsynced=红且暗、无副本=灰虚线),中心卡低频呼吸,执行中节点扫描环;流光是沿
 * 中心→边缘方向推进的虚线动画,速度随 lag 加快。动画全部走 CSS/SVG(transform/
 * opacity/stroke-dashoffset),hover/选择只在进出时改一次容器属性,不在动画帧里
 * 触发 React 重渲染;`prefers-reduced-motion` 由全局 CSS 关停,静态状态色保留。
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
  if (state === "lag") return `${Math.max(1.4, 3.2 - 0.45 * (lagRevisions ?? 1)).toFixed(2)}s`;
  return "3.4s";
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
  const linksByNode = new Map<string, FleetOverviewLink[]>();
  for (const link of links) {
    const list = linksByNode.get(link.nodeId) ?? [];
    list.push(link);
    linksByNode.set(link.nodeId, list);
  }
  const dim = (nodeId: string): boolean => hoverNode !== null && hoverNode !== nodeId;
  return (
    <div
      ref={containerRef}
      data-testid="collaboration-topology"
      data-focus={hoverNode ?? undefined}
      className="fleet-canvas fleet-grid relative h-full w-full overflow-y-auto"
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0"
        width={layout.canvasWidth}
        height={layout.canvasHeight}
        viewBox={`0 0 ${layout.canvasWidth} ${layout.canvasHeight}`}
      >
        {edges.map((node) => {
          const placement = layout.placement.get(node.nodeId);
          const centerPlacement = layout.placement.get("center");
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
          selected={node.nodeId === selectedNode}
          dimmed={dim(node.nodeId)}
          flashed={flashNodes.has(node.nodeId)}
          onSelect={() => onSelectNode(node.nodeId)}
          onHover={(hovering) => setHoverNode(hovering ? node.nodeId : null)}
        />
      ))}
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
      className={`fleet-node absolute flex flex-col gap-1 px-3 py-2 text-left ${stateClass}`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold ui-body">
          {node.role === "center" ? t("collaboration.centerNode") : node.nodeId}
        </span>
        <StatusTag
          tone={executing > 0 ? "active" : "neutral"}
          label={executing > 0 ? t("collaboration.nodeExecuting", { count: executing }) : t("collaboration.nodeIdle")}
        />
      </span>
      <span className="flex min-w-0 items-baseline justify-between gap-2 font-mono ui-micro text-text-muted">
        {node.role === "center" ? (
          <>
            <span className="truncate">{center.daemonId}</span>
            <span className="truncate">{center.commitSha ?? "unknown"}</span>
          </>
        ) : (
          <>
            <span className="truncate" data-testid={`collaboration-node-owner-${node.nodeId}`}>
              {fieldText(node.owner)}
            </span>
            <span className="shrink-0">
              cut {node.replica === null ? "—" : `${node.replica.ackRevision ?? "—"}/${node.replica.centerRevision}`}
            </span>
          </>
        )}
      </span>
      <span className="flex items-center justify-between gap-2 border-t border-border pt-1 ui-micro text-text-faint">
        <span className="truncate">
          {node.role === "center"
            ? t("collaboration.centerChannel")
            : linkState === null
              ? t("collaboration.state.absent")
              : t(`collaboration.state.${linkState}`)}
        </span>
        {node.role === "center" ? (
          <span className="shrink-0 font-mono">rev {centerRevision ?? "—"}</span>
        ) : linkState === "lag" && lagSeconds > 0 ? (
          <span className="shrink-0 font-mono">{lagSeconds}s</span>
        ) : null}
      </span>
    </button>
  );
}
