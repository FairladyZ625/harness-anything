import { useMemo } from "react";
import { MagnifyingGlass, Star, X } from "@phosphor-icons/react";
import type { CloseoutReadiness, EngineId, Freshness, SnapshotStatus, TaskRow } from "../model/types";
import { BOARD_COLUMNS, boardColumnOf } from "../model/types";
import { STATUS_META } from "./badges";
import {
  DEFAULT_TASK_FILTERS,
  GRAPH_FOCUS_RECENT_WINDOW_DAYS,
  hasActiveTaskFilters,
  taskFilterSummary,
  type TaskFilters,
} from "../model/taskFilters";
import { t } from "../i18n/index.tsx";

const CLOSEOUTS: (CloseoutReadiness | "all")[] = [
  "all",
  "ready",
  "missing",
  "incomplete",
  "failed",
  "passed",
  "not_required",
];
const FRESHNESS: (Freshness | "all")[] = ["all", "fresh", "stale-but-usable", "unavailable-no-cache"];

function Select<T extends string>({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: T;
  values: T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 ui-body text-text-faint">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="rounded-md border border-border bg-surface-raised px-2 py-1.5 ui-body text-text outline-none transition-colors duration-100 hover:border-border-strong focus:border-border-strong"
      >
        {values.map((item) => (
          <option key={item} value={item}>
            {item === "all" ? t("components.taskFilterBar.all") : item}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * 状态筛选平铺 Pill 组(task_8928cf1e,对齐会话页的紧凑设计):每个按钮 = 状态图标 +
 * 名称 + 该列桶的行数,点击切换选中;空选 = 全部列。选中集同时是看板的
 * visibleColumns——未选中的列组件整列不渲染,不再有空列占宽。
 */
function StatusPillGroup({
  tasks,
  selected,
  onChange,
}: {
  tasks: readonly TaskRow[];
  selected: SnapshotStatus[];
  onChange: (next: SnapshotStatus[]) => void;
}) {
  const counts = useMemo(() => {
    const byColumn = new Map<SnapshotStatus, number>(BOARD_COLUMNS.map((status) => [status, 0]));
    for (const task of tasks) {
      const bucket = boardColumnOf(task);
      byColumn.set(bucket, (byColumn.get(bucket) ?? 0) + 1);
    }
    return byColumn;
  }, [tasks]);

  const toggle = (status: SnapshotStatus) => {
    if (selected.includes(status)) onChange(selected.filter((s) => s !== status));
    else onChange([...selected, status]);
  };

  return (
    <span
      role="group"
      aria-label={t("components.taskFilterBar.status")}
      data-testid="board-status-filter"
      className="inline-flex min-w-0 shrink overflow-x-auto rounded border border-border-strong"
    >
      {BOARD_COLUMNS.map((status) => {
        const meta = STATUS_META[status];
        const active = selected.includes(status);
        return (
          <button
            key={status}
            type="button"
            data-testid={`board-status-pill-${status}`}
            aria-pressed={active}
            onClick={() => toggle(status)}
            title={meta.label}
            className={`inline-flex items-center gap-1 whitespace-nowrap px-2.5 py-0.5 ui-micro ${
              active ? "bg-accent font-semibold text-accent-fg" : "text-text-muted hover:bg-surface"
            }`}
          >
            <span style={active ? undefined : { color: meta.color }}>{meta.icon}</span>
            {meta.label}
            <span className="font-mono tabular-nums opacity-80">{counts.get(status) ?? 0}</span>
          </button>
        );
      })}
    </span>
  );
}

export function TaskFilterBar({
  tasks,
  filteredCount,
  filters,
  onChange,
  contextLabel,
  favorites,
  coldTerminalCount,
}: {
  tasks: readonly TaskRow[];
  filteredCount: number;
  filters: TaskFilters;
  onChange: (filters: TaskFilters) => void;
  contextLabel: string;
  favorites?: ReadonlySet<string>;
  /** 看板冷终态计数(W8):折叠态显形「已折叠 N」,点击展开;两种状态都可见,不静默截断。 */
  coldTerminalCount?: number;
}) {
  const modules = [
    ...new Set(tasks.flatMap((task) => (task.moduleKeys?.length ? task.moduleKeys : [task.module]))),
  ].sort();
  const engines: (EngineId | "all")[] = ["all", ...new Set(tasks.map((task) => task.engine))];
  const chips = taskFilterSummary(filters);
  const active = hasActiveTaskFilters(filters);
  const favoriteCount = favorites ? tasks.filter((t) => favorites.has(t.taskId)).length : 0;

  const patch = (next: Partial<TaskFilters>) => onChange({ ...filters, ...next });

  return (
    <section className="border-b border-border bg-surface/35 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <label
          className={
            "flex w-[240px] shrink-0 items-center gap-2 rounded-md border border-border bg-surface-raised " +
            "px-2.5 py-1.5 focus-within:border-border-strong"
          }
        >
          <MagnifyingGlass weight="bold" className="shrink-0 text-text-faint" />
          <input
            value={filters.query}
            onChange={(event) => patch({ query: event.target.value })}
            placeholder={t("components.taskFilterBar.searchTasksModulesStatusWithinContextLabel", { contextLabel })}
            className="min-w-0 flex-1 bg-transparent ui-prose text-text outline-none placeholder:text-text-faint"
          />
        </label>

        <Select
          label={t("components.taskFilterBar.module")}
          value={filters.module}
          values={["all", ...modules]}
          onChange={(module) => patch({ module })}
        />
        <Select
          label={t("components.taskFilterBar.engine")}
          value={filters.engine}
          values={engines}
          onChange={(engine) => patch({ engine })}
        />
        <StatusPillGroup tasks={tasks} selected={filters.status} onChange={(status) => patch({ status })} />
        <Select
          label={t("components.taskFilterBar.closeout")}
          value={filters.closeout}
          values={CLOSEOUTS}
          onChange={(closeout) => patch({ closeout })}
        />
        <Select
          label={t("components.taskFilterBar.freshness")}
          value={filters.freshness}
          values={FRESHNESS}
          onChange={(freshness) => patch({ freshness })}
        />

        {typeof coldTerminalCount === "number" && coldTerminalCount > 0 && (
          <button
            type="button"
            role="switch"
            aria-checked={filters.expandColdTerminal}
            data-testid="board-cold-terminal-toggle"
            onClick={() => patch({ expandColdTerminal: !filters.expandColdTerminal })}
            title={t("components.taskFilterBar.coldTerminalSwitchTitle", {
              days: GRAPH_FOCUS_RECENT_WINDOW_DAYS,
            })}
            className={`rounded-md border px-3 py-1.5 ui-body transition-colors duration-100 ${
              filters.expandColdTerminal
                ? "border-border-strong bg-surface-raised text-text"
                : "border-border text-text-muted hover:bg-surface-raised"
            }`}
          >
            {filters.expandColdTerminal
              ? t("components.taskFilterBar.collapseColdTerminalCount", { count: coldTerminalCount })
              : t("components.taskFilterBar.expandColdTerminalCount", { count: coldTerminalCount })}
          </button>
        )}

        {favorites && favoriteCount > 0 && (
          <button
            type="button"
            role="switch"
            aria-checked={filters.favoritesOnly}
            onClick={() => patch({ favoritesOnly: !filters.favoritesOnly })}
            className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 ui-body transition-colors duration-100 ${
              filters.favoritesOnly
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-text-muted hover:bg-surface-raised"
            }`}
            title={t("components.taskFilterBar.viewOnlyFavoriteTasksFavoriteCountTotal", { favoriteCount })}
          >
            <Star weight={filters.favoritesOnly ? "fill" : "bold"} className="ui-meta" />
            {t("components.taskFilterBar.viewOnlyCollection")} {favoriteCount}
          </button>
        )}

        {active && (
          <button
            onClick={() => onChange(DEFAULT_TASK_FILTERS)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 ui-body text-text-muted transition-colors duration-100 hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" />
            {t("components.taskFilterBar.clear")}
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono ui-meta text-text-faint">
        <span>{t("components.taskFilterBar.filteredTaskCount", { filteredCount, totalCount: tasks.length })}</span>
        {chips.length > 0 ? (
          chips.map((chip) => (
            <span key={chip} className="rounded border border-border px-1.5 py-px">
              {chip}
            </span>
          ))
        ) : (
          <span>{t("components.taskFilterBar.defaultHint")}</span>
        )}
      </div>
    </section>
  );
}
