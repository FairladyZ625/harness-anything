import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { consumeKnownError } from "../api/error-consumption.ts";

/**
 * 「显示已归档 Fact」开关的本地记忆与全局状态(task 对齐 dec_62CAE6CA):
 * `ha graph` 与派工注入默认不展示已归档 Fact,GUI 的图/三元视图/facts 切面同口径
 * 默认隐藏;本开关打开后带「已归档」标记显示。判定本体是读面行上的 `archived`
 * 字段(kernel 投影),这里只管开关状态的 localStorage 读写与跨视图共享——
 * 偏好语义与 graph-territory-preferences 同款:默认 false(隐藏),坏值/坏存储
 * 回落默认,偏好读坏绝不挡视图。
 */
const storageKey = "harness:gui:show-archived-facts";

/** renderer 的 localStorage;非 DOM 环境(如测试)返回 null,偏好回落默认。 */
export function factArchivePreferenceStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function readFactArchiveShowArchived(
  storage: { getItem(key: string): string | null } | null | undefined,
): boolean {
  if (!storage) return false;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    // 只有显式 true 才打开;null(未设)/坏 JSON/其他值一律回落默认:隐藏。
    return parsed === true;
  } catch (cause) {
    consumeKnownError(cause);
    return false;
  }
}

export function writeFactArchiveShowArchived(
  storage: { setItem(key: string, value: string): void } | null | undefined,
  showArchived: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(showArchived));
  } catch (cause) {
    // 隐私模式/quota 满:本会话开关仍生效,只是不跨会话记忆(显式消费,不静默吞)。
    consumeKnownError(cause);
  }
}

/**
 * 全局共享的开关状态:关系图(行/锚点/触及边)、任务证据列表与 facts 切面
 * (⌘K 索引、实体页统计)都要读同一份,所以走 context 而不是各视图各持一份
 * localStorage 态——开关在图页头部,⌘K 与统计页同步生效。
 * 无 Provider 挂载(如隔离测试)时回落默认:隐藏。
 */
const FactArchiveVisibilityContext = createContext<{
  showArchivedFacts: boolean;
  setShowArchivedFacts: (value: boolean | ((prev: boolean) => boolean)) => void;
}>({ showArchivedFacts: false, setShowArchivedFacts: () => {} });

export function FactArchiveVisibilityProvider({ children }: { readonly children: ReactNode }) {
  const [showArchivedFacts, setShowArchivedFacts] = useState(() =>
    readFactArchiveShowArchived(factArchivePreferenceStorage()),
  );
  useEffect(() => {
    writeFactArchiveShowArchived(factArchivePreferenceStorage(), showArchivedFacts);
  }, [showArchivedFacts]);
  return (
    <FactArchiveVisibilityContext.Provider value={{ showArchivedFacts, setShowArchivedFacts }}>
      {children}
    </FactArchiveVisibilityContext.Provider>
  );
}

export const useFactArchiveVisibility = () => useContext(FactArchiveVisibilityContext);
