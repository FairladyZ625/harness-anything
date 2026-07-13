import {
  Kanban,
  SquaresFour,
  Graph,
  Scales,
  Stack,
  PlugsConnected,
  GearSix,
  GitBranch,
  FirstAidKit,
  ClockCounterClockwise,
  ClipboardText,
} from "@phosphor-icons/react";

/**
 * AppShell 级常量与类型:ViewId 路由表 + 导航分组 + 视图标签。
 *
 * 从 App.tsx 抽出(历史栈任务的前置拆分),让 AppSidebar / ViewSwitch / AppShell
 * 共用同一份路由定义,避免三份拷贝漂移。
 */

export type ViewId =
  | "home"
  | "overview"
  | "board"
  | "decisions"
  | "decisionPool"
  | "factTriage"
  | "executions"
  | "graph"
  | "genealogy"
  | "presets"
  | "adapters"
  | "settings";

// 这些视图的数据仍为 mock:preset/adapter 管理面无真实后端。进入时顶部显式挂 MOCK 横幅。
export const MOCK_BACKED_VIEWS: ReadonlySet<ViewId> = new Set([
  "home",
  "presets",
  "adapters",
]);

// W2C:列表并入看板(第三种 layout),独立「列表」入口删除。
export const WORKSPACE_NAV: { id: ViewId; label: string; icon: React.ReactNode; isNew?: true }[] = [
  { id: "overview", label: "总览", icon: <SquaresFour weight="duotone" /> },
  { id: "board", label: "看板", icon: <Kanban weight="duotone" /> },
  { id: "decisions", label: "决策批准", icon: <Scales weight="duotone" /> },
  { id: "decisionPool", label: "决策池", icon: <GitBranch weight="duotone" /> },
  { id: "factTriage", label: "事实分诊", icon: <FirstAidKit weight="duotone" /> },
  { id: "executions", label: "执行证据", icon: <ClipboardText weight="duotone" />, isNew: true },
  { id: "graph", label: "关系图", icon: <Graph weight="duotone" /> },
  { id: "genealogy", label: "演化史", icon: <ClockCounterClockwise weight="duotone" /> },
];

export const MANAGE_NAV: { id: ViewId; label: string; icon: React.ReactNode }[] = [
  { id: "presets", label: "Preset / Vertical", icon: <Stack weight="duotone" /> },
  { id: "adapters", label: "引擎 Adapter", icon: <PlugsConnected weight="duotone" /> },
  { id: "settings", label: "设置", icon: <GearSix weight="duotone" /> },
];

export const VIEW_LABEL: Record<ViewId, string> = {
  home: "项目",
  overview: "总览",
  board: "看板",
  decisions: "决策批准",
  decisionPool: "决策池",
  factTriage: "事实分诊",
  executions: "执行证据",
  graph: "关系图",
  genealogy: "演化史",
  presets: "Preset / Vertical",
  adapters: "引擎 Adapter",
  settings: "设置",
};
