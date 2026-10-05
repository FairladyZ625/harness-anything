import { useState, type ReactNode } from "react";
import { CompletedDivider } from "../../components/primitives/CompletedDivider.tsx";
import { FilterChips } from "../../components/primitives/FilterChips";
import { SegBar } from "../../components/primitives/SegBar";
import { StatusTag } from "../../components/primitives/StatusTag";
import { WorkTaskRow } from "./WorkOverview.tsx";
import type { WorkSubgroup } from "../../model/workspace-narrative.ts";
import type { SnapshotStatus } from "../../model/types.ts";
import { t, type MessageKey } from "../../i18n/index.tsx";

/**
 * 任务页(原型 v2;§2.2/§1.8 v2 铺开):筛选按钮带计数、按子组或状态分组;有未完成的
 * 组默认展开,已完成/取消项沉到组内底部、在「已完成 N」分隔线之后照常显示;搜索命中
 * 切换到本页并高亮。每条两行(§2.4):状态 + 冒号前标题;执行者 · 卡点 · 最近活动 · 标题补充。
 */

export interface WorkLeafRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: SnapshotStatus;
  readonly pinned: boolean;
  readonly at: string;
  readonly groupKey: string;
  /** 当前 lease 持有者(kernel lease/v1.actor);第二行弱色报执行者。 */
  readonly executor?: string;
  /** 卡点或等待原因(读面的阻塞贡献:等谁答复、被哪个任务卡住);没有就不报。 */
  readonly waiting?: string;
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
    [forcedOpen, setForcedOpen] = useState<Record<string, boolean>>({});
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
            finished = rows.filter(({ status }) => status === "done" || status === "cancelled"),
            open = forcedOpen[key] ?? (live.length > 0 || filtered || groupKeys.length === 1);
          const counts: Partial<Record<SnapshotStatus, number>> = {};
          for (const { status } of rows) counts[status] = (counts[status] ?? 0) + 1;
          const renderRow = (leaf: (typeof rows)[number]) => (
            <div key={leaf.taskId} data-task-row={leaf.taskId}>
              <WorkTaskRow
                task={leaf}
                needle={needle}
                /* 按状态分组时整组状态相同,行内标签是重复值不进行(§2.4);组头已报状态。 */
                tag={groupBy === "status" ? undefined : <StatusTag status={leaf.status} />}
                agoOf={agoOf}
                onOpen={onOpenTask}
              />
            </div>
          );
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
                  {live.map(renderRow)}
                  {finished.length > 0 ? (
                    /* 终态沉底(标准 §1.4 v2):「已完成 N」分隔线之后照常显示,不折叠。 */
                    <>
                      <CompletedDivider>
                        {t("views.workspace.tasks.doneDivider", { count: finished.length })}
                      </CompletedDivider>
                      {finished.map(renderRow)}
                    </>
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
