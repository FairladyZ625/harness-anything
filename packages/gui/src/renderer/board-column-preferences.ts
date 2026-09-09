import { consumeKnownError } from "../api/error-consumption.ts";
import { isRendererRecord } from "./result-validation.ts";

/**
 * 看板列宽的本地持久化(W11):三种布局(列/泳道/列表)各一份「列 key → px 宽度」
 * 映射,存 renderer localStorage(同 favorites/graph-density,不进台账、不进 URL)。
 * 模型刻意保持「每列一个数字」:未设置的列走各视图的 CSS 默认(列模式等分、
 * 泳道 180/230、列表 table-fixed 自动分配),设置了才输出显式宽度。
 */
const storageKey = "harness:gui:board-column-widths";

export type BoardLayoutId = "column" | "swimlane" | "list";
export type BoardColumnWidthMap = Record<string, number>;

export interface BoardColumnWidths {
  readonly column: BoardColumnWidthMap;
  readonly swimlane: BoardColumnWidthMap;
  readonly list: BoardColumnWidthMap;
}

export const emptyBoardColumnWidths: BoardColumnWidths = { column: {}, swimlane: {}, list: {} };

/** 存储层的全局 sanity 区间;各视图在交互时再按自己的列做更紧的 clamp。 */
const storedWidthRange = { min: 40, max: 1200 } as const;

/** renderer 的 localStorage;非 DOM 环境(如 SSR 渲染)返回 null,宽度回落默认。 */
export function boardColumnPreferenceStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function clampBoardColumnWidth(px: number): number {
  return Math.min(storedWidthRange.max, Math.max(storedWidthRange.min, Math.round(px)));
}

function widthMap(value: unknown): BoardColumnWidthMap {
  if (!isRendererRecord(value)) return {};
  const map: BoardColumnWidthMap = {};
  for (const [key, raw] of Object.entries(value)) {
    // 有限数字一律收下并 clamp(存量偏好即使超出新区间也只是被夹回,不丢)。
    if (typeof raw === "number" && Number.isFinite(raw)) map[key] = clampBoardColumnWidth(raw);
  }
  return map;
}

export function readBoardColumnWidths(
  storage: { getItem(key: string): string | null } | null | undefined,
): BoardColumnWidths {
  if (!storage) return emptyBoardColumnWidths;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    if (!isRendererRecord(parsed)) return emptyBoardColumnWidths;
    return {
      column: widthMap(parsed.column),
      swimlane: widthMap(parsed.swimlane),
      list: widthMap(parsed.list),
    };
  } catch (cause) {
    consumeKnownError(cause);
    return emptyBoardColumnWidths;
  }
}

export function writeBoardColumnWidths(
  storage: { setItem(key: string, value: string): void } | null | undefined,
  widths: BoardColumnWidths,
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(widths));
  } catch (cause) {
    // 隐私模式/quota 满:本会话宽度仍生效,只是不跨会话记忆(显式消费,不静默吞)。
    consumeKnownError(cause);
  }
}

/** 设置一列宽度(clamp + 取整);返回新对象,不改入参。 */
export function setBoardColumnWidth(
  widths: BoardColumnWidths,
  layout: BoardLayoutId,
  key: string,
  px: number,
): BoardColumnWidths {
  return { ...widths, [layout]: { ...widths[layout], [key]: clampBoardColumnWidth(px) } };
}

/** 清除一列宽度(双击手柄恢复默认布局);key 不存在时原样返回。 */
export function clearBoardColumnWidth(
  widths: BoardColumnWidths,
  layout: BoardLayoutId,
  key: string,
): BoardColumnWidths {
  if (!(key in widths[layout])) return widths;
  const next = { ...widths[layout] };
  delete next[key];
  return { ...widths, [layout]: next };
}
