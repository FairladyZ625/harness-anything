import { useState, type ReactNode } from "react";
import { FilterChips } from "../../components/primitives/FilterChips";
import { SegBar } from "../../components/primitives/SegBar";
import { WorkTaskRow } from "./WorkOverview.tsx";
import type { WorkSubgroup } from "../../model/workspace-narrative.ts";
import type { SnapshotStatus } from "../../model/types.ts";
import { t, type MessageKey } from "../../i18n/index.tsx";

/**
 * 任务页(原型 v2):筛选按钮带计数、按子组或状态分组;有未完成的组默认展开且
 * 只列未完成项,已完成收成一行;搜索命中切换到本页并高亮(标准 §2.2)。
 */

export interface WorkLeafRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: SnapshotStatus;
  readonly pinned: boolean;
  readonly at: string;
  readonly groupKey: string;
}

const STATUS_ORDER: readonly SnapshotStatus[] = [
  "submitted",
  "in_review",
  "active",
  "planned",
  "blocked",
  "done",
  "cancelled",
];

/** 状态词呈现时取词(STATUS_META 同源),不在模块加载时冻结 locale。 */
function statusLabelOf(status: SnapshotStatus) {
  const key = ("components.badges." + (status === "in_review" ? "inReview" : status)) as MessageKey;
  return t(key);
}

export interface WorkTasksTabProps {
  readonly leaves: readonly WorkLeafRow[];
  readonly subgroups: readonly WorkSubgroup[];
  readonly statusFilter: string;
  readonly groupFilter: string | null;
  readonly query: string;
  readonly agoOf: (iso: string) => string;
  readonly onStatusFilter: (status: string) => void;
  readonly onGroupFilter: (group: string | null) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onLoadMore?: () => void;
  readonly loadingMore?: boolean;
}

