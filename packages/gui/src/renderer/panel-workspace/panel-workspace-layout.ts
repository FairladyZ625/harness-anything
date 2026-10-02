import { isRendererRecord } from "../result-validation.ts";

const schema = "panel-workspace/v1",
  slotKeyPrefix = "harness:gui:panel-workspace:";

/**
 * 自由面板工作台布局的本地持久化(task_f82b0d6058966986403ef1b635)。
 *
 * 布局是「面板身份 → 画布内几何」的自有模型(画布像素),不存 dockview 的完整
 * toJSON 快照:几何由 dockview 的公共序列化类型 SerializedFloatingGroup.position
 * 读出(见 floating-panel-grid.tsx),坏的分量逐个丢弃而不是整份作废。
 *
 * 面板选择(task_48fe291624e06a2e9ad9496c81)与几何同槽同记录:`panels` 是当前
 * 打开的面板身份清单；选择与几何由画板一次性写入，损坏时使用默认布局。
 *
 * 每个工作区(连接目标 + 仓,由调用方拼成不透明槽键)一个 localStorage 槽键:
 * 读写本槽不解析、不重写其他槽,损坏不外溢,也不需要逐出策略。只落 renderer
 * localStorage,不进 daemon 协议、不持久化业务内容。写失败(quota 满/隐私模式)
 * 向上抛,由画板向用户显示失败状态;读损坏只退回预设布局。
 */
export interface PanelGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type PanelWorkspaceLayout = Readonly<Record<string, PanelGeometry>>;

export interface PanelWorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** renderer 的 localStorage;非 DOM 环境(如 SSR 渲染)返回 null,布局回落预设。 */
export function panelWorkspacePreferenceStorage(): PanelWorkspaceStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function slotKey(workspaceId: string): string {
  return `${slotKeyPrefix}${workspaceId}`;
}

function geometry(value: unknown): PanelGeometry | null {
  if (!isRendererRecord(value)) return null;
  const { x, y, width, height } = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number")
    return null;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return { x, y, width, height };
}

function parseLayout(value: unknown): PanelWorkspaceLayout {
  if (!isRendererRecord(value)) return {};
  const layout: Record<string, PanelGeometry> = {};
  for (const [panelId, raw] of Object.entries(value)) {
    if (panelId === "") continue;
    const panelGeometry = geometry(raw);
    if (panelGeometry !== null) layout[panelId] = panelGeometry;
  }
  return layout;
}

export interface PanelWorkspaceSnapshot {
  readonly layout: PanelWorkspaceLayout;
  readonly panels: readonly string[] | null;
}

/** One record owns selection and geometry; malformed preferences reset together. */
export function readPanelWorkspaceLayout(
  storage: Pick<PanelWorkspaceStorage, "getItem"> | null | undefined,
  workspaceId: string,
): PanelWorkspaceSnapshot {
  const empty: PanelWorkspaceSnapshot = { layout: {}, panels: null };
  if (!storage) return empty;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(slotKey(workspaceId)) ?? "null");
    if (!isRendererRecord(parsed) || parsed.schema !== schema) return empty;
    return {
      layout: parseLayout(parsed.layout),
      panels: Array.isArray(parsed.panels)
        ? parsed.panels.filter((id): id is string => typeof id === "string" && id !== "")
        : null,
    };
  } catch {
    return empty;
  }
}

/** Persist the whole current layout once; errors surface in the owning grid. */
export function writePanelWorkspaceLayout(
  storage: PanelWorkspaceStorage | null | undefined,
  workspaceId: string,
  snapshot: PanelWorkspaceSnapshot,
): void {
  if (!storage) return;
  const layout: Record<string, PanelGeometry> = {};
  for (const [id, box] of Object.entries(snapshot.layout)) {
    layout[id] = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  }
  storage.setItem(slotKey(workspaceId), JSON.stringify({ schema, layout, panels: snapshot.panels }));
}

/** 重置布局:只清本工作区的槽(几何与选择一起回默认),不动其他工作区的偏好。存储失败向上抛。 */
export function clearPanelWorkspaceLayout(
  storage: PanelWorkspaceStorage | null | undefined,
  workspaceId: string,
): void {
  if (!storage) return;
  storage.removeItem(slotKey(workspaceId));
}
