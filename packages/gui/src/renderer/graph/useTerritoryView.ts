import { useState, useCallback } from "react";

/**
 * L1 领地总览的视图状态(IA v2 Layer 0)。
 *
 * GraphView 在 600 行复杂度门下,所以 territory 的画布内状态外置于此 hook:
 *
 *   skel         — territory 内的骨架轴(task 按 milestone / decision 按 supersede 家族)。
 *   expandedZones — 不折叠的 zone id 集(默认空 = 全折叠 hot-only)。
 *
 * viewMode(territory/spotlight)已上提到 EntityWorkspace 本地态 —— 它是 EntityWorkspace
 * 3 态选择条(领地/聚光灯/演化史)的一部分,由那里经 props 下传给 GraphView。本 hook 只
 * 保留画布内部、与 viewMode 无关的 territory 骨架状态,以及 enterSpotlight(chip 单击 →
 * 切 spotlight + openFocus)这一个跨 hook 动作。setViewMode 作为受控入参注入,使
 * enterSpotlight 能把「切聚光灯」写回 EntityWorkspace 本地态。
 */

export type ViewMode = "territory" | "spotlight";
export type TerritorySkel = "task" | "decision";

export interface TerritoryView {
  skel: TerritorySkel;
  expandedZones: Set<string>;
  /** 点 territory chip → 切到 spotlight + openFocus。 */
  enterSpotlight: (nodeId: string) => void;
  setSkel: (skel: TerritorySkel) => void;
  /** zone 折叠切换(头 / 折叠行的 ▸)。 */
  toggleZone: (zoneId: string) => void;
}

/**
 * @param openFocus  useEgoCanvas 提供的焦点切换(重排 ±2 跳)。
 * @param setViewMode  EntityWorkspace 本地 viewMode setter(受控)。enterSpotlight 用它
 *                     把 chip 点击同步成 spotlight 模式,与 openFocus 一次性完成。
 */
export function useTerritoryView(
  openFocus: (id: string) => void,
  setViewMode: (m: ViewMode) => void,
): TerritoryView {
  const [skel, setSkel] = useState<TerritorySkel>("task");
  const [expandedZones, setExpandedZones] = useState<Set<string>>(() => new Set());

  const enterSpotlight = useCallback(
    (nodeId: string) => {
      setViewMode("spotlight");
      openFocus(nodeId);
    },
    [openFocus, setViewMode],
  );

  const toggleZone = useCallback((zoneId: string) => {
    setExpandedZones((prev) => {
      const next = new Set(prev);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  }, []);

  return {
    skel,
    expandedZones,
    enterSpotlight,
    setSkel,
    toggleZone,
  };
}
