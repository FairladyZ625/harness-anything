import {
  Kanban,
  SquaresFour,
  Graph,
  Stack,
  PlugsConnected,
  GearSix,
  GitBranch,
  Users,
  Waveform,
  HourglassMedium,
  Clock,
  FileHtml,
  BookOpen,
  TerminalWindow,
  ChartLine,
  Pulse,
} from "@phosphor-icons/react";
import { t, type MessageKey } from "../i18n/index.tsx";
import type { ViewId } from "./viewHistory.ts";

// W5 IA 重构:一级导航从「工作区 / 管理」改为「工作区 / 决策 / 运行时 / 系统」。
// 组织单位从「实体类型的全量列表」换为「实体邻域」:事实分诊并入 Task 详情「证据」
// 页签,执行证据并入「收口」页签,「编排」随派工链归「派工」页签而消失。
// 总览保留(时间轴切片,与邻域组织同一原则);关系图是唯一被当导航用的入口,不动。
// W6 IA 拆分:「运行时」组不再是单个聚合入口,而是会话 / Agent(含 Squad)/ Provider
// 三个独立工作区——每类实体一页,Squad 作为 Agent 页内的面(P2 独立生命周期判据),
// 跨页互跳走可寻址路由(entityRoutes),不再挤在同一 rail 里。
// 待办签发 IA:「决策批准」独立导航项撤销——它与总池同源同判据同动作,只是陈列
// 不同;决策队列在总池「决策待裁」域内以专注裁决模式存在(J/K 键盘流保留)。
// 分组随之更名「治理」:组内同时住着 decision 裁决与 task 收口签发两类人工治理
// 动作,再叫「决策」会重现"决策/签发是不是同一个东西"的歧义。
const NAV_LABEL_KEY: Record<ViewId, MessageKey> = {
  home: "shell.nav.home",
  overview: "shell.nav.overview",
  board: "shell.nav.board",
  decisionPool: "shell.nav.decisionPool",
  freshness: "shell.nav.freshness",
  decisionDetail: "shell.nav.decisionDetail",
  factDetail: "shell.nav.factDetail",
  graph: "shell.nav.graph",
  presets: "shell.nav.presets",
  entities: "shell.nav.entities",
  adapters: "shell.nav.adapters",
  sessions: "shell.nav.sessions",
  schedules: "shell.nav.schedules",
  artifacts: "shell.nav.artifacts",
  agentSquad: "shell.nav.agentSquad",
  providers: "shell.nav.providers",
  tokenUsage: "shell.nav.tokenUsage",
  terminal: "shell.nav.terminal",
  browser: "shell.nav.browser",
  system: "shell.nav.system",
  daemonObserve: "shell.nav.daemonObserve",
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
    id: "governance",
    labelKey: "shell.nav.governanceGroup",
    items: [
      { id: "decisionPool", icon: <GitBranch weight="duotone" /> },
      { id: "freshness", icon: <HourglassMedium weight="duotone" /> },
    ],
  },
  {
    id: "runtime",
    labelKey: "shell.nav.runtimeGroup",
    items: [
      { id: "sessions", icon: <Waveform weight="duotone" /> },
      { id: "terminal", icon: <TerminalWindow weight="duotone" /> },
      { id: "schedules", icon: <Clock weight="duotone" /> },
      { id: "artifacts", icon: <FileHtml weight="duotone" /> },
      { id: "agentSquad", icon: <Users weight="duotone" /> },
      { id: "providers", icon: <PlugsConnected weight="duotone" /> },
    ],
  },
  {
    id: "system",
    labelKey: "shell.nav.systemGroup",
    items: [
      { id: "entities", icon: <BookOpen weight="duotone" /> },
      { id: "presets", icon: <Stack weight="duotone" /> },
      { id: "adapters", icon: <PlugsConnected weight="duotone" /> },
      { id: "tokenUsage", icon: <ChartLine weight="duotone" /> },
      { id: "system", icon: <Pulse weight="duotone" /> },
      { id: "settings", icon: <GearSix weight="duotone" /> },
    ],
  },
];
