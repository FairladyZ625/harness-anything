import { consumeKnownError } from "../api/error-consumption.ts";
import { isRendererRecord } from "./result-validation.ts";

const schema = "split-layout/v1",
  storageKey = "harness:gui:split-layout",
  maxRepositories = 8;

/**
 * 原页面内容区域可调布局的本地持久化(task_fb3ba20d66…):任务详情「文件树|正文」与
 * 工作概况「主区|最近进展」两处分隔的用户偏好——显式排列(左右/上下)、首窗比例、折叠态。
 *
 * 只落 renderer 侧 localStorage(同 terminal-layout/favorites,不进台账、不进 URL),按
 * repoId 分槽(每个仓一套偏好,不跨仓串用);比例存分数而非像素,窗口缩放后两侧仍按同一
 * 比例分配,读入时统一夹回 sanity 区间。没有偏好的槽位 = 自适应默认布局。
 */
export type SplitOrientation = "row" | "column";

export interface SplitPanePreference {
  readonly orientation?: SplitOrientation;
  /** 首窗(文件树/主区)占可用空间的比例,不含分隔条自身。 */
  readonly ratio?: number;
  readonly collapsed?: boolean;
}

export type SplitSlotMap = Record<string, SplitPanePreference>;

/** 存储层的全局 sanity 区间;各调用方在交互时再按自己的窗做更紧的 clamp。 */
const storedRatioRange = { min: 0.1, max: 0.9 } as const;

/** renderer 的 localStorage;非 DOM 环境(如 SSR/测试)返回 null,偏好回落默认。 */
export function splitPreferenceStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function preference(value: unknown): SplitPanePreference {
  if (!isRendererRecord(value)) return {};
  const orientation = value.orientation;
  const ratio = value.ratio;
  return {
    ...(orientation === "row" || orientation === "column" ? { orientation } : {}),
    // 有限分数一律收下并 clamp(存量偏好超出新区间也只是被夹回,不丢)。
    ...(typeof ratio === "number" && Number.isFinite(ratio)
      ? {
          ratio: Math.min(storedRatioRange.max, Math.max(storedRatioRange.min, Math.round(ratio * 1000) / 1000)),
        }
      : {}),
    ...(value.collapsed === true ? { collapsed: true } : {}),
  };
}

function slotMap(value: unknown): SplitSlotMap {
  if (!isRendererRecord(value)) return {};
  const map: SplitSlotMap = {};
  for (const [slot, raw] of Object.entries(value)) {
    const pref = preference(raw);
    if (Object.keys(pref).length > 0) map[slot] = pref;
  }
  return map;
}

export function readSplitPreferences(
  storage: { getItem(key: string): string | null } | null | undefined,
  repoId: string,
): SplitSlotMap {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    if (!isRendererRecord(parsed) || parsed.schema !== schema || !isRendererRecord(parsed.repos)) return {};
    return slotMap(parsed.repos[repoId]);
  } catch (cause) {
    consumeKnownError(cause);
    return {};
  }
}

export function writeSplitPreferences(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null | undefined,
  repoId: string,
  slots: SplitSlotMap,
): void {
  if (!storage) return;
  try {
    const existing: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    const repos =
      isRendererRecord(existing) && parsedSchemaIsCurrent(existing) && isRendererRecord(existing.repos)
        ? { ...existing.repos }
        : {};
    const reposNext = { ...repos, [repoId]: slots };
    const ordered = Object.keys(reposNext);
    // 同 terminal-layout:超出上限丢最旧的仓槽。
    const pruned =
      ordered.length > maxRepositories
        ? Object.fromEntries(ordered.slice(ordered.length - maxRepositories).map((key) => [key, reposNext[key]]))
        : reposNext;
    storage.setItem(storageKey, JSON.stringify({ schema, repos: pruned }));
  } catch (cause) {
    // 隐私模式/quota 满:本会话布局仍生效,只是不跨会话记忆(显式消费,不静默吞)。
    consumeKnownError(cause);
  }
}

function parsedSchemaIsCurrent(value: Record<string, unknown>): boolean {
  return value.schema === schema;
}

/** 写一个槽位(不惊动同仓其他槽);pref 为空对象即清除该槽(恢复默认)。 */
export function setSplitSlot(slots: SplitSlotMap, slot: string, pref: SplitPanePreference): SplitSlotMap {
  const next = { ...slots };
  if (Object.keys(pref).length === 0) delete next[slot];
  else next[slot] = pref;
  return next;
}
