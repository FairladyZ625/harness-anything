import { Kanban, SquaresFour, Graph, Scales, Stack, PlugsConnected, GearSix, GitBranch } from "@phosphor-icons/react";
import { t, type MessageKey } from "../i18n/index.tsx";
import type { ViewId } from "./viewHistory.ts";

// W5 IA 重构:一级导航从「工作区 / 管理」改为「工作区 / 决策 / 运行时 / 系统」。
// 组织单位从「实体类型的全量列表」换为「实体邻域」:事实分诊并入 Task 详情「证据」
// 页签,执行证据并入「收口」页签,「编排」随派工链归「派工」页签而消失。
// 总览保留(时间轴切片,与邻域组织同一原则);关系图是唯一被当导航用的入口,不动。
const NAV_LABEL_KEY: Record<ViewId, MessageKey> = {
  home: "shell.nav.home",
  overview: "shell.nav.overview",
  board: "shell.nav.board",
  decisions: "shell.nav.decisions",
  decisionPool: "shell.nav.decisionPool",
  decisionDetail: "shell.nav.decisionDetail",
  factDetail: "shell.nav.factDetail",
  graph: "shell.nav.graph",
  presets: "shell.nav.presets",
  adapters: "shell.nav.adapters",
  agents: "shell.nav.agents",
  system: "shell.nav.system",
  settings: "shell.nav.settings",
};

export const navLabel = (id: ViewId): string => t(NAV_LABEL_KEY[id]);

export interface NavGroup {
  readonly id: string;
  readonly labelKey: MessageKey;
  readonly items: readonly { readonly id: ViewId; readonly icon: React.ReactNode }[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "workspace",
    labelKey: "shell.nav.workspace",
    items: [
      { id: "overview", icon: <SquaresFour weight="duotone" /> },
      { id: "board", icon: <Kanban weight="duotone" /> },
      { id: "graph", icon: <Graph weight="duotone" /> },
    ],
  },
  {
    id: "decisions",
    labelKey: "shell.nav.decisionGroup",
    items: [
      { id: "decisions", icon: <Scales weight="duotone" /> },
      { id: "decisionPool", icon: <GitBranch weight="duotone" /> },
    ],
  },
  {
    id: "runtime",
    labelKey: "shell.nav.runtimeGroup",
    items: [
      // Provider(Runtime)/Agent/Squad/Sessions 都在这一页的 rail 里,同为一级「运行时」之下。
      { id: "agents", icon: <PlugsConnected weight="duotone" /> },
    ],
  },
  {
    id: "system",
    labelKey: "shell.nav.systemGroup",
    items: [
      { id: "presets", icon: <Stack weight="duotone" /> },
      { id: "adapters", icon: <PlugsConnected weight="duotone" /> },
      { id: "system", icon: <GearSix weight="duotone" /> },
      { id: "settings", icon: <GearSix weight="duotone" /> },
    ],
  },
];
