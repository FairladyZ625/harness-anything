import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { GraphFilters } from "../components/GraphFilterPanel.tsx";
import type { TerritorySkel } from "../components/TerritoryModeBar.tsx";
import { graphDensityPreferenceStorage, writeGraphDensityFocusMode } from "../graph-density-preferences.ts";

/**
 * 重点模式只作用于任务与全域镜头。事实/决策镜头按定义多数不挂活跃 task
 * (悬空 fact 无宿主无引用),分层会把整块折成「重点外 N 项」,所以这两个镜头全量显示。
 */
export function graphFocusAppliesToLens(skel: TerritorySkel): boolean {
  return skel === "task" || skel === "unified";
}

/** 镜头内生效的密度:事实/决策镜头恒为全量,任务/全域镜头跟随持久化偏好。 */
export function graphDensityForLens(skel: TerritorySkel, preference: GraphFilters["density"]): GraphFilters["density"] {
  return graphFocusAppliesToLens(skel) ? preference : "all";
}

export function useGraphDensity(
  skel: TerritorySkel,
  filters: GraphFilters,
  setFilters: Dispatch<SetStateAction<GraphFilters>>,
) {
  const focusApplies = graphFocusAppliesToLens(skel);
  const density = graphDensityForLens(skel, filters.density);
  useEffect(() => {
    writeGraphDensityFocusMode(graphDensityPreferenceStorage(), filters.density === "focus");
  }, [filters.density]);
  const setDensityFilters: Dispatch<SetStateAction<GraphFilters>> = (update) => {
    const next = typeof update === "function" ? update({ ...filters, density }) : update;
    // 全量镜头不回写 density:偏好保留给任务/全域镜头,密度开关也不在这两个镜头出现。
    setFilters({ ...next, density: focusApplies ? next.density : filters.density });
  };
  return { density, setDensityFilters };
}
