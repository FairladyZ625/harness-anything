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
import { t } from "./i18n/index.tsx";

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

// 项目首页仍含原型事件数据；catalog 管理面已改走 daemon snapshot。
export const MOCK_BACKED_VIEWS: ReadonlySet<ViewId> = new Set([
  "home",
]);

// W2C:列表并入看板(第三种 layout),独立「列表」入口删除。
export const WORKSPACE_NAV: { id: ViewId; label: string; icon: React.ReactNode; isNew?: true }[] = [
  { id: "overview", get label() { return t("renderer.shellConfig.overview"); }, icon: <SquaresFour weight="duotone" /> },
  { id: "board", get label() { return t("renderer.shellConfig.kanban"); }, icon: <Kanban weight="duotone" /> },
  { id: "decisions", get label() { return t("renderer.shellConfig.decisionApproval"); }, icon: <Scales weight="duotone" /> },
  { id: "decisionPool", get label() { return t("renderer.shellConfig.decisionPool"); }, icon: <GitBranch weight="duotone" /> },
  { id: "factTriage", get label() { return t("renderer.shellConfig.factTriage"); }, icon: <FirstAidKit weight="duotone" /> },
  { id: "executions", get label() { return t("renderer.shellConfig.evidenceExecution"); }, icon: <ClipboardText weight="duotone" />, isNew: true },
  { id: "graph", get label() { return t("renderer.shellConfig.graph"); }, icon: <Graph weight="duotone" /> },
  { id: "genealogy", get label() { return t("renderer.shellConfig.genealogy"); }, icon: <ClockCounterClockwise weight="duotone" /> },
];

export const MANAGE_NAV: { id: ViewId; label: string; icon: React.ReactNode }[] = [
  { id: "presets", get label() { return t("renderer.shellConfig.presetVertical"); }, icon: <Stack weight="duotone" /> },
  { id: "adapters", get label() { return t("renderer.shellConfig.engineAdapter"); }, icon: <PlugsConnected weight="duotone" /> },
  { id: "settings", get label() { return t("renderer.shellConfig.settings"); }, icon: <GearSix weight="duotone" /> },
];

export const VIEW_LABEL: Record<ViewId, string> = {
  get home() { return t("renderer.shellConfig.project"); },
  get overview() { return t("renderer.shellConfig.overview"); },
  get board() { return t("renderer.shellConfig.kanban"); },
  get decisions() { return t("renderer.shellConfig.decisionApproval"); },
  get decisionPool() { return t("renderer.shellConfig.decisionPool"); },
  get factTriage() { return t("renderer.shellConfig.factTriage"); },
  get executions() { return t("renderer.shellConfig.evidenceExecution"); },
  get graph() { return t("renderer.shellConfig.graph"); },
  get genealogy() { return t("renderer.shellConfig.genealogy"); },
  get presets() { return t("renderer.shellConfig.presetVertical"); },
  get adapters() { return t("renderer.shellConfig.engineAdapter"); },
  get settings() { return t("renderer.shellConfig.settings"); },
};
