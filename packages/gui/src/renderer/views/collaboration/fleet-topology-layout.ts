/**
 * 舰队拓扑的纯布局几何(协作页视觉重做,task_16c20131):给定容器尺寸与节点集合,
 * 决定每个节点卡的落位与画布高度,并给出连线几何。纯函数、无 DOM,可单测。
 *
 * 第 3 轮(CEO 续跑)把「连线可见长度」升为一等契约:中心与边缘卡边框之间的
 * 可视连线至少 LINK_MIN 像素——流光/粒子要有能被看见的轨道。布局按宽度分四形,
 * 每一形都按构造满足契约:
 * - 雷达环(边缘 ≤4,宽度解得开):侧锚把边缘卡推到面板左右沿,纵向偏移取
 *   连线 ≥ LINK_MIN 的最小解;解不出(宽度不够或纵向需求超过容器)退到队列树;
 * - 双翼列(边缘 >4 且宽度解得开):两翼贴面板左右沿纵向排布,与中心卡的横向
 *   净空 ≥ LINK_MIN,画布高度随节点数扩展(任务 2879 设计稿);
 * - 队列树(中带宽):中心卡在上方,边缘两列排在下方,连线全部斜向;
 * - 纵向堆叠(窄):中心在上、边缘下移成列,左侧留轨道槽,连线走左槽。
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
  /** 窄屏形态下连线的轨道 x 坐标(其余形态无意义)。 */
  readonly spineX: number;
}

/** 卡片尺寸常量;节点卡是固定尺寸的玻璃卡,内容随节点角色不同。第 2 轮放大:
 * 节点是画布主角,cut/lag 数字要在扫视距离可读,卡片小=信息弱。 */
export const CENTER_CARD = { width: 300, height: 148 } as const;
export const EDGE_CARD = { width: 252, height: 124 } as const;

/** 中心卡与边缘卡边框之间连线可见长度的验收带(CEO 第 3 轮:至少 120–200px)。
 * 下限留出渲染抗锯齿余量;上限防宽屏把连线拉成失去张力的长弧。所有形态按构造
 * 落在带内,单测逐宽度档断言。 */
export const LINK_MIN = 130;
export const LINK_MAX = 200;

const CANVAS_PADDING = 20;
const CARD_GAP = 20;
/** 卡片矩形净空:两轴让开时的最小间隙(不相切、留可读缝)。 */
const CARD_CLEARANCE = 8;
/** 队列树:中心卡底沿到第一行边缘卡顶沿的垂直净空(斜向连线由此 ≥ LINK_MIN)。 */
const TREE_GAP = LINK_MIN + 2;
/** 队列树两列的列心到画布中心的最大水平距离(窄树往里收,宽树不超过此值)。 */
const TREE_COLUMN_SPREAD = 330;
/** 队列树的最小宽度:两列边缘卡各带画布 padding,再留列间隙。宽度低于此值只剩
 * 纵向堆叠一形(画布高随节点数线性增长,滚动不可避免)。 */
export const TREE_MIN_WIDTH = 2 * (EDGE_CARD.width + CANVAS_PADDING) + 24;

export function computeFleetLayout(width: number, height: number, nodes: readonly FleetLayoutNode[]): FleetLayout {
  if (width <= 0) width = 1024;
  if (height <= 0) height = 420;
  const edges = nodes.filter((node) => node.role === "edge");
  if (edges.length <= 4) {
    const ring = ringLayout(width, height, edges);
    if (ring !== null) return ring;
  } else {
    const wings = columnLayout(width, height, edges);
    if (wings !== null) return wings;
  }
  if (width >= TREE_MIN_WIDTH) return treeLayout(width, edges);
  return narrowLayout(width, edges);
}

/** 单位方向 (ux, uy) 下,中心卡与边缘卡沿该方向的边框出射距离之和。 */
function ringExits(unitX: number, unitY: number): number {
  return (
    exitDistance(CENTER_CARD.width / 2, CENTER_CARD.height / 2, unitX, unitY) +
    exitDistance(EDGE_CARD.width / 2, EDGE_CARD.height / 2, unitX, unitY)
  );
}

/** 雷达环:边缘卡放在中心卡周围的固定锚位上——侧锚把卡心推到面板沿
 * (X = 半宽,封顶 LINK_MAX 对应的横向距离),纵向偏移取「连线 ≥ LINK_MIN」的
 * 最小解再抬一点(错开中心行,队形有层次);下锚在正下方,距离恰 LINK_MIN。
 * 构造即契约:每条连线长度 ∈ [LINK_MIN, LINK_MAX];X 小到侧卡与中心卡净空
 * 不足,或环的纵向需求超过容器(内容层比容器高会顶对齐+滚动,底部节点被
 * 折叠线裁掉——第 4 轮:1120 窗的 888 画布 × 3 边缘需求 659 > 容器 625),
 * 都返回 null 退到队列树(树按构造更矮)。落位后仍用 borderLinkLength 复验。 */
