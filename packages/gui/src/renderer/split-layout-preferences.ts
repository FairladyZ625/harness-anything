import type { SerializedDockview } from "dockview-react";
import { consumeKnownError } from "../api/error-consumption.ts";
import { isRendererRecord } from "./result-validation.ts";

const schema = "split-layout/v3",
  storageKey = "harness:gui:split-layout",
  maxRepoSlots = 8;

/**
 * 原页面内容区域可调布局的本地持久化(任务 task_033760e2…):页面区域停靠分屏的整棵布局树
 * (dockview 序列化快照,含分割方向、比例与区域顺序)按连接+仓+页面槽存 localStorage——同
 * terminal-layout,不进台账、不进 URL。registry 允许 remote-proxy 仓在连接间改挂,同 repoId
 * 换连接后不沿用上一连接的布局,写回也不覆盖它;connectionId 即 system status 仓行上的连接
 * ("local" 为隐含本机连接),不另立身份源。v2 的 orientation/ratio/order 槽位随 swap 排列
 * 路线一起退役,直接作废不迁移。快照读写透传 dockview,损坏时由调用方回落默认布局。
 */
export interface RegionLayoutPreference {
  /** dockview toJSON() 的整份快照;槽位存在即有自定义布局,空对象不落。 */
  readonly snapshot: SerializedDockview | Record<string, unknown>;
}

export type SplitSlotMap = Record<string, RegionLayoutPreference>;

/** renderer 的 localStorage;非 DOM 环境(如 SSR/测试)返回 null,偏好回落默认。 */
export function splitPreferenceStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function preference(value: unknown): RegionLayoutPreference {
  if (!isRendererRecord(value)) return { snapshot: {} };
  const snapshot = value.snapshot;
  return { snapshot: isRendererRecord(snapshot) ? (snapshot as unknown as SerializedDockview) : {} };
}

function slotMap(value: unknown): SplitSlotMap {
  if (!isRendererRecord(value)) return {};
  const map: SplitSlotMap = {};
  for (const [slot, raw] of Object.entries(value)) {
    const pref = preference(raw);
    if (Object.keys(pref.snapshot).length > 0) map[slot] = pref;
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

/** 写一个槽位(不惊动同仓其他槽);pref.grid 为空即清除该槽(恢复默认)。 */
export function setSplitSlot(slots: SplitSlotMap, slot: string, pref: RegionLayoutPreference): SplitSlotMap {
  const next = { ...slots };
  if (Object.keys(pref.snapshot).length === 0) delete next[slot];
  else next[slot] = pref;
  return next;
}