export function WorkTasksTab({
  leaves,
  subgroups,
  statusFilter,
  groupFilter,
  query,
  agoOf,
  onStatusFilter,
  onGroupFilter,
  onOpenTask,
  onLoadMore,
  loadingMore = false,
}: WorkTasksTabProps) {
  const [groupBy, setGroupBy] = useState<"subgroup" | "status">("subgroup"),
    [forcedOpen, setForcedOpen] = useState<Record<string, boolean>>({}),
    [expandedDone, setExpandedDone] = useState<ReadonlySet<string>>(new Set());
  const needle = query.trim().toLowerCase(),
    statusMatch = statusFilter === "" ? null : (statusFilter as SnapshotStatus),
    scoped = leaves.filter(
      (leaf) =>
        (groupFilter === null || leaf.groupKey === groupFilter) &&
        (statusMatch === null || leaf.status === statusMatch) &&
        (needle === "" || leaf.title.toLowerCase().includes(needle) || leaf.taskId.toLowerCase().includes(needle)),
    ),
    base = groupFilter === null ? leaves : leaves.filter((leaf) => leaf.groupKey === groupFilter);
  const chips = [
    { key: "", label: t("views.workspace.rail.all"), count: base.length },
    ...STATUS_ORDER.filter((status) => base.some((leaf) => leaf.status === status)).map((status) => ({
      key: status,
      label: statusLabelOf(status),
      count: base.filter((leaf) => leaf.status === status).length,
    })),
  ];
  const titleOf = (key: string): ReactNode =>
    groupBy === "status"
      ? statusLabelOf(key as SnapshotStatus)
      : key === "_loose"
        ? t("views.workspace.tasks.loose")
        : (subgroups.find((group) => group.key === key)?.title ?? key);
  const groups = new Map<string, WorkLeafRow[]>();
  for (const leaf of scoped) {
    const key = groupBy === "status" ? leaf.status : leaf.groupKey;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [leaf]);
    else bucket.push(leaf);
  }
  const groupKeys = [...groups.keys()].sort((left, right) => {
    if (groupBy === "status")
      return STATUS_ORDER.indexOf(left as SnapshotStatus) - STATUS_ORDER.indexOf(right as SnapshotStatus);
    const unfinished = (key: string) =>
      (groups.get(key) ?? []).filter(({ status }) => status !== "done" && status !== "cancelled").length;
    return unfinished(right) - unfinished(left) || (groups.get(right)?.length ?? 0) - (groups.get(left)?.length ?? 0);
  });
  const filtered = statusMatch !== null || needle !== "";

  return (
    <div className="min-w-0">
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        <FilterChips chips={chips} value={statusFilter} onChange={onStatusFilter} />
        {groupFilter !== null ? (
          <button
            type="button"
            className="h-6 rounded-xs border border-accent/40 bg-accent/15 px-2.5 text-accent ui-meta"
            onClick={() => onGroupFilter(null)}
          >
            {t("views.workspace.tasks.groupFilter", {
              name:
                groupFilter === "_loose"
                  ? t("views.workspace.tasks.loose")
                  : (subgroups.find((group) => group.key === groupFilter)?.title ?? groupFilter),
            })}{" "}
            ✕
          </button>
        ) : null}
        <span className="ml-auto text-text-faint ui-meta">{t("views.workspace.tasks.groupBy")}</span>
        <select
          value={groupBy}
          onChange={(event) => setGroupBy(event.target.value as "subgroup" | "status")}
          className="h-6 rounded-xs border border-border bg-text/5 px-1 text-text ui-meta"
        >
          <option value="subgroup">{t("views.workspace.tasks.bySubgroup")}</option>
          <option value="status">{t("views.workspace.tasks.byStatus")}</option>
        </select>
      </div>
      {groupKeys.length === 0 ? (
        <p className="py-5 text-text-faint ui-body">{t("views.workspace.tasks.noMatch")}</p>
      ) : (
        groupKeys.map((key) => {
          const rows = [...(groups.get(key) ?? [])].sort(
              (left, right) =>
                STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status) ||
                right.at.localeCompare(left.at),
            ),
            live = rows.filter(({ status }) => status !== "done" && status !== "cancelled"),
            finished = rows.length - live.length,
            open = forcedOpen[key] ?? (live.length > 0 || filtered || groupKeys.length === 1),
            counts: Partial<Record<SnapshotStatus, number>> = {};
          for (const { status } of rows) counts[status] = (counts[status] ?? 0) + 1;
          const visible = filtered || expandedDone.has(key) ? rows : live;
          return (
            <section key={key} data-group={key} className="border-t border-border">
              <button
                type="button"
                data-group-toggle={key}
                aria-expanded={open}
                onClick={() => setForcedOpen((current) => ({ ...current, [key]: !open }))}
                className="flex w-full items-center gap-2.5 py-2 text-left"
              >
                <span className="w-2.5 flex-none text-text-faint">{open ? "▾" : "▸"}</span>
                <span className="min-w-0 truncate font-semibold text-text ui-body">{titleOf(key)}</span>
                <SegBar counts={counts} className="max-w-[140px] flex-1" />
                <span className="ml-auto flex items-center gap-1 font-mono tabular-nums text-text-muted ui-meta">
                  {live.length > 0 ? (
                    <span className="text-status-submitted">
                      {t("views.workspace.tasks.unfinished", { count: live.length })}
                    </span>
                  ) : null}
                  {t("views.workspace.tasks.count", { count: rows.length })}
                </span>
              </button>
              {open ? (
                <div className="pb-2">
                  {visible.map((leaf) => (
                    <div key={leaf.taskId} data-task-row={leaf.taskId}>
                      <WorkTaskRow
                        task={leaf}
                        title={highlightText(leaf.title, needle)}
                        status={leaf.status}
                        agoOf={agoOf}
                        onOpen={onOpenTask}
                      />
                    </div>
                  ))}
                  {!filtered && !expandedDone.has(key) && finished > 0 && live.length > 0 ? (
                    <button
                      type="button"
                      data-group-done-toggle={key}
                      onClick={() => setExpandedDone((current) => new Set(current).add(key))}
                      className="grid w-full grid-cols-[minmax(3rem,auto)_minmax(0,1fr)_auto] items-center gap-[7px] border-t border-border px-3 text-left text-text-faint ui-meta h-[25px]"
                    >
                      <span />
                      <span className="truncate">{t("views.workspace.tasks.doneCollapsed", { count: finished })}</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })
      )}
      {onLoadMore ? (
        <button
          type="button"
          data-testid="workspace-load-more"
          disabled={loadingMore}
          onClick={onLoadMore}
          className="mt-4 rounded-xs border border-border bg-surface-raised px-3 py-2 text-text ui-body disabled:opacity-60"
        >
          {loadingMore ? t("views.workspace.tasks.loading") : t("views.workspace.tasks.loadMore")}
        </button>
      ) : null}
      <p className="mt-3 text-text-faint ui-meta">{t("views.workspace.tasks.footnote")}</p>
    </div>
  );
}

/** 搜索命中片段的高亮:命不中都原样返回,不猜大小写。 */
export function highlightText(text: string, needle: string): ReactNode {
  if (needle === "") return text;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <span data-search-hit className="rounded-[1px] bg-status-submitted/35">
        {text.slice(index, index + needle.length)}
      </span>
      {text.slice(index + needle.length)}
    </>
  );
}
