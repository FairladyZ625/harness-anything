import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type { PaletteEntry } from "./CommandPalette.tsx";
import { t } from "../i18n/index.tsx";

/**
 * 关系图左栏:内联 typeahead 搜索 + 最近访问 + Suggested(archive 线 FocusSwitcher 移植)。
 *
 * 三种首屏内容(由 query / recent 状态派生,互斥):
 *   1. query 非空 → 搜索结果(统一实体索引过滤,cap SEARCH_MAX)。
 *   2. query 空 + Recent 非空 → 最近访问(≤ RECENT_MAX,App 层 pushRecent 维护)。
 *   3. query 空 + Recent 空 → Suggested(索引头部若干条)+ 冷启动提示。
 *
 * 选中任意命中 → onFocus(navRef):task/<id> | decision/<id> | fact/<...>,与
 * 领地 chip / 双击 / 抽屉「设为焦点」走同一条入口。纯前端派生,不新增状态源。
 */
const RECENT_MAX = 12;
const SEARCH_MAX = 20;
const SUGGESTED_MAX = 8;

interface Props {
  /** 最近访问的实体 navRef(App 层维护,点过的 task/decision/fact)。 */
  recentRefs: ReadonlyArray<string>;
  /** 统一实体索引(buildPaletteIndex 产物),搜索与 Recent 反解共用。 */
  entries: ReadonlyArray<PaletteEntry>;
  /** 当前焦点 navRef;列表命中即高亮。 */
  focusRef: string | null;
  /** 用户点命中项触发;父组件翻译成画布焦点/导航。 */
  onFocus: (navRef: string) => void;
  /** 点击 ⌘K 徽标时打开全局面板(键盘老手入口)。 */
  onOpenPalette: () => void;
}

export function searchPaletteEntries(entries: ReadonlyArray<PaletteEntry>, query: string): PaletteEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return entries.filter(
    (entry) =>
      entry.label.toLowerCase().includes(needle) ||
      entry.ref.toLowerCase().includes(needle) ||
      (entry.sub?.toLowerCase().includes(needle) ?? false),
  );
}

export function FocusSwitcher({ recentRefs, entries, focusRef, onFocus, onOpenPalette }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const trimmed = query.trim(),
    isSearching = trimmed.length > 0;

  const byRef = useMemo(() => new Map(entries.map((entry) => [entry.ref, entry])), [entries]);
  // Recent 反解:索引外的 ref(已删除实体)自动过滤,顺序保持访问序。
  const recent = useMemo(() => {
    const out: PaletteEntry[] = [];
    for (const ref of recentRefs) {
      const hit = byRef.get(ref);
      if (hit) out.push(hit);
      if (out.length >= RECENT_MAX) break;
    }
    return out;
  }, [byRef, recentRefs]);
  const searchHits = useMemo(
    () => (isSearching ? searchPaletteEntries(entries, trimmed).slice(0, SEARCH_MAX) : []),
    [entries, trimmed, isSearching],
  );
  // 冷启动填充:Recent 为空时才出 Suggested,Recent 一旦有内容就让位(复访优先)。
  const suggested = useMemo(
    () => (recent.length === 0 ? entries.slice(0, SUGGESTED_MAX) : []),
    [entries, recent.length],
  );
  const navHits: ReadonlyArray<PaletteEntry> = isSearching ? searchHits : recent.length > 0 ? recent : suggested;

  useEffect(() => {
    setActiveIndex(0);
  }, [trimmed]);
  useEffect(() => {
    if (activeIndex >= navHits.length) setActiveIndex(0);
  }, [navHits.length, activeIndex]);

  const selectHit = (hit: PaletteEntry) => {
    setQuery("");
    onFocus(hit.ref);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, navHits.length - 1)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const hit = navHits[activeIndex];
      if (hit) selectHit(hit);
      return;
    }
    if (event.key === "Escape" && trimmed) {
      event.preventDefault();
      setQuery("");
    }
  };

  const renderItem = (hit: PaletteEntry, i: number, focused: boolean) => (
    <li key={hit.ref}>
      <button
        type="button"
        data-testid="focus-switcher-item"
        onMouseEnter={() => setActiveIndex(i)}
        onClick={() => selectHit(hit)}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] ${focused ? "bg-surface-raised text-text" : "text-text-muted hover:bg-surface-raised"}`}
      >
        <span className="w-14 shrink-0 truncate font-mono text-[10px] uppercase text-text-faint">{hit.entity}</span>
        <span className="min-w-0 flex-1 truncate">{hit.label}</span>
        {hit.sub ? <span className="shrink-0 truncate font-mono text-[10px] text-text-faint">{hit.sub}</span> : null}
      </button>
    </li>
  );

  return (
    <aside data-testid="focus-switcher" className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-muted">
          {t("components.focusSwitcher.focusSwitch")}
        </span>
      </div>
      <div className="m-2">
        <label className="flex items-center gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 transition-colors focus-within:border-border-strong">
          <MagnifyingGlass weight="bold" className="size-3.5 shrink-0 text-text-faint" />
          <input
            type="search"
            value={query}
            data-testid="focus-switcher-input"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("components.focusSwitcher.searchEntityPlaceholder")}
            className="flex-1 bg-transparent text-[12px] text-text placeholder:text-text-faint focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={onOpenPalette}
            data-testid="focus-switcher-palette-trigger"
            title={t("components.focusSwitcher.openPalette")}
            className="shrink-0 rounded font-mono text-[10px] text-text-faint transition-colors hover:text-text"
          >
            ⌘K
          </button>
        </label>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {isSearching ? (
          searchHits.length === 0 ? (
            <div className="px-3 py-3 text-[12px] leading-relaxed text-text-faint">
              {t("components.focusSwitcher.noResults")}
            </div>
          ) : (
            <ul className="flex flex-col py-1">
              {searchHits.map((hit, i) => renderItem(hit, i, i === activeIndex || hit.ref === focusRef))}
            </ul>
          )
        ) : recent.length > 0 ? (
          <>
            <div className="flex items-center justify-between px-3 pb-1 pt-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                {t("components.focusSwitcher.recent")}
              </span>
              <span className="font-mono text-[10px] text-text-faint">
                {t("components.focusSwitcher.recentCount", { count: recent.length })}
              </span>
            </div>
            <ul className="flex flex-col py-1">
              {recent.map((hit, i) => renderItem(hit, i, i === activeIndex || hit.ref === focusRef))}
            </ul>
          </>
        ) : (
          <>
            <div className="px-3 pb-1 pt-1 text-[12px] leading-relaxed text-text-faint">
              {t("components.focusSwitcher.recentEmptyHint")}
            </div>
            {suggested.length > 0 && (
              <>
                <div className="px-3 pb-1 pt-2">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                    {t("components.focusSwitcher.suggested")}
                  </span>
                </div>
                <ul className="flex flex-col py-1">
                  {suggested.map((hit, i) => renderItem(hit, i, i === activeIndex || hit.ref === focusRef))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
