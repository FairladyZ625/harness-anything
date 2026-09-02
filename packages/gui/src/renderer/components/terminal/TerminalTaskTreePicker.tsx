import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CaretDown, CaretRight, Crosshair } from "@phosphor-icons/react";
import type { SnapshotStatus } from "../../model/types.ts";
import { STATUS_META } from "../badges.tsx";
import { Popover } from "../Popover.tsx";
import { t } from "../../i18n/index.tsx";
import {
  buildTaskTreeIndex,
  isFiltering,
  taskAncestors,
  taskTreeRows,
  type TaskTreeFilters,
  type TaskTreeNode,
} from "./task-tree.ts";

const statusOrder: readonly SnapshotStatus[] = ["planned", "active", "blocked", "in_review", "done", "cancelled"];
const timeChoices: readonly (number | null)[] = [null, 7, 30, 90];

/**
 * task 绑定选择器(大气泡):按任务树展示。
 *
 * - 搜索命中高亮,祖先链自动展开作上下文;点节点前的箭头看它的全部下级;
 * - 「聚焦」把某个节点当作用域根(面包屑可回到上级或全部),之后的搜索只在该子树内;
 * - 状态 / 创建时间筛选;↑↓ 移动、→ 展开、← 折叠、Enter 绑定。
 * 树与筛选的纯逻辑在 task-tree.ts,本文件只管交互与渲染。
 */
export function TerminalTaskTreePicker({
  tasks,
  value,
  onChange,
}: {
  readonly tasks: readonly TaskTreeNode[];
  readonly value: string;
  readonly onChange: (taskId: string) => void;
}) {
  const index = useMemo(() => buildTaskTreeIndex(tasks), [tasks]);
  const selected = index.byId.get(value) ?? null;
  return (
    <Popover
      label={t("terminal.view.taskTreeOpen")}
      trigger={<span className="truncate">{selected?.title ?? t("terminal.view.unbound")}</span>}
      triggerClassName={
        "control flex w-full min-w-0 items-center justify-start text-left " +
        (selected ? "text-text" : "text-text-faint")
      }
      panelClassName="w-[min(60rem,calc(100vw-2rem))]"
      testId="terminal-task-tree"
    >
      {(close) => (
        <TreeBody
          index={index}
          value={value}
          onPick={(taskId) => {
            onChange(taskId);
            close();
          }}
        />
      )}
    </Popover>
  );
}

