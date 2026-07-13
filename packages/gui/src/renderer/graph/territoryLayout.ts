import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import type { RelationCoverageRow } from "../../api/renderer-dto.ts";
import { parseEndpoint } from "./endpoint";
import type { GraphFilterInput, LayoutOutput } from "./graphLayoutTypes";
import {
  partitionTaskTerritory,
  partitionDecisionTerritory,
  GEO,
  type Section,
  type Zone,
  type Member,
} from "./territoryPartition";
import type { Node } from "@xyflow/react";

/**
 * L1 领地总览布局(IA v2 Layer 0 / dec_01KXA7811SVVT8P66HNDFZQ7DF)。
 *
 * 取代「300 条平铺列表」的首屏:把台账按固有结构分区成「领地块」,一块一块铺开,
 * 让用户一眼看出「哪块干什么、各自健康度」。是聚光灯(L2)的入口 —— 点块内实体即
 * 切换到 ego 画布并以它为焦点。
 *
 * 纯函数 + 确定性:输入 rows + relations + filters + expandedZones → React Flow 节点。
 * 零重叠(网格布局)、双主题(节点只用 CSS 变量)、节点尺寸顶层 width/height 必给(MiniMap)。
 * 无边(L1 是「空间形状」,关系线在 L2 聚光灯才画)。
 *
 * 分区逻辑(两条骨架轴)在 territoryPartition.ts;本文件只管几何摆放 + 节点组装。
 */

export type { TerritorySkel } from "./territoryPartition";
export type { Section, Zone, Member } from "./territoryPartition";

// ── 几何常量 ──
const ZONE_W = 340;
const ZONE_HEADER_H = 78;
const ZONE_BODY_PAD_Y = 8;
const ZONE_BODY_PAD_X = 8;
const GRID_COLS = 3;
const ZONE_GAP_X = 20;
const ZONE_GAP_Y = 20;
const SECTION_HEADER_H = 34;
const SECTION_GAP_Y = 40;
const TOP_PAD = 16;
const LEFT_PAD = 24;

export interface TerritoryInput {
  skel: "task" | "decision";
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
  filters: GraphFilterInput;
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  /** 已展开(不折叠)的 zone id 集;默认折叠 hot-only。 */
  expandedZones: Set<string>;
}

