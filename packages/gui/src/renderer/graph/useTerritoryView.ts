import { useState, useCallback } from "react";

/**
 * L1 领地总览的视图状态(IA v2 Layer 0)。
 *
 * GraphView 在 600 行复杂度门下,所以 territory 的三个状态外置于此 hook:
 *
 *   viewMode  — 'territory'(首屏默认)↔ 'spotlight'(L2 ego)。
 *   skel      — territory 内的骨架轴(task 按 milestone / decision 按 supersede 家族)。
 *   expandedZones — 不折叠的 zone id 集(默认空 = 全折叠 hot-only)。
 *
 * 切换到 spotlight 由 chip 点击触发(setViewMode + openFocus 两步),回领地由 GraphView
 * 顶栏的「回领地」按钮触发。openFocus 由 useEgoCanvas 提供,作为参数注入。
 */

export type ViewMode = "territory" | "spotlight";
export type TerritorySkel = "task" | "decision";

export interface TerritoryView {
  viewMode: ViewMode;
  skel: TerritorySkel;
  expandedZones: Set<string>;
  /** 点 territory chip → 切到 spotlight + openFocus。 */
  enterSpotlight: (nodeId: string) => void;
  /** 直接切模式(模式条的「领地 / 聚光灯」按钮)。切到 spotlight 时不重置焦点。 */
  setViewMode: (m: ViewMode) => void;
  /** 「回领地」。 */
  enterTerritory: () => void;
  setSkel: (skel: TerritorySkel) => void;
  /** zone 折叠切换(头 / 折叠行的 ▸)。 */
  toggleZone: (zoneId: string) => void;
}

export function useTerritoryView(openFocus: (id: string) => void): TerritoryView {
  const [viewMode, setViewMode] = useState<ViewMode>("territory");
  const [skel, setSkel] = useState<TerritorySkel>("task");
  const [expandedZones, setExpandedZones] = useState<Set<string>>(() => new Set());

  const enterSpotlight = useCallback(
    (nodeId: string) => {
      setViewMode("spotlight");
      openFocus(nodeId);
    },
    [openFocus],
  );

  const enterTerritory = useCallback(() => {
    setViewMode("territory");
  }, []);

  const toggleZone = useCallback((zoneId: string) => {
    setExpandedZones((prev) => {
      const next = new Set(prev);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  }, []);

  return {
    viewMode,
    skel,
    expandedZones,
    enterSpotlight,
    setViewMode,
    enterTerritory,
    setSkel,
    toggleZone,
  };
}
