import { useEffect, useRef, useState, type RefObject } from "react";
import { CaretDown, Check, MagnifyingGlass, X } from "@phosphor-icons/react";
import { isAvailableAgentEntityRow, type AgentEntityRow, type SquadEntityRow } from "../agent-entity-client.ts";
import { t } from "../i18n/index.tsx";
import {
  agentSquadFilterOptions,
  hasActiveAgentSquadFilters,
  DEFAULT_AGENT_SQUAD_FILTERS,
  type AgentSquadFilters,
} from "../model/agentSquadFilters.ts";
import { FilterChips } from "./primitives/FilterChips.tsx";

// Agent·Squad rail 顶部工具栏:一行(业主 2026-10-06 信息密度反馈)——搜索占剩余宽度,
// 角色分档 FilterChips(带计数)、运行时/层级多选与「已入小队」收进同一个「筛选」
// 下拉弹层,不再在 rail 里占三行。角色、层级、运行时是多数行重复的值,只在这里筛,
// 不进列表行(标准 §2.4「重复值不进行」)。
// 纯查看者状态——组件只管输入与派发,过滤本身在 model/agentSquadFilters.ts。
// 键盘:输入框外按 "/" 聚焦(Cmd/Ctrl+K 已被全局命令面板占用,见 useAppShortcuts);
// 框内 Esc 清空查询;弹层内 Esc 收起弹层(标准 §5.3)。
function FacetSelect({
  testId,
  label,
  options,
  selected,
  onChange,
}: {
  readonly testId: string;
  readonly label: string;
  readonly options: readonly string[];
  readonly selected: readonly string[];
  readonly onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  const text =
    selected.length === 0
      ? t("agentRuntime.filterAll")
      : selected.length === 1
        ? selected[0]
        : t("agentRuntime.filterCountItems", { count: selected.length });
  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex h-7 items-center gap-1 rounded-xs border px-2.5 ui-meta outline-none
          hover:border-border-strong focus-visible:border-border-strong ${
            selected.length > 0
              ? "border-accent/60 bg-accent/10 text-accent"
              : "border-border bg-surface-raised text-text-muted"
          }`}
      >
        <span className="text-text-faint">{label}</span>
        <span className="max-w-[96px] truncate font-mono">{text}</span>
        <CaretDown weight="bold" aria-hidden />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={label}
          className="absolute left-0 top-full z-30 mt-1 min-w-[140px] rounded border border-border-strong
            bg-surface-raised p-1 shadow-lg"
        >
          {options.map((option) => {
            const checked = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={checked}
                data-testid={`${testId}-option-${option}`}
                onClick={() => toggle(option)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ui-meta hover:bg-surface"
              >
                <span
                  aria-hidden
                  className={`grid size-3.5 shrink-0 place-items-center rounded border ${
                    checked ? "border-accent bg-accent text-accent-fg" : "border-border"
                  }`}
                >
                  {checked && <Check weight="bold" className="ui-micro" />}
                </span>
                <span className="truncate font-mono text-text">{option}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 「筛选」下拉弹层按钮 + 弹层本体:所有分面控件(角色/运行时/层级/已入小队)收进来。 */
function FilterMenu({
  agents,
  squads,
  filters,
  onChange,
}: {
  readonly agents: readonly AgentEntityRow[];
  readonly squads: readonly SquadEntityRow[];
  readonly filters: AgentSquadFilters;
  readonly onChange: (filters: AgentSquadFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);
  const patch = (next: Partial<AgentSquadFilters>) => onChange({ ...filters, ...next });
  const options = agentSquadFilterOptions(agents, squads);
  const available = agents.filter(isAvailableAgentEntityRow);
  const roleChips = [
    { key: "all", label: t("agentRuntime.filterAll"), count: available.length },
    ...options.roles.map((role) => ({
      key: role,
      label: roleChipLabel(role),
      count: available.filter((agent) => agent.role === role).length,
    })),
  ];
  // 面计数只数分面,不数搜索词:搜索框就在旁边,自己的状态自己亮。
  const facetCount =
    filters.roles.length + filters.runtimeKinds.length + filters.layers.length + (filters.inSquadOnly ? 1 : 0);
  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        data-testid="agent-squad-filter-toggle"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-xs border px-2.5 ui-meta outline-none
          hover:border-border-strong focus-visible:border-border-strong ${
            facetCount > 0
              ? "border-accent/60 bg-accent/10 text-accent"
              : "border-border bg-surface-raised text-text-muted"
          }`}
      >
        {t("agentRuntime.filterMenu")}
        {facetCount > 0 && <b className="font-mono font-medium tabular-nums">{facetCount}</b>}
        <CaretDown weight="bold" aria-hidden />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("agentRuntime.filterMenu")}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
          className="absolute right-0 top-full z-30 mt-1.5 flex w-[272px] max-w-full flex-col
            gap-2.5 rounded border border-border-strong bg-surface-raised p-2.5 shadow-lg"
        >
          {options.roles.length > 1 && (
            <div>
              <p className="mb-1.5 ui-micro text-text-faint">{t("agentRuntime.filterRole")}</p>
              <span role="group" aria-label={t("agentRuntime.filterRole")} data-testid="agent-squad-filter-role">
                <FilterChips
                  chips={roleChips}
                  value={filters.roles.length === 1 ? filters.roles[0]! : "all"}
                  onChange={(key) => patch({ roles: key === "all" ? [] : [key] })}
                />
              </span>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {options.runtimeKinds.length > 0 && (
              <FacetSelect
                testId="agent-squad-filter-runtime"
                label={t("agentRuntime.filterRuntime")}
                options={options.runtimeKinds}
                selected={filters.runtimeKinds}
                onChange={(runtimeKinds) => patch({ runtimeKinds })}
              />
            )}
            {options.layers.length > 0 && (
              <FacetSelect
                testId="agent-squad-filter-layer"
                label={t("agentRuntime.filterLayer")}
                options={options.layers}
                selected={filters.layers}
                onChange={(layers) => patch({ layers })}
              />
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={filters.inSquadOnly}
            data-testid="agent-squad-filter-in-squad"
            onClick={() => patch({ inSquadOnly: !filters.inSquadOnly })}
            className={`h-7 self-start rounded-xs border px-2.5 ui-meta transition-colors duration-100 ${
              filters.inSquadOnly
                ? "border-accent/60 bg-accent/10 text-accent"
                : "border-border text-text-muted hover:bg-surface-raised"
            }`}
          >
            {t("agentRuntime.filterInSquad")}
          </button>
          {hasActiveAgentSquadFilters(filters) && (
            <button
              type="button"
              data-testid="agent-squad-filter-clear"
              onClick={() => onChange(DEFAULT_AGENT_SQUAD_FILTERS)}
              className="inline-flex h-7 items-center gap-0.5 self-start rounded-xs border border-border px-2.5
                ui-meta text-text-muted hover:bg-surface-raised hover:text-text"
            >
              <X weight="bold" aria-hidden />
              {t("agentRuntime.filterClear")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentSquadFilterBar({
  agents,
  squads,
  filters,
  onChange,
  inputRef,
}: {
  readonly agents: readonly AgentEntityRow[];
  readonly squads: readonly SquadEntityRow[];
  readonly filters: AgentSquadFilters;
  readonly onChange: (filters: AgentSquadFilters) => void;
  readonly inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const ownRef = useRef<HTMLInputElement | null>(null),
    fieldRef = inputRef ?? ownRef;

  // "/" 聚焦搜索:仅在焦点不在任何可输入元素时生效;Cmd/Ctrl+K 归全局命令面板。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      )
        return;
      event.preventDefault();
      fieldRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fieldRef]);

  return (
    // 筛选一行(标准 §2.3 统一摆法 + 紧凑 rail):搜索占剩余宽度,全部分面收进右侧
    // 「筛选」下拉弹层;不换行、不占第二行。
    <div
      data-testid="agent-squad-filter-bar"
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5"
    >
      <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-xs border border-border bg-surface-raised px-2 focus-within:border-border-strong">
        <MagnifyingGlass weight="bold" aria-hidden className="shrink-0 text-text-faint" />
        <input
          ref={fieldRef}
          data-testid="agent-squad-search"
          aria-label={t("agentRuntime.filterSearchLabel")}
          value={filters.query}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filters.query !== "") {
              event.preventDefault();
              onChange({ ...filters, query: "" });
            }
          }}
          placeholder={t("agentRuntime.filterSearchPlaceholder")}
          className="min-w-0 flex-1 bg-transparent ui-meta text-text outline-none placeholder:text-text-faint"
        />
        {filters.query !== "" && (
          <button
            type="button"
            data-testid="agent-squad-search-clear"
            aria-label={t("agentRuntime.filterClearQuery")}
            onClick={() => onChange({ ...filters, query: "" })}
            className="shrink-0 text-text-faint hover:text-text"
          >
            <X weight="bold" aria-hidden />
          </button>
        )}
      </label>
      <FilterMenu agents={agents} squads={squads} filters={filters} onChange={onChange} />
    </div>
  );
}

const roleChipLabel = (role: string): string =>
  role === "commander"
    ? t("agentRuntime.roleCommander")
    : role === "reviewer"
      ? t("agentRuntime.roleReviewer")
      : role === "worker"
        ? t("agentRuntime.roleWorker")
        : role;
