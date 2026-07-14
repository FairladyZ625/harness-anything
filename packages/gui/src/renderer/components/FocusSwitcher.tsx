import { useEffect, useMemo, useState } from "react";
import { Graph, MagnifyingGlass } from "@phosphor-icons/react";
import {
  searchEntities,
  selectSuggestedHits,
  type EntityHit,
} from "../model/entitySearch";
import { EntityHitRow } from "./CommandPalette";
import { t } from "../i18n/index.tsx";

/**
 * GraphView 左栏:内联 typeahead 搜索 + Recent + Suggested。
 *
 * 这曾经是「全量实体平铺列表」(~400 行线性滚动)——用户反馈「滚动永远找不到东西」。
 * 全量列表已在 ebdc620e 退役,统一查找入口迁到 Cmd+K 命令面板(三原语都进索引)。
 * 但退役后左栏只剩一个「假搜索按钮」+ Recent(冷启动为空),findability 仍不达标。
 *
 * 现在把那个按钮换成真正的内联 `<input>` typeahead,复用 entitySearch 的统一索引与
 * 既有焦点管线(onFocus → switchFocusFromList → useEgoCanvas.openFocus → egoFocusIdOf)。
 * 不再恢复全量列表 —— 领地模式负责空间总览,Cmd+K 负责键盘全屏查找,本栏负责
 * 「我大概知道要什么」的鼠标友好就地查找 + 复访。
 *
 * 三种首屏内容(由 query / recent 状态派生,互斥):
 *   1. query 非空 → 搜索结果(searchEntities 过滤,cap SEARCH_MAX)。
 *   2. query 空 + Recent 非空 → 最近访问(≤ RECENT_MAX,App.pushRecent 维护)。
 *   3. query 空 + Recent 空 → Suggested(权重最高的若干条,与面板空查询口径一致)。
 *
 * 选中任意命中 → onFocus(hit.ref):navRef 形态 task/<id> | decision/<id> | fact/…,
 * useEgoCanvas.openFocus 内部经 egoFocusIdOf 归一到 byId 键空间(裸 task id 与
 * navRef 都幂等)。这与 territory chip / 双击 / 抽屉「设为焦点」走同一条入口不变量。
 */

const RECENT_MAX = 12;
const SEARCH_MAX = 20;
const SUGGESTED_MAX = 8;

// 冷启动 Suggested 段标题。i18n key(components.focusSwitcher.suggested)待 D1a 补;
// 在此之前用与 Task/Decision/Fact 同惯例的英文域词(不进 locale JSON,遵守文件边界)。
const SUGGESTED_LABEL = "Suggested";

interface Props {
  /** 最近访问的实体(权重最高的 RECENT_MAX 个,已解析好 title/subtitle)。 */
  recentHits: readonly EntityHit[];
  /** 三原语统一索引(buildEntityIndex 产物,权重排序)。GraphView 就地建后透传。 */
  entityIndex: readonly EntityHit[];
  /** 当前焦点节点的 byId key(裸 task id / decision/<id> / fact/...);列表命中即高亮。 */
  focusId: string | null;
  /** 用户点命中项触发;父组件把 navRef 翻译成画布焦点(switchFocusFromList → openFocus)。 */
  onFocus: (navRef: string) => void;
  /** 点击 ⌘K 徽标时打开 Cmd+K 全局面板(键盘老手入口,保留)。 */
  onOpenPalette: () => void;
}