function TreeBody({
  index,
  value,
  onPick,
}: {
  readonly index: ReturnType<typeof buildTaskTreeIndex>;
  readonly value: string;
  readonly onPick: (taskId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<ReadonlySet<SnapshotStatus> | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filters: TaskTreeFilters = { query, statuses, createdWithinDays: days };
  const { rows, hits, truncated } = useMemo(
    () => taskTreeRows(index, filters, focusId, toggles),
    [index, filters.query, filters.statuses, filters.createdWithinDays, focusId, toggles],
  );
  const filtering = isFiltering(filters);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActive(0), [query, statuses, days, focusId]);

  const toggle = (taskId: string, expand?: boolean) =>
    setToggles((current) => {
      const next = new Map(current);
      const row = rows.find((item) => item.node.taskId === taskId);
      next.set(taskId, expand ?? !(row?.expanded ?? false));
      return next;
    });
  const focus = (taskId: string | null) => {
    setFocusId(taskId);
    setToggles(new Map());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[active];
    if (event.key === "ArrowDown") setActive((i) => Math.min(i + 1, rows.length - 1));
    else if (event.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (event.key === "ArrowRight" && row?.childCount) toggle(row.node.taskId, true);
    else if (event.key === "ArrowLeft" && row) {
      if (row.expanded) toggle(row.node.taskId, false);
      else if (row.depth > 0) setActive(rows.findIndex((r) => r.node.taskId === row.node.parentTaskId));
    } else if (event.key === "Enter" && row) onPick(row.node.taskId);
    else return;
    event.preventDefault();
  };
  const crumbs = focusId ? [...taskAncestors(index, focusId)].reverse() : [];
  const focusNode = focusId ? index.byId.get(focusId) : null;
  return (
    <div className="flex max-h-[65vh] flex-col gap-2" onKeyDown={onKeyDown} data-testid="terminal-task-tree-body">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("terminal.view.taskPickerPlaceholder")}
          aria-label={t("terminal.view.taskPickerPlaceholder")}
          data-testid="terminal-task-tree-search"
          className="control min-w-56 flex-1"
        />
        <select
          value={days ?? ""}
          onChange={(event) => setDays(event.target.value ? Number(event.target.value) : null)}
          aria-label={t("terminal.view.taskTreeCreatedWithin")}
          className="control"
        >
          {timeChoices.map((choice) => (
            <option key={choice ?? "any"} value={choice ?? ""}>
              {choice === null
                ? t("terminal.view.taskTreeAnyTime")
                : t("terminal.view.taskTreeDays", { count: choice })}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => onPick("")} className="control text-text-muted">
          {t("terminal.view.unbound")}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("terminal.view.taskTreeStatus")}>
        {statusOrder.map((status) => {
          const on = statuses?.has(status) ?? false;
          return (
            <button
              key={status}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setStatuses((current) => {
                  const next = new Set(current ?? []);
                  if (next.has(status)) next.delete(status);
                  else next.add(status);
                  return next.size ? next : null;
                })
              }
              style={on ? { color: STATUS_META[status].color, borderColor: STATUS_META[status].color } : undefined}
              className={`rounded border px-1.5 py-0.5 text-[11px] ${
                on ? "bg-surface" : "border-border text-text-faint"
              }`}
            >
              {STATUS_META[status].label}
            </button>
          );
        })}
        <span className="ml-auto font-mono text-[10px] text-text-faint">
          {filtering
            ? t("terminal.view.taskTreeHits", { hits, total: index.byId.size })
            : t("terminal.view.taskTreeTotal", { total: index.byId.size })}
        </span>
      </div>
      {focusNode && (
        <nav className="flex flex-wrap items-center gap-1 text-[11px]" aria-label={t("terminal.view.taskTreeCrumbs")}>
          <button type="button" onClick={() => focus(null)} className="text-accent hover:underline">
            {t("terminal.view.taskTreeAll")}
          </button>
          {crumbs.map((node) => (
            <span key={node.taskId} className="flex items-center gap-1">
              <span className="text-text-faint">›</span>
              <button type="button" onClick={() => focus(node.taskId)} className="text-accent hover:underline">
                {node.title}
              </button>
            </span>
          ))}
          <span className="text-text-faint">›</span>
          <span className="text-text">{focusNode.title}</span>
        </nav>
      )}
      <div role="tree" className="min-h-0 flex-1 overflow-y-auto" data-testid="terminal-task-tree-rows">
        {rows.length === 0 && <p className="px-2 py-3 text-text-faint">{t("terminal.view.taskPickerEmpty")}</p>}
        {rows.map((row, i) => (
          <div
            key={row.node.taskId}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.childCount ? row.expanded : undefined}
            aria-selected={i === active}
            data-task-id={row.node.taskId}
            data-hit={row.hit ? "true" : "false"}
            onMouseEnter={() => setActive(i)}
            onDoubleClick={() => onPick(row.node.taskId)}
            style={{ paddingLeft: `${row.depth * 1.25 + 0.25}rem` }}
            className={`group flex items-center gap-1 rounded py-0.5 pr-1 ${i === active ? "bg-surface" : ""}`}
          >
            <button
              type="button"
              aria-label={t("terminal.view.taskTreeToggle")}
              disabled={row.childCount === 0}
              onClick={() => toggle(row.node.taskId)}
              className="grid size-5 shrink-0 place-items-center text-text-faint disabled:opacity-0"
            >
              {row.expanded ? <CaretDown /> : <CaretRight />}
            </button>
            <button
              type="button"
              onClick={() => onPick(row.node.taskId)}
              className={`min-w-0 flex-1 truncate text-left ${
                row.hit ? "font-medium text-accent" : filtering ? "text-text-muted" : "text-text"
              } ${row.node.taskId === value ? "underline" : ""}`}
            >
              {row.node.title}
              {row.childCount > 0 && (
                <span className="ml-1 font-mono text-[10px] text-text-faint">({row.childCount})</span>
              )}
            </button>
            {row.node.status && (
              <span className="font-mono text-[10px]" style={{ color: STATUS_META[row.node.status].color }}>
                {STATUS_META[row.node.status].label}
              </span>
            )}
            <span className="hidden font-mono text-[10px] text-text-faint group-hover:inline">{row.node.taskId}</span>
            {row.childCount > 0 && (
              <button
                type="button"
                title={t("terminal.view.taskTreeFocus")}
                aria-label={t("terminal.view.taskTreeFocus")}
                onClick={() => focus(row.node.taskId)}
                className="grid size-5 shrink-0 place-items-center text-text-faint hover:text-accent"
              >
                <Crosshair />
              </button>
            )}
          </div>
        ))}
        {truncated && <p className="px-2 py-1 text-[11px] text-text-faint">{t("terminal.view.taskTreeTruncated")}</p>}
      </div>
    </div>
  );
}
