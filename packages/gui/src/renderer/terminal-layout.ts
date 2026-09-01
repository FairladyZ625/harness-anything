import { consumeKnownError } from "../api/error-consumption.ts";
import { isRendererRecord } from "./result-validation.ts";

const schema = "terminal-layout/v1",
  storageKey = "harness:gui:terminal-layout",
  maxRepositories = 8;

/**
 * 终端页分屏布局的本地持久化(PLT-TerminalWorkspace W1)。
 *
 * 二级模型抄 VS Code:外层 tab = group,group 内才是 split pane 树。group 的 pane 树
 * 直接存 dockview 的 `toJSON()` 快照——它对渲染层是不透明载荷,唯一被本模块解释的是
 * `panels[<panelId>].params.sessionId`:恢复时按 sessionId 找回 daemon 侧会话并重新
 * attach,找不到的 pane 渲染为可关闭占位(会话与布局各自持久,不互相绑架)。
 *
 * 只落 renderer 侧 localStorage,不进 daemon 协议;键名沿用 terminal-preferences 的
 * `harness:gui:` 前缀惯例,按 repoId 分槽(每个仓一套布局),超出上限时丢最旧的槽。
 */
export type TerminalGridSnapshot = Record<string, unknown>;

export interface TerminalPaneRef {
  readonly panelId: string;
  readonly sessionId: string;
}
export interface TerminalGroupLayout {
  readonly groupId: string;
  /** 新建 group 尚未挂载 dockview 时的初始 pane;grid 落盘后只作兜底。 */
  readonly seeds: readonly TerminalPaneRef[];
  readonly grid: TerminalGridSnapshot | null;
}
export interface TerminalRepoLayout {
  readonly activeGroupId: string | null;
  readonly groups: readonly TerminalGroupLayout[];
}

export const emptyTerminalRepoLayout: TerminalRepoLayout = { activeGroupId: null, groups: [] };

export interface TerminalLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** group 当前的 pane 列表:一旦有 dockview 快照,快照就是唯一权威(空快照 = 空 group)。 */
export function groupPaneRefs(group: TerminalGroupLayout): readonly TerminalPaneRef[] {
  return group.grid ? gridPaneRefs(group.grid) : group.seeds;
}

/** 从 dockview 快照里抽出 pane→session 映射(插入序即 panels 键序)。 */
export function gridPaneRefs(grid: TerminalGridSnapshot): readonly TerminalPaneRef[] {
  const panels = grid.panels;
  if (!isRendererRecord(panels)) return [];
  return Object.entries(panels).flatMap(([panelId, panel]) => {
    if (!isRendererRecord(panel)) return [];
    const params = panel.params;
    if (!isRendererRecord(params) || typeof params.sessionId !== "string" || params.sessionId === "") return [];
    return [{ panelId, sessionId: params.sessionId }];
  });
}

/** 布局里出现过的全部 session id(去重,保持首次出现顺序)。 */
export function layoutSessionIds(layout: TerminalRepoLayout): readonly string[] {
  return [...new Set(layout.groups.flatMap((group) => groupPaneRefs(group).map((pane) => pane.sessionId)))];
}

export function readTerminalLayout(
  storage: Pick<TerminalLayoutStorage, "getItem">,
  repoId: string,
): TerminalRepoLayout {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    if (!isRendererRecord(parsed) || parsed.schema !== schema || !isRendererRecord(parsed.repos))
      return emptyTerminalRepoLayout;
    return repoLayout(parsed.repos[repoId]);
  } catch (cause) {
    consumeKnownError(cause);
    return emptyTerminalRepoLayout;
  }
}

export function writeTerminalLayout(storage: TerminalLayoutStorage, repoId: string, layout: TerminalRepoLayout): void {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    const existing = isRendererRecord(parsed) && isRendererRecord(parsed.repos) ? parsed.repos : {};
    const kept = Object.entries(existing).filter(([key]) => key !== repoId);
    const repos = Object.fromEntries([...kept.slice(-(maxRepositories - 1)), [repoId, layout]]);
    storage.setItem(storageKey, JSON.stringify({ schema, repos }));
  } catch (cause) {
    consumeKnownError(cause);
  }
}

function repoLayout(value: unknown): TerminalRepoLayout {
  if (!isRendererRecord(value) || !Array.isArray(value.groups)) return emptyTerminalRepoLayout;
  const groups = value.groups.flatMap(groupLayout);
  const activeGroupId = typeof value.activeGroupId === "string" ? value.activeGroupId : null;
  return {
    groups,
    activeGroupId: groups.some((group) => group.groupId === activeGroupId)
      ? activeGroupId
      : (groups[0]?.groupId ?? null),
  };
}

function groupLayout(value: unknown): readonly TerminalGroupLayout[] {
  if (!isRendererRecord(value) || typeof value.groupId !== "string" || value.groupId === "") return [];
  const grid = isRendererRecord(value.grid) ? (value.grid as TerminalGridSnapshot) : null;
  const seeds = Array.isArray(value.seeds) ? value.seeds.flatMap(paneRef) : [];
  const group: TerminalGroupLayout = { groupId: value.groupId, seeds, grid };
  return groupPaneRefs(group).length > 0 ? [group] : [];
}

function paneRef(value: unknown): readonly TerminalPaneRef[] {
  if (!isRendererRecord(value) || typeof value.panelId !== "string" || typeof value.sessionId !== "string") return [];
  if (value.panelId === "" || value.sessionId === "") return [];
  return [{ panelId: value.panelId, sessionId: value.sessionId }];
}
