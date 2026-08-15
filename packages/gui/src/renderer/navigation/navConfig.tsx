import { Kanban, SquaresFour, Graph, Scales, Stack, PlugsConnected, GearSix, GitBranch, FirstAidKit, Package } from "@phosphor-icons/react";
import { t, type MessageKey } from "../i18n/index.tsx";
import type { ViewId } from "./viewHistory.ts";

// W2C:列表并入看板(第三种 layout),独立「列表」入口删除。
// 侧栏文案走 i18n 字典(shell.nav.*);未接字典的视图保持中文(见完成度报告)。
const NAV_LABEL_KEY: Record<ViewId, MessageKey> = {
  home: "shell.nav.home",
  overview: "shell.nav.overview",
  board: "shell.nav.board",
  decisions: "shell.nav.decisions",
  decisionPool: "shell.nav.decisionPool",
  factTriage: "shell.nav.factTriage",
  executionEvidence: "shell.nav.executionEvidence",
  graph: "shell.nav.graph",
  presets: "shell.nav.presets",
  adapters: "shell.nav.adapters",
  agents: "shell.nav.agents",
  system: "shell.nav.system",
  settings: "shell.nav.settings",
};

export const navLabel = (id: ViewId): string => t(NAV_LABEL_KEY[id]);

export const WORKSPACE_NAV: { id: ViewId; icon: React.ReactNode }[] = [
  { id: "overview", icon: <SquaresFour weight="duotone" /> },
  { id: "board", icon: <Kanban weight="duotone" /> },
  { id: "decisions", icon: <Scales weight="duotone" /> },
  { id: "decisionPool", icon: <GitBranch weight="duotone" /> },
  { id: "factTriage", icon: <FirstAidKit weight="duotone" /> },
  { id: "executionEvidence", icon: <Package weight="duotone" /> },
  { id: "graph", icon: <Graph weight="duotone" /> },
];

export const MANAGE_NAV: { id: ViewId; icon: React.ReactNode }[] = [
  { id: "presets", icon: <Stack weight="duotone" /> },
  { id: "adapters", icon: <PlugsConnected weight="duotone" /> },
  { id: "agents", icon: <PlugsConnected weight="duotone" /> },
  { id: "system", icon: <GearSix weight="duotone" /> },
  { id: "settings", icon: <GearSix weight="duotone" /> },
];
