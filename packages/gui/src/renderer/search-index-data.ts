import { useMemo, useState } from "react";
import { buildPaletteIndex } from "./components/CommandPalette.tsx";
import { usePaletteFactsQuery } from "./triadic-data.ts";
import type { GovernedEntityRow } from "./graph/governedEntities.ts";

/**
 * 统一实体搜索索引(⌘K 面板与关系图左栏共用)的装配与事实切面启用。
 * 事实索引只有这一个持有者:`usePaletteFactsQuery` 在「⌘K 打开 **或** 左栏有
 * 搜索输入(经返回的 onSearchActiveChange 上报)」时启用——没人搜就不持有任何
 * 三元投影(字节纪律 F-9E166C6B);后续事实页由 ⌘K 面板显式续载。
 * task/decision/声明实体行直接喂索引,不新增读面。
 */
export function useSearchIndex(
  repoId: string | null,
  paletteOpen: boolean,
  tasks: ReadonlyArray<{ taskId: string; title: string; coordinationStatus?: string }>,
  decisions: ReadonlyArray<{ decisionId: string; title: string; state?: string }>,
  governedEntities: ReadonlyArray<GovernedEntityRow>,
) {
  const [railSearchActive, setRailSearchActive] = useState(false);
  const paletteFacts = usePaletteFactsQuery(repoId, paletteOpen || railSearchActive);
  const entries = useMemo(
    () =>
      buildPaletteIndex(
        tasks,
        decisions,
        paletteFacts.facts,
        governedEntities.map((entity) => ({
          ref: entity.ref,
          label: entity.title ?? entity.entityId,
          ...(entity.locator ? { sub: entity.locator.value } : {}),
          entity: entity.kind,
        })),
      ),
    [tasks, decisions, paletteFacts.facts, governedEntities],
  );
  return { entries, onSearchActiveChange: setRailSearchActive, facts: paletteFacts };
}