export function layoutTerritory(input: TerritoryInput): LayoutOutput {
  const { skel, expandedZones, filters } = input;
  const partitionInput = {
    tasks: input.tasks,
    decisions: input.decisions,
    relations: input.relations,
    filters,
    coverageRows: input.coverageRows,
  };
  const typeOn = (e: "task" | "decision") => filters.types.has(e);
  const sections: Section[] =
    skel === "task"
      ? typeOn("task")
        ? partitionTaskTerritory(partitionInput)
        : []
      : typeOn("decision")
        ? partitionDecisionTerritory(partitionInput)
        : [];

  const rfNodes: Node[] = [];
  let cursorY = TOP_PAD;
  let maxX = LEFT_PAD;

  for (const section of sections) {
    if (section.zones.length === 0) continue;

    // section header
    const sectionW = GRID_COLS * ZONE_W + (GRID_COLS - 1) * ZONE_GAP_X;
    rfNodes.push({
      id: `territory-section:${section.id}`,
      type: "territoryZone",
      position: { x: LEFT_PAD, y: cursorY },
      width: sectionW,
      height: SECTION_HEADER_H,
      style: { width: sectionW, height: SECTION_HEADER_H },
      data: { variant: "section", title: section.title, subtitle: section.subtitle, skel },
      zIndex: -1,
      selectable: false,
      draggable: false,
    });
    cursorY += SECTION_HEADER_H + 8;

    const rows = chunk(section.zones, GRID_COLS);
    for (const row of rows) {
      for (const zone of row) {
        const folded = !expandedZones.has(zone.id);
        zone.bodyH = computeBodyH(zone, folded);
        zone.h = ZONE_HEADER_H + ZONE_BODY_PAD_Y * 2 + zone.bodyH;
      }
      const rowH = Math.max(...row.map((z) => z.h ?? 0));

      let cursorX = LEFT_PAD;
      for (const zone of row) {
        const zh = zone.h ?? 0;
        const folded = !expandedZones.has(zone.id);
        const shown = visibleMembers(zone, folded);
        const memberH = zone.skel === "task" ? GEO.TASK_CHIP_H : GEO.DECISION_CARD_H;
        const memberGap = zone.skel === "task" ? GEO.TASK_CHIP_GAP : GEO.DECISION_CARD_GAP;
        const memberW = ZONE_W - ZONE_BODY_PAD_X * 2;

        // zone 背景
        rfNodes.push({
          id: `territory-zone:${zone.id}`,
          type: "territoryZone",
          position: { x: cursorX, y: cursorY },
          width: ZONE_W,
          height: zh,
          style: { width: ZONE_W, height: zh },
          data: {
            variant: "zone",
            title: zone.title,
            axis: zone.axis,
            virtual: zone.virtual,
            unlanded: zone.unlanded,
            skel: zone.skel,
            statusCounts: zone.statusCounts,
            isAllDone: zone.isAllDone,
            stateCounts: zone.stateCounts,
            coverageSummary: zone.coverageSummary,
            historyTotal: zone.historyTotal,
            total: zone.total,
            folded,
            zoneId: zone.id,
          },
          zIndex: 0,
          selectable: false,
          draggable: false,
        });

        // member chips
        let memberY = ZONE_HEADER_H + ZONE_BODY_PAD_Y;
        for (const m of shown) {
          rfNodes.push(buildChipNode(m, cursorX + ZONE_BODY_PAD_X, cursorY + memberY, memberW, memberH, zone));
          memberY += memberH + memberGap;
        }

        // fold 提示
        if (folded && zone.members.length > shown.length) {
          const hidden = zone.members.length - shown.length;
          rfNodes.push({
            id: `territory-fold:${zone.id}`,
            type: "territoryChip",
            position: { x: cursorX + ZONE_BODY_PAD_X, y: cursorY + memberY },
            width: memberW,
            height: GEO.TASK_CHIP_H,
            style: { width: memberW, height: GEO.TASK_CHIP_H },
            data: {
              entity: "fold",
              label: `▸ 还有 ${hidden} 项（多为 done）— 展开`,
              zoneId: zone.id,
              skel: zone.skel,
            },
            zIndex: 2,
          });
        }

        cursorX += ZONE_W + ZONE_GAP_X;
        maxX = Math.max(maxX, cursorX);
      }
      cursorY += rowH + ZONE_GAP_Y;
    }
    cursorY += SECTION_GAP_Y;
  }

  const bounds = {
    width: Math.max(maxX, LEFT_PAD + GRID_COLS * ZONE_W) - LEFT_PAD,
    height: cursorY - TOP_PAD,
  };

  return {
    nodes: rfNodes,
    edges: [],
    cycleWarning: { count: 0, cycles: [] },
    resolvedFocusId: null,
    focusClaims: [],
    bounds,
  };
}

function buildChipNode(
  m: Member,
  x: number,
  y: number,
  w: number,
  h: number,
  zone: Zone,
): Node {
  const navRef = m.entity === "task" ? `task/${m.id}` : m.id;
  return {
    id: m.id,
    type: "territoryChip",
    position: { x, y },
    width: w,
    height: h,
    style: { width: w, height: h },
    data: {
      entity: m.entity,
      raw: m.row,
      label: m.label,
      color: m.color,
      dimmed: m.dimmed,
      hiddenCount: m.hiddenCount,
      state: m.state,
      coverage: m.coverage,
      historyCount: m.historyCount,
      derivedCount: m.derivedCount,
      riskTier: m.riskTier,
      urgency: m.urgency,
      skel: zone.skel,
      unlanded: zone.unlanded,
      navRef,
    },
    zIndex: 2,
  };
}

// ── 几何辅助 ──

function computeBodyH(zone: Zone, folded: boolean): number {
  const memberH = zone.skel === "task" ? GEO.TASK_CHIP_H : GEO.DECISION_CARD_H;
  const memberGap = zone.skel === "task" ? GEO.TASK_CHIP_GAP : GEO.DECISION_CARD_GAP;
  const shown = visibleMembers(zone, folded);
  const extra = folded && zone.members.length > shown.length ? 1 : 0;
  const h = (shown.length + extra) * memberH + Math.max(0, shown.length + extra - 1) * memberGap;
  return Math.max(GEO.ZONE_MIN_BODY_H, Math.min(GEO.ZONE_MAX_BODY_H, h));
}

function visibleMembers(zone: Zone, folded: boolean): Member[] {
  if (!folded) return zone.members.slice(0, 50);
  if (zone.skel === "decision") return zone.members;
  return zone.members.slice(0, GEO.FOLDED_TASK_CAP);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// parseEndpoint 在 graphLayout.ts 的 validEdges 过滤里用,territory 收到的 relations 已过滤;
// 这里保留 void 以防 tree-shake 误报 import 未用(实际 TerritoryInput.relations 已是过滤后的)。
void parseEndpoint;
