/**
 * 舰队拓扑的纯布局几何(协作页视觉重做,task_16c20131):给定容器尺寸与节点集合,
 * 决定每个节点卡的落位与画布高度,并给出连线几何。纯函数、无 DOM,可单测:
 * 契约是「边缘 1–12 个在 700px 以上排得开、以下纵向堆叠,任意组合卡片不重叠」。
 *
 * 三种形态(高→低宽度):
 * - 雷达环(宽 ≥740 且边缘 ≤4):中心居中,边缘按固定扇面角放椭圆环上;
 * - 双翼列(宽 ≥700):中心居中,边缘分列左右两翼纵向排布,画布高度随节点数扩展
 *   (任务 2879 设计稿「2 列环形网格分层排布并扩展画布高度」);
 * - 纵向堆叠(窄):中心在上、边缘下移成列,左侧留出轨道槽,连线走左槽,
 *   对应「窄屏纵向排列并保留节点、事件与权限信息」。
 */

export interface FleetLayoutNode {
  readonly nodeId: string;
  readonly role: "center" | "edge";
}

export interface FleetNodePlacement {
  /** 卡片左上角。 */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface FleetLayout {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly placement: ReadonlyMap<string, FleetNodePlacement>;
  /** 窄屏纵向形态:连线沿左槽走;其余形态:连线是中心到边缘的贝塞尔。 */
  readonly narrow: boolean;
  /** 窄屏形态下连线的轨道 x 坐标(环形形态无意义)。 */
  readonly spineX: number;
}

/** 卡片尺寸常量;节点卡是固定尺寸的玻璃卡,内容随节点角色不同。 */
export const CENTER_CARD = { width: 240, height: 112 } as const;
export const EDGE_CARD = { width: 190, height: 92 } as const;

const CANVAS_PADDING = 16;
/** 纵向堆叠的上限宽度:双翼列需要 2×(239+95+16)=700px。 */
const COLUMN_MIN_WIDTH = 700;
/** 雷达环的最小宽度:椭圆以 50px 净空包住「中心卡⊕边缘卡」矩形(见 ringLayout)。 */
const RING_MIN_WIDTH = 752;
/** 椭圆/两翼对「中心卡⊕边缘卡」矩形的净空。 */
const CLEARANCE = 50;
const CARD_GAP = 18;
/** 双翼列的列中心到画布中心的水平距离:中心半宽 120 + 间隙 24 + 边缘半宽 95。 */
const COLUMN_OFFSET = CENTER_CARD.width / 2 + 24 + EDGE_CARD.width / 2;

export function computeFleetLayout(width: number, height: number, nodes: readonly FleetLayoutNode[]): FleetLayout {
  if (width <= 0) width = 1024;
  if (height <= 0) height = 400;
  const edges = nodes.filter((node) => node.role === "edge");
  if (width >= RING_MIN_WIDTH && edges.length > 0 && edges.length <= 4) return ringLayout(width, height, edges);
  if (width >= COLUMN_MIN_WIDTH) return columnLayout(width, height, edges);
  return narrowLayout(width, edges);
}

/** 雷达环:椭圆必须把「中心卡⊕边缘卡」的矩形角包在内部((215/rx)²+(102/ry)² ≥ 1),
 * 任意扇面角都不会压到中心卡;≤4 个边缘取固定扇面角,相邻弦距 ≥ 卡宽。 */
function ringLayout(width: number, height: number, edges: readonly FleetLayoutNode[]): FleetLayout {
  const halfWidth = width / 2 - EDGE_CARD.width / 2 - CANVAS_PADDING;
  const rx = Math.min(halfWidth, Math.max(CENTER_CARD.width / 2 + EDGE_CARD.width / 2 + CLEARANCE, width * 0.26));
  const ry = Math.max(CENTER_CARD.height / 2 + EDGE_CARD.height / 2 + CLEARANCE, height * 0.3);
  const canvasHeight = Math.max(height, 2 * (ry + EDGE_CARD.height / 2 + CANVAS_PADDING + 8));
  const center = { x: width / 2, y: canvasHeight / 2 };
  const placement = new Map<string, FleetNodePlacement>([
    [
      "center",
      {
        left: center.x - CENTER_CARD.width / 2,
        top: center.y - CENTER_CARD.height / 2,
        width: CENTER_CARD.width,
        height: CENTER_CARD.height,
      },
    ],
  ]);
  const fanAngles: Record<number, readonly number[]> = {
    1: [90],
    2: [0, 180],
    3: [90, 210, 330],
    4: [45, 135, 225, 315],
  };
  for (const [index, node] of edges.entries()) {
    const angle = ((fanAngles[edges.length] ?? [])[index] ?? 90) * (Math.PI / 180);
    placement.set(node.nodeId, {
      left: center.x + rx * Math.cos(angle) - EDGE_CARD.width / 2,
      top: center.y + ry * Math.sin(angle) - EDGE_CARD.height / 2,
      width: EDGE_CARD.width,
      height: EDGE_CARD.height,
    });
  }
  return { canvasWidth: width, canvasHeight, placement, narrow: false, spineX: 0 };
}

/** 双翼列:边缘按进入顺序前一半进右翼、后一半进左翼,两翼绕中心卡纵向居中排布。 */
function columnLayout(width: number, height: number, edges: readonly FleetLayoutNode[]): FleetLayout {
  const rightCount = Math.ceil(edges.length / 2);
  const columns = [
    { offset: COLUMN_OFFSET, members: edges.slice(0, rightCount) },
    { offset: -COLUMN_OFFSET, members: edges.slice(rightCount) },
  ];
  const columnHeight = (count: number) => (count === 0 ? 0 : count * EDGE_CARD.height + (count - 1) * CARD_GAP);
  const tallest = Math.max(...columns.map((column) => columnHeight(column.members.length)));
  const canvasHeight = Math.max(height, 2 * CANVAS_PADDING + CENTER_CARD.height, tallest + 2 * CANVAS_PADDING);
  const cy = canvasHeight / 2;
  const placement = new Map<string, FleetNodePlacement>([
    [
      "center",
      {
        left: width / 2 - CENTER_CARD.width / 2,
        top: cy - CENTER_CARD.height / 2,
        width: CENTER_CARD.width,
        height: CENTER_CARD.height,
      },
    ],
  ]);
  for (const column of columns) {
    const total = columnHeight(column.members.length);
    column.members.forEach((node, index) => {
      placement.set(node.nodeId, {
        left: width / 2 + column.offset - EDGE_CARD.width / 2,
        top: cy - total / 2 + index * (EDGE_CARD.height + CARD_GAP),
        width: EDGE_CARD.width,
        height: EDGE_CARD.height,
      });
    });
  }
  return { canvasWidth: width, canvasHeight, placement, narrow: false, spineX: 0 };
}

/** 纵向堆叠:中心在上、边缘成列,左槽走轨道连线。 */
function narrowLayout(width: number, edges: readonly FleetLayoutNode[]): FleetLayout {
  const cardWidth = Math.min(width - 64, 320);
  const spineX = CANVAS_PADDING + 6;
  const cardLeft = spineX + 14;
  const centerTop = CANVAS_PADDING;
  const placement = new Map<string, FleetNodePlacement>([
    ["center", { left: cardLeft, top: centerTop, width: cardWidth, height: CENTER_CARD.height }],
  ]);
  let top = centerTop + CENTER_CARD.height + 30;
  let lastBottom = centerTop + CENTER_CARD.height;
  for (const node of edges) {
    placement.set(node.nodeId, { left: cardLeft, top, width: cardWidth, height: EDGE_CARD.height });
    lastBottom = top + EDGE_CARD.height;
    top = lastBottom + CARD_GAP;
  }
  return {
    canvasWidth: width,
    canvasHeight: lastBottom + CANVAS_PADDING,
    placement,
    narrow: true,
    spineX,
  };
}

/** 从盒子中心指向目标的射线与盒子边框的交点(连线端点收到卡片边框,避免压在卡下)。 */
export function borderPoint(
  from: FleetNodePlacement,
  toward: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : from.width / 2 / Math.abs(dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : from.height / 2 / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** 中心卡边框 → 边缘卡边框的三次贝塞尔,轻微同侧弯曲。 */
export function curvePath(from: FleetNodePlacement, to: FleetNodePlacement): string {
  const fromCenter = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  const toCenter = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
  const start = borderPoint(from, toCenter);
  const end = borderPoint(to, fromCenter);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;
  const bend = distance * 0.09;
  const nx = -uy * bend;
  const ny = ux * bend;
  const p1 = { x: start.x + ux * distance * 0.3 + nx, y: start.y + uy * distance * 0.3 + ny };
  const p2 = { x: start.x + ux * distance * 0.7 + nx, y: start.y + uy * distance * 0.7 + ny };
  return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}

/** 纵向形态的连线:中心左沿 → 左轨道 → 边缘卡左沿的 S 形贝塞尔。 */
export function spinePath(spineX: number, from: FleetNodePlacement, to: FleetNodePlacement): string {
  const fromY = from.top + from.height / 2;
  const toY = to.top + to.height / 2;
  const fromX = from.left;
  const toX = to.left;
  const midY = fromY + (toY - fromY) * 0.5;
  return `M ${fromX} ${fromY} C ${spineX - 6} ${fromY} ${spineX} ${fromY + (toY - fromY) * 0.3} ${spineX} ${midY} S ${spineX} ${toY} ${toX} ${toY}`;
}