export function FocusSwitcher({ recentHits, entityIndex, focusId, onFocus, onOpenPalette }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const trimmed = query.trim();
  const isSearching = trimmed.length > 0;

  const recent = useMemo(() => recentHits.slice(0, RECENT_MAX), [recentHits]);
  const searchHits = useMemo(
    () => (isSearching ? searchEntities(entityIndex, trimmed).slice(0, SEARCH_MAX) : []),
    [entityIndex, trimmed, isSearching],
  );
  // 冷启动填充:Recent 为空时才出 Suggested,Recent 一旦有内容就让位(复访优先于推荐)。
  const suggested = useMemo(
    () => (recent.length === 0 ? selectSuggestedHits(entityIndex, SUGGESTED_MAX) : []),
    [entityIndex, recent.length],
  );

  // 当前模式下键盘可导航的命中集(三态互斥)。
  const navHits: readonly EntityHit[] = isSearching
    ? searchHits
    : recent.length > 0
      ? recent
      : suggested;

  // 查询变化时重置键盘选中到第一项;navHits 收缩时越界回收。
  useEffect(() => {
    setActiveIndex(0);
  }, [trimmed]);
  useEffect(() => {
    if (activeIndex >= navHits.length) setActiveIndex(0);
  }, [navHits.length, activeIndex]);

  const selectHit = (hit: EntityHit) => {
    // 选中后清查询,让左栏回到 Recent/Suggested(刚选的实体会经 pushRecent 进 Recent 头部)。
    setQuery("");
    onFocus(hit.ref);
  };

  // ↑↓ 导航 / Enter 选中 / Esc 清查询(空查询时 Esc 不阻止,交给 GraphView 关抽屉)。
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

  // 焦点高亮:hit 的 byId key 与当前 focusId 同形时高亮(task 是裸 id,其余与 ref 同形)。
  const isFocusedHit = (hit: EntityHit): boolean =>
    focusId !== null && (hit.kind === "task" ? hit.id : hit.ref) === focusId;

  const renderItem = (hit: EntityHit, i: number) => (
    <li key={`${hit.kind}/${hit.id}`}>
      <EntityHitRow
        hit={hit}
        active={i === activeIndex || isFocusedHit(hit)}
        onSelect={() => selectHit(hit)}
        onMouseEnter={() => setActiveIndex(i)}
        testId="focus-switcher-item"
      />
    </li>
  );

  return (
    <aside
      data-testid="focus-switcher"
      className="flex w-64 shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Graph weight="duotone" className="shrink-0 text-text-muted" />
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
          {t("components.focusSwitcher.focusSwitch")}
        </span>
      </div>

      {/*
        内联 typeahead:实时过滤三原语索引,选中走既有 onFocus → openFocus 管线。
        右侧 ⌘K 徽标保留为全局面板的键盘老手入口(点击也开),不与输入冲突。
      */}
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
            title={t("components.commandPalette.dialogLabel")}
            className="shrink-0 rounded font-mono text-[10px] text-text-faint transition-colors hover:text-text"
          >
            ⌘K
          </button>
        </label>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {isSearching ? (
          // 搜索态:只展示结果(输入框 + 放大镜已表明模式),无结果时复用面板的 emptyHint。
          searchHits.length === 0 ? (
            <div className="px-3 py-3 text-[12px] leading-relaxed text-text-faint">
              {t("components.commandPalette.emptyHint")}
            </div>
          ) : (
            <ul className="flex flex-col py-1">{searchHits.map(renderItem)}</ul>
          )
        ) : recent.length > 0 ? (
          // 复访态:Recent。header 展示标题 + 计数。
          <>
            <div className="flex items-center justify-between px-3 pb-1 pt-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                {t("components.focusSwitcher.recent")}
              </span>
              <span className="font-mono text-[10px] text-text-faint">
                {t("components.focusSwitcher.recentCount", { count: recent.length })}
              </span>
            </div>
            <ul className="flex flex-col py-1">{recent.map(renderItem)}</ul>
          </>
        ) : (
          // 冷启动态:Suggested(权重最高若干条,与 Cmd+K 空查询同口径)。
          suggested.length === 0 ? (
            <div className="px-3 py-3 text-[12px] leading-relaxed text-text-faint">
              {t("components.focusSwitcher.recentEmptyHint")}
            </div>
          ) : (
            <>
              <div className="px-3 pb-1 pt-1">
                <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                  {SUGGESTED_LABEL}
                </span>
              </div>
              <ul className="flex flex-col py-1">{suggested.map(renderItem)}</ul>
            </>
          )
        )}
      </div>
    </aside>
  );
}