function ringLayout(width: number, height: number, edges: readonly FleetLayoutNode[]): FleetLayout | null {
  const sideFloor = CENTER_CARD.width / 2 + EDGE_CARD.width / 2 + CARD_CLEARANCE;
  const sideCeiling = Math.min(
    width / 2 - EDGE_CARD.width / 2 - CANVAS_PADDING - CARD_CLEARANCE,
    LINK_MAX + CENTER_CARD.width / 2 + EDGE_CARD.width / 2,
  );
  if (sideCeiling < sideFloor) return null;
  /** 二分求侧锚的最小纵向偏移:固定 X 下 link(y) 随 y 单调增(hypot 增、卡片
   * 沿线出射距离减)。 */
  const minimalSideY = (x: number) => {
    let low = 0;
    let high = 4 * x;
    for (let round = 0; round < 24; round += 1) {
      const mid = (low + high) / 2;
      if (sideLinkLength(x, mid) < LINK_MIN) low = mid;
      else high = mid;
    }
    return high;
  };
  let sideX = sideCeiling;
  const lift = Math.max(minimalSideY(sideX), EDGE_CARD.height / 2 + CARD_CLEARANCE);
  // lift 抬起后连线比纯侧向长,若越 LINK_MAX 再把 X 收回(固定 lift 下 link
  // 随 X 单调增,继续二分);收缩只会让连线更短,不再触碰下限。
  if (sideLinkLength(sideX, lift) > LINK_MAX) {
    let low = sideFloor;
    let high = sideX;
    for (let round = 0; round < 24; round += 1) {
      const mid = (low + high) / 2;
      if (sideLinkLength(mid, lift) > LINK_MAX) high = mid;
      else low = mid;
    }
    sideX = high;
  }
  // 纯侧向(count 2 的水平锚)连线 = sideX − 276,不足 LINK_MIN 时环解不开。
  if (edges.length === 2 && sideX - (CENTER_CARD.width / 2 + EDGE_CARD.width / 2) < LINK_MIN) return null;
  const belowY = LINK_MIN + CENTER_CARD.height / 2 + EDGE_CARD.height / 2;
  const anchors: ReadonlyArray<readonly [number, number]> =
    edges.length === 1
      ? [[0, belowY]]
      : edges.length === 2
        ? [
            [-sideX, 0],
            [sideX, 0],
          ]
        : edges.length === 3
          ? [
              [0, belowY],
              [-sideX, -lift],
              [sideX, -lift],
            ]
          : [
              [-sideX, -lift],
              [sideX, -lift],
              [-sideX, lift],
              [sideX, lift],
            ];
  const top = Math.max(...anchors.map(([, y]) => -y + EDGE_CARD.height / 2), CENTER_CARD.height / 2);
  const bottom = Math.max(...anchors.map(([, y]) => y + EDGE_CARD.height / 2), CENTER_CARD.height / 2);
  // 高度闸门:环的纵向需求超过容器即解不开——退到队列树,而不是顶对齐滚动
  // 让底部锚位的节点卡越过折叠线。
  if (top + bottom + 2 * (CANVAS_PADDING + 8) > height) return null;
  const canvasHeight = Math.max(height, top + bottom + 2 * (CANVAS_PADDING + 8));
  const centerY = (canvasHeight - (top + bottom)) / 2 + top;
  const placement = new Map<string, FleetNodePlacement>([["center", centerPlacementAt(width / 2, centerY)]]);
  for (const [index, node] of edges.entries()) {
    const [x, y] = anchors[index] ?? anchors[anchors.length - 1]!;
    placement.set(node.nodeId, {
      left: width / 2 + x - EDGE_CARD.width / 2,
      top: centerY + y - EDGE_CARD.height / 2,
      width: EDGE_CARD.width,
      height: EDGE_CARD.height,
    });
  }
  for (const node of edges) {
    const link = borderLinkLength(placement.get("center")!, placement.get(node.nodeId)!);
    if (link < LINK_MIN - 0.5 || link > LINK_MAX + 0.5) return null;
  }
  return { canvasWidth: width, canvasHeight, placement, narrow: false, spineX: 0 };
}

/** 侧锚 (sideX, y) 到中心卡的连线长度:y 单调增(hypot 增、方向变陡使两卡
 * 沿线出射距离减),供二分。 */
function sideLinkLength(sideX: number, y: number): number {
  const distance = Math.hypot(sideX, y);
  const unitX = sideX / distance;
  const unitY = y / distance;
  return distance - ringExits(unitX, unitY);
}

