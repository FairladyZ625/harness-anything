import { consumeKnownError } from "../api/error-consumption.ts";
import { isRendererRecord } from "./result-validation.ts";

const schema = "split-layout/v2",
  storageKey = "harness:gui:split-layout",
  maxRepoSlots = 8;

/**
 * 原页面内容区域可调布局的本地持久化(task_fb3ba20d66…):任务详情「文件树|正文」与
 * 工作概况「主区|最近进展」两处分隔的用户偏好——显式排列(左右/上下)、首窗比例、折叠态。
 *
 * 只落 renderer 侧 localStorage(同 terminal-layout/favorites,不进台账、不进 URL),按
 * 连接+仓分槽:任务契约要求布局偏好按连接+仓隔离,而 registry 允许 remote-proxy 仓在
 * 连接间改挂——同 repoId 换连接后不沿用上一连接的排列,写回也不覆盖它。connectionId
 * 即 system status 仓行上的连接("local" 为隐含本机连接),不另立身份源,旧 v1 槽位
 * 直接作废不迁移。比例存分数而非像素,窗口缩放后两侧仍按同一比例分配,读入时统一夹回
 * sanity 区间。没有偏好的槽位 = 自适应默认布局。
 */
export type SplitOrientation = "row" | "column";

export interface SplitPanePreference {
  readonly orientation?: SplitOrientation;
  /** 首窗(文件树/主区)占可用空间的比例,不含分隔条自身。 */
  readonly ratio?: number;
  readonly collapsed?: boolean;
  readonly order?: readonly string[];
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
    ...(Array.isArray(value.order) && value.order.every((id) => typeof id === "string")
      ? { order: [...new Set(value.order)] }
      : {}),
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
  connectionId: string,
  repoId: string,
): SplitSlotMap {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    if (!isRendererRecord(parsed) || parsed.schema !== schema || !isRendererRecord(parsed.connections)) return {};
    const repos = parsed.connections[connectionId];
    if (!isRendererRecord(repos)) return {};
    return slotMap(repos[repoId]);
  } catch (cause) {
    consumeKnownError(cause);
    return {};
  }
}

interface StoredRepoSlot {
  readonly connectionId: string;
  readonly repoId: string;
  readonly slots: unknown;
}

/** 展平成首次写入顺序的(连接,仓)序列:上限裁剪按这个全局顺序丢最旧。 */
function flattenRepoSlots(connections: Record<string, unknown>): StoredRepoSlot[] {
  const flat: StoredRepoSlot[] = [];
  for (const [connectionId, repos] of Object.entries(connections)) {
    if (!isRendererRecord(repos)) continue;
    for (const [repoId, slots] of Object.entries(repos)) flat.push({ connectionId, repoId, slots });
  }
  return flat;
}

function nestRepoSlots(entries: readonly StoredRepoSlot[]): Record<string, unknown> {
  const nested: Record<string, unknown> = {};
  for (const { connectionId, repoId, slots } of entries) {
    const repos = isRendererRecord(nested[connectionId]) ? nested[connectionId] : {};
    repos[repoId] = slots;
    nested[connectionId] = repos;
  }
  return nested;
}

export function writeSplitPreferences(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null | undefined,
  connectionId: string,
  repoId: string,
  slots: SplitSlotMap,
): void {
  if (!storage) return;
  try {
    const existing: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    const connections =
      isRendererRecord(existing) && parsedSchemaIsCurrent(existing) && isRendererRecord(existing.connections)
        ? { ...existing.connections }
        : {};
    const repos = isRendererRecord(connections[connectionId]) ? { ...connections[connectionId] } : {};
    repos[repoId] = slots;
    connections[connectionId] = repos;
    // 同 terminal-layout:超出上限丢最旧的连接+仓槽。
    const flattened = flattenRepoSlots(connections);
    const kept = flattened.length > maxRepoSlots ? flattened.slice(flattened.length - maxRepoSlots) : flattened;
    storage.setItem(storageKey, JSON.stringify({ schema, connections: nestRepoSlots(kept) }));
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
