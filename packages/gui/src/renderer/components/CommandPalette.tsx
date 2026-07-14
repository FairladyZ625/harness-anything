import { useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlass, ArrowUp, ArrowDown, ArrowRight } from "@phosphor-icons/react";
import {
  buildEntityIndex,
  searchEntities,
  type EntityHit,
  type EntityKind,
} from "../model/entitySearch";
import type { TaskRow, DecisionRow, FactRef } from "../model/types";
import { t, type MessageKey } from "../i18n/index.tsx";

/**
 * Cmd+K 命令面板(gui-b):统一索引 task / decision / fact 三原语。
 *
 * 取代 FocusSwitcher 的「线性滚动全列表 + 结构性排除 fact」——面板只负责
 * 查找 + 跳转,焦点展示仍由 GraphView / DecisionPool / FactTriage 各自处理。
 *
 * 键位:Cmd+K / Ctrl+K 打开,↑↓ 选择,Enter 跳转,Esc 关闭。
 * 查询语法:`d:` `t:` `f:` 或 `decision/<id>` 等前缀限定 kind,剩余做子串匹配。
 *
 * 选中 → onSelectedRef(navRef) → 父组件调 focusEntityInGraph。
 */

const MAX_HITS_PER_KIND = 12;
const MAX_TOTAL_HITS = 36;
const KIND_ORDER: readonly EntityKind[] = ["decision", "task", "fact"];
const KIND_LABEL_KEY: Record<EntityKind, MessageKey> = {
  task: "components.commandPalette.groupTask",
  decision: "components.commandPalette.groupDecision",
  fact: "components.commandPalette.groupFact",
};
const KIND_DOT_COLOR: Record<EntityKind, string> = {
  decision: "var(--color-accent)",
  task: "var(--color-axis-execution)",
  fact: "var(--color-axis-evidence)",
};

/**
 * 单条实体命中行 —— Cmd+K 面板与左栏 FocusSwitcher typeahead 共用,避免两套视觉语言。
 * active 驱动左边框/底色(键盘选中或当前焦点);圆点用 kind 色区分三原语。
 */
export function EntityHitRow({
  hit,
  active,
  onSelect,
  onMouseEnter,
  testId,
}: {
  hit: EntityHit;
  active: boolean;
  onSelect: () => void;
  onMouseEnter?: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-hit-kind={hit.kind}
      onMouseEnter={onMouseEnter}
      onClick={onSelect}
      title={hit.title}
      aria-pressed={active}
      className={`flex w-full items-start gap-2 border-l-2 px-3 py-1.5 text-left transition-colors ${
        active
          ? "border-l-accent bg-accent/10 text-text"
          : "border-l-transparent text-text-muted hover:bg-surface-raised hover:text-text"
      }`}
    >
      <span
        className="mt-1 inline-block size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: KIND_DOT_COLOR[hit.kind] }}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-1 text-[13px] leading-snug">{hit.title}</span>
        <span className="flex items-center gap-2 font-mono text-[10px] text-text-faint">
          <span>{hit.id}</span>
          <span className="truncate">{hit.subtitle}</span>
        </span>
      </span>
    </button>
  );
}

interface Props {
  open: boolean;
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  onClose: () => void;
  /** navRef 选中(task/<id> | decision/<id> | fact/<task>/<anchor>)。 */
  onSelectedRef: (ref: string) => void;
}

export function CommandPalette({
  open,
  tasks,
  decisions,
  facts,
  onClose,
  onSelectedRef,
}: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // 索引随投影重算;空查询时也保留,用作首屏「打开就能看到承重实体」的展示。
  const index = useMemo(
    () => buildEntityIndex({ tasks, decisions, facts }),
    [tasks, decisions, facts],
  );
  const filtered = useMemo(
    () => searchEntities(index, query).slice(0, MAX_TOTAL_HITS),
    [index, query],
  );

  // 分组后展平(decision → task → fact,各组内保留 weight 排序)。
  const flatOrder = useMemo<EntityHit[]>(() => {
    const buckets: Record<EntityKind, EntityHit[]> = { task: [], decision: [], fact: [] };
    for (const hit of filtered) buckets[hit.kind].push(hit);
    const out: EntityHit[] = [];
    for (const kind of KIND_ORDER) out.push(...buckets[kind].slice(0, MAX_HITS_PER_KIND));
    return out;
  }, [filtered]);

  // 打开时聚焦输入框 + 重置查询;关闭时也清掉,避免下次打开残留旧查询。
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // 让父级把面板挂上后再 focus,否则 ref 还没接上。
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // activeIndex 越界回收(查询变短/换前缀时 flatOrder 会变)。
  useEffect(() => {
    if (activeIndex >= flatOrder.length) setActiveIndex(0);
  }, [flatOrder.length, activeIndex]);

  // 滚动 active 项进可视区。
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-palette-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Esc / ↑↓ / Enter / Cmd+K 在面板内的键盘交互。
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, flatOrder.length - 1)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const hit = flatOrder[activeIndex];
      if (hit) onSelectedRef(hit.ref);
      return;
    }
    // Cmd+K / Ctrl+K 在面板打开时按 = 关闭(toggle 语义,跟全局打开快捷键对偶)。
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  // 渲染时插分组头:每个 kind 第一次出现时插一行。
  let lastKind: EntityKind | null = null;
  const items: React.ReactNode[] = [];
  flatOrder.forEach((hit, i) => {
    if (hit.kind !== lastKind) {
      items.push(
        <li
          key={`__group_${hit.kind}`}
          className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wide text-text-faint"
        >
          {t(KIND_LABEL_KEY[hit.kind])}
        </li>,
      );
      lastKind = hit.kind;
    }
    const active = i === activeIndex;
    items.push(
      <li key={`${hit.kind}/${hit.id}`} data-palette-index={i} role="option" aria-selected={active}>
        <EntityHitRow
          hit={hit}
          active={active}
          onSelect={() => onSelectedRef(hit.ref)}
          onMouseEnter={() => setActiveIndex(i)}
          testId="command-palette-item"
        />
      </li>,
    );
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("components.commandPalette.dialogLabel")}
      data-testid="command-palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12dvh]"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border-strong bg-surface shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <label className="relative flex items-center gap-2 border-b border-border px-3 py-2.5">
          <MagnifyingGlass weight="bold" className="size-4 shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            data-testid="command-palette-input"
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            placeholder={t("components.commandPalette.placeholder")}
            className="flex-1 bg-transparent text-[14px] text-text placeholder:text-text-faint focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="font-mono text-[10px] text-text-faint">esc</span>
        </label>

        <ul
          ref={listRef}
          data-testid="command-palette-list"
          className="flex max-h-[55dvh] min-h-0 flex-col overflow-y-auto py-1"
        >
          {flatOrder.length === 0 ? (
            <li className="px-4 py-6 text-center text-[13px] leading-relaxed text-text-faint">
              {t("components.commandPalette.emptyHint")}
            </li>
          ) : (
            items
          )}
        </ul>

        <footer className="flex flex-wrap items-center gap-3 border-t border-border bg-surface/60 px-3 py-1.5 font-mono text-[10px] text-text-faint">
          <span className="inline-flex items-center gap-1">
            <ArrowUp weight="bold" className="size-3" />
            <ArrowDown weight="bold" className="size-3" />
            {t("components.commandPalette.navigateHint")}
          </span>
          <span className="inline-flex items-center gap-1">
            <ArrowRight weight="bold" className="size-3" />
            {t("components.commandPalette.selectHint")}
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            {t("components.commandPalette.prefixHint")}
          </span>
        </footer>
      </div>
    </div>
  );
}
