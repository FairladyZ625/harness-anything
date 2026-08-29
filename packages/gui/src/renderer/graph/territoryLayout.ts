import type { Node } from "@xyflow/react";
import type { TerritoryChip, TerritoryPartition, TerritoryZone } from "./territory";

/**
 * L1 领地总览布局(两级结构:zone 壳 + 独立 chip 节点)。
 *
 * 恢复 archive 老版(territoryLayout.ts @ be94cc68)的做法:分区数据(territory.ts,
 * 本线的 PRD 聚簇 / decision family / fact 异常分区)不变,这里只负责几何 ——
 *   · 列数由容器宽度派生(deriveGridCols),窄屏 1-2 列、宽屏最多 6 列,
 *     而不是把上千实体挤进固定 3 列 × 260px 的槽位;
 *   · zone 盒高跟随它实际发射的 chip 数(零重叠),折叠态只显前 FOLDED_CHIP_CAP
 *     个 chip + fold 提示行,展开态封顶 EXPANDED_CHIP_CAP;
 *   · chip 是独立 React Flow 节点(可点击进聚光灯),不是 zone DOM 里的静态按钮,
 *     顶层 width/height 必给(MiniMap 需要)。
 *
 * 纯函数 + 确定性:输入 partition + expandedZones + containerWidth → 节点。无边
 * (L1 是空间形状,关系线在 L2 聚光灯画)。
 */

// ── 几何常量(zone 节点渲染必须与这些值同源:nodes/TerritoryNode.tsx 引用) ──
export const ZONE_W = 340;
/** zone 头部基础高(色点 + 标题 + 计数 + 折叠钮)。 */
export const ZONE_HEADER_H = 46;
/** task zone 头部额外增加的进度条块高(状态比例条 + 完成率行)。 */
export const ZONE_PROGRESS_H = 38;
export const ZONE_BODY_PAD_Y = 8;
export const ZONE_BODY_PAD_X = 8;
export const CHIP_H = 30;
export const CHIP_GAP = 4;
export const ZONE_GAP_X = 20;
export const ZONE_GAP_Y = 20;
export const ZONE_MIN_BODY_H = 36;
/** 折叠态展示 chip 数(重要性已由分区排序,头部即热点)。 */
export const FOLDED_CHIP_CAP = 8;
/** 展开态封顶(超过进 fold 提示,避免单块数千 px)。 */
export const EXPANDED_CHIP_CAP = 50;
export const DEFAULT_GRID_COLS = 3;
const GRID_COLS_MAX = 6;
const TOP_PAD = 16;
const LEFT_PAD = 24;

/**
 * 由容器宽度派生领地列数。接受「zone 摆放区」净宽(已扣两侧 LEFT_PAD);
 * 每列净宽 = ZONE_W + ZONE_GAP_X。无效/未测量 → 兜底 DEFAULT_GRID_COLS。
 */
export function deriveGridCols(zoneAreaWidth: number): number {
  if (!Number.isFinite(zoneAreaWidth) || zoneAreaWidth <= 0) return DEFAULT_GRID_COLS;
  const perCol = ZONE_W + ZONE_GAP_X;
  const cols = Math.floor((zoneAreaWidth + ZONE_GAP_X) / perCol);
  return Math.max(1, Math.min(GRID_COLS_MAX, cols));
}

export interface TerritoryLayoutInput {
  partition: TerritoryPartition;
  /** 已展开(不折叠)的 zone id 集;默认折叠 = 只显前 FOLDED_CHIP_CAP 个 chip。 */
  expandedZones: ReadonlySet<string>;
  /** 领地摆放区容器宽(像素,含两侧 LEFT_PAD);未测量回落 DEFAULT_GRID_COLS。 */
  containerWidth?: number;
  onOpen: (navRef: string) => void;
  onFold: (zoneId: string) => void;
}

export type TerritoryZoneNodeData = Record<string, unknown> & {
  readonly zone: TerritoryZone;
  readonly folded: boolean;
  readonly variant: "zone" | "landing";
  readonly onFold: (zoneId: string) => void;
};

export type TerritoryEntityChipNodeData = Record<string, unknown> & {
  readonly chip: TerritoryChip;
  readonly onOpen: (navRef: string) => void;
};

export type TerritoryFoldNodeData = Record<string, unknown> & {
  readonly chip: null;
  readonly fold: { readonly zoneId: string; readonly hidden: number };
  readonly onFold: (zoneId: string) => void;
};

export type TerritoryZoneFlowNode = Node<TerritoryZoneNodeData, "territoryZone">;
export type TerritoryEntityChipFlowNode = Node<TerritoryEntityChipNodeData, "territoryChip">;
export type TerritoryFoldFlowNode = Node<TerritoryFoldNodeData, "territoryChip">;
export type TerritoryChipFlowNode = TerritoryEntityChipFlowNode | TerritoryFoldFlowNode;
export type TerritoryFlowNode = TerritoryZoneFlowNode | TerritoryChipFlowNode;

