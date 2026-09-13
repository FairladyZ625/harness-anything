import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { GraphFilters } from "../components/GraphFilterPanel.tsx";
import type { TerritorySkel } from "../components/TerritoryModeBar.tsx";
import { graphDensityPreferenceStorage, writeGraphDensityFocusMode } from "../graph-density-preferences.ts";

export function useGraphDensity(
  viewMode: "territory" | "spotlight",
  skel: TerritorySkel,
  filters: GraphFilters,
  setFilters: Dispatch<SetStateAction<GraphFilters>>,
) {
  const [decisionDensity, setDecisionDensity] = useState<GraphFilters["density"]>("focus");
  const decisionScope = viewMode === "territory" && skel === "decision";
  const density = decisionScope ? decisionDensity : filters.density;
  useEffect(() => {
    writeGraphDensityFocusMode(graphDensityPreferenceStorage(), filters.density === "focus");
  }, [filters.density]);
  const setDensityFilters: Dispatch<SetStateAction<GraphFilters>> = (update) => {
    const next = typeof update === "function" ? update({ ...filters, density }) : update;
    if (decisionScope) setDecisionDensity(next.density);
    setFilters({ ...next, density: decisionScope ? filters.density : next.density });
  };
  return { density, setDensityFilters };
}
