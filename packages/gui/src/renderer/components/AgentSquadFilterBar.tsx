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

// Agent·Squad rail 顶部工具栏:角色 FilterChips(带计数)+ 搜索(name/id 子串)+ 按当前
// catalog 聚合的运行时/层级多选。角色、层级、运行时是多数行重复的值,只在这里筛,
// 不进列表行(标准 §2.4「重复值不进行」)。
// 纯查看者状态——组件只管输入与派发,过滤本身在 model/agentSquadFilters.ts。
// 键盘:输入框外按 "/" 聚焦(Cmd/Ctrl+K 已被全局命令面板占用,见 useAppShortcuts);
// 框内 Esc 清空查询。
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
  const options = agentSquadFilterOptions(agents, squads),
    ownRef = useRef<HTMLInputElement | null>(null),
    fieldRef = inputRef ?? ownRef,
    active = hasActiveAgentSquadFilters(filters);
  const patch = (next: Partial<AgentSquadFilters>) => onChange({ ...filters, ...next });
  const available = agents.filter(isAvailableAgentEntityRow);
  const roleChips = [
    { key: "all", label: t("agentRuntime.filterAll"), count: available.length },
    ...options.roles.map((role) => ({
      key: role,
      label: roleChipLabel(role),
      count: available.filter((agent) => agent.role === role).length,
    })),
  ];

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
    // 筛选一行(标准 §2.3 统一摆法):筛选靠左(角色 FilterChips、多选下拉、开关),
    // 搜索在右并占满剩余宽度。
    <div
      data-testid="agent-squad-filter-bar"
      className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-2 border-b border-border px-3 py-3"
    >
      {options.roles.length > 1 && (
        <span role="group" aria-label={t("agentRuntime.filterRole")} data-testid="agent-squad-filter-role">
          <FilterChips
            chips={roleChips}
            value={filters.roles.length === 1 ? filters.roles[0]! : "all"}
            onChange={(key) => patch({ roles: key === "all" ? [] : [key] })}
          />
        </span>
      )}
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
      <button
        type="button"
        role="switch"
        aria-checked={filters.inSquadOnly}
        data-testid="agent-squad-filter-in-squad"
        onClick={() => patch({ inSquadOnly: !filters.inSquadOnly })}
        className={`h-7 rounded-xs border px-2.5 ui-meta transition-colors duration-100 ${
          filters.inSquadOnly
            ? "border-accent/60 bg-accent/10 text-accent"
            : "border-border text-text-muted hover:bg-surface-raised"
        }`}
      >
        {t("agentRuntime.filterInSquad")}
      </button>
      {active && (
        <button
          type="button"
          data-testid="agent-squad-filter-clear"
          onClick={() => onChange(DEFAULT_AGENT_SQUAD_FILTERS)}
          className="inline-flex h-7 items-center gap-0.5 rounded-xs border border-border px-2.5 ui-meta
            text-text-muted hover:bg-surface-raised hover:text-text"
        >
          <X weight="bold" aria-hidden />
          {t("agentRuntime.filterClear")}
        </button>
      )}
      <label className="ml-auto flex h-8 min-w-[120px] flex-1 items-center gap-1.5 rounded-xs border border-border bg-surface-raised px-2 focus-within:border-border-strong">
        <MagnifyingGlass weight="bold" aria-hidden className="shrink-0 text-text-faint" />
        <input
          ref={fieldRef}
          data-testid="agent-squad-search"
          aria-label={t("agentRuntime.filterSearchLabel")}
          value={filters.query}
          onChange={(event) => patch({ query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filters.query !== "") {
              event.preventDefault();
              patch({ query: "" });
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
            onClick={() => patch({ query: "" })}
            className="shrink-0 text-text-faint hover:text-text"
          >
            <X weight="bold" aria-hidden />
          </button>
        )}
      </label>
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