/** 单位方向 (ux, uy) 下,半宽 halfW 半高 halfH 的矩形中心到边框的出射距离。 */
function exitDistance(halfWidth: number, halfHeight: number, unitX: number, unitY: number): number {
  const tx = unitX === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(unitX);
  const ty = unitY === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(unitY);
  return Math.min(tx, ty);
}

/** 两卡边框间连线的可见长度:连线端点收到各自边框(borderPoint 同一几何)。 */
export function borderLinkLength(from: FleetNodePlacement, to: FleetNodePlacement): number {
  const fromCenter = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  const toCenter = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return 0;
  return (
    distance -
    exitDistance(from.width / 2, from.height / 2, dx / distance, dy / distance) -
    exitDistance(to.width / 2, to.height / 2, dx / distance, dy / distance)
  );
}

function centerPlacementAt(centerX: number, centerY: number): FleetNodePlacement {
  return {
    left: centerX - CENTER_CARD.width / 2,
    top: centerY - CENTER_CARD.height / 2,
    width: CENTER_CARD.width,
    height: CENTER_CARD.height,
  };
}

/** 双翼列:两翼贴面板左右沿(offset = 半宽),中间的横向净空即连线长度;宽度
 * 不够 LINK_MIN 时返回 null 退到队列树。画布高度随翼列行数扩展。 */
function columnLayout(width: number, height: number, edges: readonly FleetLayoutNode[]): FleetLayout | null {
  const offset = width / 2 - EDGE_CARD.width / 2 - CANVAS_PADDING;
  const horizontalLink = offset - (CENTER_CARD.width / 2 + EDGE_CARD.width / 2);
  if (horizontalLink < LINK_MIN) return null;
  const rightCount = Math.ceil(edges.length / 2);
  const columns = [
    { offset, members: edges.slice(0, rightCount) },
    { offset: -offset, members: edges.slice(rightCount) },
  ];
  const columnHeight = (count: number) => (count === 0 ? 0 : count * EDGE_CARD.height + (count - 1) * CARD_GAP);
  const tallest = Math.max(...columns.map((column) => columnHeight(column.members.length)));
  const canvasHeight = Math.max(height, 2 * CANVAS_PADDING + CENTER_CARD.height, tallest + 2 * CANVAS_PADDING);
  const cy = canvasHeight / 2;
  const placement = new Map<string, FleetNodePlacement>([["center", centerPlacementAt(width / 2, cy)]]);
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

/** 队列树:中心卡在上方居中,边缘两列(左先填)排在下方;列心往面板沿展开
 * (不超过 TREE_COLUMN_SPREAD),行距 CARD_GAP。连线从中心卡斜向下到各卡,
 * 按构造 ≥ LINK_MIN(TREE_GAP 给足纵向净空,列展开拉开横向分量)。 */
function treeLayout(width: number, edges: readonly FleetLayoutNode[]): FleetLayout {
  const columnOffset = Math.min(width / 2 - EDGE_CARD.width / 2 - CANVAS_PADDING, TREE_COLUMN_SPREAD);
  const columns = [edges.filter((_, index) => index % 2 === 0), edges.filter((_, index) => index % 2 === 1)];
  const rows = Math.max(...columns.map((column) => column.length), 1);
  const canvasHeight =
    CANVAS_PADDING + CENTER_CARD.height + TREE_GAP + rows * EDGE_CARD.height + (rows - 1) * CARD_GAP + CANVAS_PADDING;
  const placement = new Map<string, FleetNodePlacement>([
    ["center", centerPlacementAt(width / 2, CANVAS_PADDING + CENTER_CARD.height / 2)],
  ]);
  columns.forEach((column, columnIndex) => {
    const direction = columnIndex === 0 ? -1 : 1;
    column.forEach((node, index) => {
      placement.set(node.nodeId, {
        left: width / 2 + direction * columnOffset - EDGE_CARD.width / 2,
        top: CANVAS_PADDING + CENTER_CARD.height + TREE_GAP + index * (EDGE_CARD.height + CARD_GAP),
        width: EDGE_CARD.width,
        height: EDGE_CARD.height,
      });
    });
  });
  return { canvasWidth: width, canvasHeight, placement, narrow: false, spineX: 0 };
}

/** 纵向堆叠:中心在上、边缘成列,左槽走轨道连线。 */
function narrowLayout(width: number, edges: readonly FleetLayoutNode[]): FleetLayout {
  const cardWidth = Math.min(width - 64, 360);
  const spineX = CANVAS_PADDING + 6;
  const cardLeft = spineX + 14;
  const centerTop = CANVAS_PADDING;
  const placement = new Map<string, FleetNodePlacement>([
    ["center", { left: cardLeft, top: centerTop, width: cardWidth, height: CENTER_CARD.height }],
  ]);
  let top = centerTop + CENTER_CARD.height + Math.max(34, LINK_MIN - 96);
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