export interface TerritoryLayout {
  nodes: TerritoryFlowNode[];
}

export function isTerritoryZoneNode(node: TerritoryFlowNode): node is TerritoryZoneFlowNode {
  return node.type === "territoryZone";
}

export function isTerritoryEntityChipNode(node: TerritoryFlowNode): node is TerritoryEntityChipFlowNode {
  return node.type === "territoryChip" && node.data.chip !== null;
}

export function isTerritoryFoldNode(node: TerritoryFlowNode): node is TerritoryFoldFlowNode {
  return node.type === "territoryChip" && node.data.chip === null;
}

/** landing(孤立实体)伪 zone:复用 zone 壳的虚线变体。 */
function landingZone(chips: ReadonlyArray<TerritoryChip>): TerritoryZone {
  return {
    zoneId: "__landing__",
    title: "孤立 / landing",
    entity: chips[0]?.entity ?? "decision",
    moduleId: "__landing__",
    chips: [...chips],
  };
}

export function layoutTerritory(input: TerritoryLayoutInput): TerritoryLayout {
  const { partition, expandedZones, onOpen, onFold } = input;
  const gridCols = deriveGridCols((input.containerWidth ?? 0) - LEFT_PAD * 2);

  const zones: TerritoryZone[] = [...partition.zones];
  if (partition.landing.length > 0) zones.push(landingZone(partition.landing));

  const nodes: TerritoryFlowNode[] = [];
  let cursorY = TOP_PAD;

  const rows = chunk(zones, gridCols);
  for (const row of rows) {
    // 先算整行高度(盒子跟着 chip 走),再统一摆放 → 行内零重叠。
    const heights = row.map((zone) =>
      expandedZones.has(zone.zoneId) ? zoneHeight(zone, false) : zoneHeight(zone, true),
    );
    const rowH = Math.max(...heights);

    let cursorX = LEFT_PAD;
    for (const [i, zone] of row.entries()) {
      const folded = !expandedZones.has(zone.zoneId);
      const h = heights[i] ?? ZONE_HEADER_H;
      const shown = visibleChips(zone, folded);

      nodes.push({
        id: `territory-zone:${zone.zoneId}`,
        type: "territoryZone",
        position: { x: cursorX, y: cursorY },
        width: ZONE_W,
        height: h,
        style: { width: ZONE_W, height: h },
        data: {
          zone,
          folded,
          variant: zone.zoneId === "__landing__" ? "landing" : "zone",
          onFold,
        },
        zIndex: 0,
        selectable: false,
        draggable: false,
      });

      const bodyTop = cursorY + zoneHeaderH(zone) + ZONE_BODY_PAD_Y;
      let chipY = bodyTop;
      for (const chip of shown) {
        nodes.push({
          id: `territory-chip:${chip.navRef}`,
          type: "territoryChip",
          position: { x: cursorX + ZONE_BODY_PAD_X, y: chipY },
          width: ZONE_W - ZONE_BODY_PAD_X * 2,
          height: CHIP_H,
          style: { width: ZONE_W - ZONE_BODY_PAD_X * 2, height: CHIP_H },
          data: { chip, onOpen },
          zIndex: 2,
        });
        chipY += CHIP_H + CHIP_GAP;
      }
      if (shown.length < zone.chips.length) {
        const hidden = zone.chips.length - shown.length;
        nodes.push({
          id: `territory-fold:${zone.zoneId}`,
          type: "territoryChip",
          position: { x: cursorX + ZONE_BODY_PAD_X, y: chipY },
          width: ZONE_W - ZONE_BODY_PAD_X * 2,
          height: CHIP_H,
          style: { width: ZONE_W - ZONE_BODY_PAD_X * 2, height: CHIP_H },
          data: {
            chip: null,
            fold: { zoneId: zone.zoneId, hidden },
            onFold,
          },
          zIndex: 2,
        });
      }

      cursorX += ZONE_W + ZONE_GAP_X;
    }
    cursorY += rowH + ZONE_GAP_Y;
  }

  return { nodes };
}

/** zone 头部高:基础 + (task 进度条块)。渲染端按同一常量排,几何与视觉同源。 */
export function zoneHeaderH(zone: TerritoryZone): number {
  return zone.progress ? ZONE_HEADER_H + ZONE_PROGRESS_H : ZONE_HEADER_H;
}

function zoneHeight(zone: TerritoryZone, folded: boolean): number {
  const shown = visibleChips(zone, folded);
  const extra = shown.length < zone.chips.length ? 1 : 0; // fold 提示行
  const count = shown.length + extra;
  const bodyH = Math.max(ZONE_MIN_BODY_H, count * CHIP_H + Math.max(0, count - 1) * CHIP_GAP);
  return zoneHeaderH(zone) + ZONE_BODY_PAD_Y * 2 + bodyH;
}

function visibleChips(zone: TerritoryZone, folded: boolean): TerritoryChip[] {
  const cap = folded ? FOLDED_CHIP_CAP : EXPANDED_CHIP_CAP;
  return zone.chips.slice(0, cap);
}

function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
