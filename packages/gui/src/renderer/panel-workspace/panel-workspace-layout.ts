import { isRendererRecord } from "../result-validation.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";

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
 * 打开的面板身份清单,缺省(旧记录/损坏)回落调用方的默认清单,不设迁移路径。
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

export function readPanelWorkspaceLayout(
  storage: Pick<PanelWorkspaceStorage, "getItem"> | null | undefined,
  workspaceId: string,
): PanelWorkspaceLayout {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(slotKey(workspaceId)) ?? "null");
    if (!isRendererRecord(parsed) || parsed.schema !== schema) return {};
    return parseLayout(parsed.layout);
  } catch {
    // 槽里的字节损坏(写盘中断/手改):退回预设布局,重置手段是页头的「重置布局」。
    return {};
  }
}

function parseSelection(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((id): id is string => typeof id === "string" && id !== "");
}

/**
 * 读当前工作区选择的面板清单。null = 该槽没有有效选择(从未保存/已重置/损坏),
 * 调用方回落默认清单;空集是合法值——关掉全部面板也是一次显式选择。
 */
export function readPanelWorkspaceSelection(
  storage: Pick<PanelWorkspaceStorage, "getItem"> | null | undefined,
  workspaceId: string,
): readonly string[] | null {
  if (!storage) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(slotKey(workspaceId)) ?? "null");
    if (!isRendererRecord(parsed) || parsed.schema !== schema) return null;
    return parseSelection(parsed.panels);
  } catch (cause) {
    // 槽里的字节损坏(与几何同一条判定):回落「没有有效选择」,调用方用默认清单。
    consumeKnownError(cause);
    return null;
  }
}

/** 读-改-写:两个字段各自落盘时保留对方,不整份覆盖同槽的另一份状态。 */
function updateSlot(
  storage: PanelWorkspaceStorage | null | undefined,
  workspaceId: string,
  update: (record: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!storage) return;
  const key = slotKey(workspaceId);
  let record: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (isRendererRecord(parsed) && parsed.schema === schema) record = { ...parsed };
  } catch (cause) {
    // 槽损坏就从空记录重建(几何回落预设、选择回落默认),另一字段照常写回。
    consumeKnownError(cause);
  }
  storage.setItem(key, JSON.stringify(update(record)));
}

export function writePanelWorkspaceLayout(
  storage: PanelWorkspaceStorage | null | undefined,
  workspaceId: string,
  layout: PanelWorkspaceLayout,
): void {
  if (!storage) return;
  const rounded: Record<string, PanelGeometry> = {};
  for (const [panelId, panelGeometry] of Object.entries(layout)) {
    rounded[panelId] = {
      x: Math.round(panelGeometry.x),
      y: Math.round(panelGeometry.y),
      width: Math.round(panelGeometry.width),
      height: Math.round(panelGeometry.height),
    };
  }
  updateSlot(storage, workspaceId, (record) => ({ ...record, schema, layout: rounded }));
}

/** 保存选择的面板清单(同一槽位的几何原样保留)。存储失败向上抛。 */
export function writePanelWorkspaceSelection(
  storage: PanelWorkspaceStorage | null | undefined,
  workspaceId: string,
  panelIds: readonly string[],
): void {
  updateSlot(storage, workspaceId, (record) => ({ ...record, schema, panels: [...panelIds] }));
}

/** 重置布局:只清本工作区的槽(几何与选择一起回默认),不动其他工作区的偏好。存储失败向上抛。 */
export function clearPanelWorkspaceLayout(
  storage: PanelWorkspaceStorage | null | undefined,
  workspaceId: string,
): void {
  if (!storage) return;
  storage.removeItem(slotKey(workspaceId));
}
