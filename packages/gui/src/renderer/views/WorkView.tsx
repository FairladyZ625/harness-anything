import { useMemo, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import type { SnapshotStatus, TaskRow } from "../model/types.ts";
import type { CatalogSnapshotSuccess } from "../api-client-catalog.ts";
import type { AgendaSuccess } from "../api-client.ts";
import { StartWorkDialog } from "../components/StartWorkDialog.tsx";
import { t } from "../i18n/index.tsx";
import {
  attentionByWork,
  collectWork,
  workHealth,
  type WorkGroup,
  type WorkHealth,
} from "../model/work-collections.ts";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { SegBar } from "../components/primitives/SegBar.tsx";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag.tsx";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { TitleText } from "../components/primitives/TitleText.tsx";
import { relativeTime } from "../sessions-model.ts";
import { formatTime } from "../model/time.ts";

/** 注意力条目 kind → 状态色档:等你/阻塞红,裁决/评审/停滞琥珀,已答复在做青,可归档灰。 */
const ATTENTION_TONE: Record<string, StatusTone> = {
  "awaiting-you": "bad",
  blocked: "bad",
  rework: "wait",
  adjudication: "wait",
  decision: "wait",
  stalled: "wait",
  answered: "active",
  archive: "neutral",
};

type WorkFilter = "attn" | "me" | "blocked" | "moving" | "stale" | "finished" | "all";
type WorkSort = "attn" | "activity" | "progress";

interface WorkEntry {
  readonly group: WorkGroup;
  readonly health: WorkHealth;
}

/**
 * 工作页(S4,dec_B3D40712A6B050D83F1C2EF78D CH1 的「工作」区域放大成整页;交互样张是
 * overview-prototype-v1.html 的「工作」tab):每个工作一行健康摘要——状态分段进度条、
 * 执行/待审/阻塞/计划数、有几件等你、在跑 agent、最后活动、停滞标记。默认只看
 * 「需要关注」,其余折叠成一行;搜索同时匹配工作标题与其下任务标题,命中任务显示在
 * 所属工作下;排序默认用 daemon 议程读面的注意力分(与总览同一序)。数据全部来自
 * App 已挂载的任务切面与议程读面,本页不另发请求。顶部仍是「开始一项工作」的唯一
 * 入口(dec_DC3A1BB9 CH3)。
 */
export function WorkView({
  tasks,
  repoId,
  ready,
  onOpenTask,
  catalog,
  catalogError,
  daemonState,
  onRefreshLedger,
  agenda,
}: {
  readonly tasks: readonly TaskRow[];
  readonly repoId: string;
  readonly ready: boolean;
  readonly onOpenTask: (id: string) => void;
  /** `repo.gui.catalog.snapshot` 同一条投影(App 已挂载);创建向导的选型取值面。 */
  readonly catalog: CatalogSnapshotSuccess | undefined;
  readonly catalogError: string | null;
  readonly daemonState: string;
  readonly onRefreshLedger: () => void;
  /** `repo.agenda.read` 同一条投影(App 已挂载);注意力条目按 workTaskId 归到各工作。 */
  readonly agenda: AgendaSuccess | undefined;
}) {
  const [startWorkOpen, setStartWorkOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<WorkFilter>("attn");
  const [sort, setSort] = useState<WorkSort>("attn");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const collections = useMemo(() => collectWork(tasks), [tasks]);
  const attention = useMemo(() => attentionByWork(agenda?.attentionItems ?? []), [agenda]);
  const now = Date.now();
  const entries: WorkEntry[] = collections.groups.map((group) => ({
    group,
    health: workHealth(group, attention.get(group.task.taskId), now),
  }));
  const query = search.trim().toLocaleLowerCase();
  const matchesText = (task: TaskRow) => `${task.title} ${task.taskId}`.toLocaleLowerCase().includes(query);
  const searchHits = (entry: WorkEntry) =>
    query ? entry.group.members.filter(matchesText) : ([] as readonly TaskRow[]);
  const workMatches = (entry: WorkEntry) => {
    if (!query) return true;
    return matchesText(entry.group.task) || searchHits(entry).length > 0;
  };
  const matchesFilter = (entry: WorkEntry, key: WorkFilter) =>
    key === "all"
      ? true
      : key === "attn"
        ? entry.health.needs
        : key === "me"
          ? entry.health.mine.length > 0
          : key === "blocked"
            ? entry.health.blocked
            : key === "moving"
              ? entry.health.moving
              : key === "stale"
                ? entry.health.stale
                : entry.health.finished;
  const progressOf = (group: WorkGroup) => {
    const effective = group.leaves - (group.counts.cancelled ?? 0);
    return effective > 0 ? (group.counts.done ?? 0) / effective : 0;
  };
  const rows = entries
    .filter((entry) => workMatches(entry) && (query ? true : matchesFilter(entry, filter)))
    .sort((a, b) => {
      if (sort === "activity")
        return (
          b.group.lastChangeAt.localeCompare(a.group.lastChangeAt) ||
          a.group.task.taskId.localeCompare(b.group.task.taskId)
        );
      if (sort === "progress")
        return progressOf(a.group) - progressOf(b.group) || a.group.task.taskId.localeCompare(b.group.task.taskId);
      return (
        b.health.score - a.health.score ||
        b.group.live - a.group.live ||
        Number(b.health.blocked) - Number(a.health.blocked) ||
        Number(b.health.stale) - Number(a.health.stale) ||
        b.group.lastChangeAt.localeCompare(a.group.lastChangeAt) ||
        a.group.task.taskId.localeCompare(b.group.task.taskId)
      );
    });
  const quietCount = !query && filter === "attn" ? entries.length - rows.length : 0;
  const chips: readonly { readonly key: WorkFilter; readonly label: string; readonly count: number }[] = (
    [
      ["attn", t("views.work.filter.attn")],
      ["me", t("views.work.filter.me")],
      ["blocked", t("views.work.filter.blocked")],
      ["moving", t("views.work.filter.moving")],
      ["stale", t("views.work.filter.stale")],
      ["finished", t("views.work.filter.finished")],
      ["all", t("views.work.filter.all")],
    ] as const
  ).map(([key, label]) => ({ key, label, count: entries.filter((entry) => matchesFilter(entry, key)).length }));
  const mineWorks = entries.filter(({ health }) => health.mine.length > 0).length;
  const toggle = (taskId: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  return (
    <div data-testid="work-view" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 md:p-5">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold text-text">工作</h1>
        <span data-testid="work-summary" className="text-sm text-text-muted">
          {t("views.work.summary", { count: entries.length, mine: mineWorks })}
        </span>
        <button
          type="button"
          onClick={() => setStartWorkOpen(true)}
          data-testid="work-start-work"
          className="ml-auto inline-flex items-center gap-1.5 self-center rounded-md border border-accent bg-accent px-2.5 py-1 ui-meta font-medium text-accent-fg hover:opacity-90"
        >
          <Plus weight="bold" aria-hidden />
          {t("views.work.startWork.cta")}
        </button>
      </header>
      {startWorkOpen ? (
        <StartWorkDialog
          repoId={repoId}
          catalog={catalog}
          catalogError={catalogError}
          daemonState={daemonState}
          tasks={tasks}
          onClose={() => setStartWorkOpen(false)}
          onRefreshLedger={onRefreshLedger}
          onOpenTask={(taskId) => {
            setStartWorkOpen(false);
            onOpenTask(taskId);
          }}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-sm text-text">
        <input
          aria-label="搜索工作"
          placeholder={t("views.work.searchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-[220px] flex-1 rounded-xs border border-border bg-surface-raised px-3 py-2"
        />
        <select
          aria-label="工作排序"
          value={sort}
          onChange={(event) => setSort(event.target.value as WorkSort)}
          className="rounded-xs border border-border bg-surface-raised p-2"
        >
          <option value="attn">{t("views.work.sort.attn")}</option>
          <option value="activity">{t("views.work.sort.activity")}</option>
          <option value="progress">{t("views.work.sort.progress")}</option>
        </select>
      </div>
      <div data-testid="work-filter-chips">
        <FilterChips chips={chips} value={filter} onChange={setFilter} />
      </div>
      {!ready ? (
        <p role="status" className="text-sm text-warning">
          {t("views.work.reading")}
        </p>
      ) : null}
      <section className="space-y-1.5">
        {rows.map((entry) => (
          <WorkRow
            key={entry.group.task.taskId}
            entry={entry}
            hits={searchHits(entry)}
            open={expanded.has(entry.group.task.taskId) || searchHits(entry).length > 0}
            ready={ready}
            onToggle={() => toggle(entry.group.task.taskId)}
            onOpen={() => onOpenTask(entry.group.task.taskId)}
          />
        ))}
        {ready && !rows.length && !quietCount ? (
          <p className="text-sm text-text-muted">{t("views.work.empty")}</p>
        ) : null}
        {/* 安静的工作由顶部筛选负责(标准 §2.4「需要关注」默认 + 全部 N 筛选钮),
            不再另设「其余 N 个安静」折叠行(v2 反例:有空间却藏条目)。 */}
      </section>
    </div>
  );
}

function WorkRow({
  entry,
  hits,
  open,
  ready,
  onToggle,
  onOpen,
}: {
  readonly entry: WorkEntry;
  /** 搜索命中的后代任务,显示在所属工作的标题下(样张 v1 的「↳ 命中行」)。 */
  readonly hits: readonly TaskRow[];
  readonly open: boolean;
  readonly ready: boolean;
  readonly onToggle: () => void;
  readonly onOpen: () => void;
}) {
  const { group, health } = entry,
    { task, counts } = group,
    effective = group.leaves - (counts.cancelled ?? 0),
    lastActivity = formatTime(group.lastChangeAt, { style: "month-day-time" }) ?? group.lastChangeAt;
  return (
    <article
      data-testid="work-row"
      data-work-id={task.taskId}
      className="rounded-sm border border-border bg-surface-raised"
    >
      <button
        type="button"
        data-testid="work-row-toggle"
        aria-expanded={open}
        onClick={onToggle}
        className={`flex w-full flex-wrap gap-x-3 gap-y-1.5 px-3 py-2 text-left hover:border-accent/60 ${hits.length > 0 ? "items-start" : "items-center"}`}
      >
        <span className="flex min-w-[220px] flex-1 flex-col gap-1">
          <span className="truncate text-sm font-semibold text-text" title={task.title}>
            <TitleText title={task.title} />
          </span>
          {hits.map((hit) => (
            <span key={hit.taskId} data-testid="work-hit" className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="text-text-faint">
                ↳
              </span>
              <span className="min-w-0 truncate ui-meta text-text" title={hit.title}>
                <TitleText title={hit.title} />
              </span>
              <StatusTag status={(hit.canonicalStatus ?? "unknown") as SnapshotStatus} />
            </span>
          ))}
        </span>
        {ready ? (
          <span data-testid="work-progress" className="flex w-40 shrink-0 flex-col gap-1">
            <SegBar counts={counts as Partial<Record<SnapshotStatus, number>>} />
            <span className="font-mono tabular-nums text-text-muted ui-meta">
              {counts.done ?? 0} / {effective}
            </span>
          </span>
        ) : null}
        <span data-testid="work-flags" className="flex w-60 shrink-0 flex-wrap items-center gap-1">
          {health.mine.length > 0 ? (
            <StatusTag tone="bad" label={t("views.work.flag.mine", { count: health.mine.length })} />
          ) : null}
          {health.blocked ? <StatusTag tone="bad" label={t("views.work.flag.blocked")} /> : null}
          {health.stale ? <StatusTag tone="wait" label={t("views.work.flag.stale")} /> : null}
          {group.live > 0 ? (
            <StatusTag tone="active" label={t("views.work.flag.agents", { count: group.live })} />
          ) : null}
          {health.finished ? <StatusTag tone="neutral" label={t("views.work.flag.finished")} /> : null}
        </span>
        <span
          data-testid="work-last-activity"
          title={
            group.activity ? `${group.activity.taskId} · ${group.activity.summary} · ${lastActivity}` : lastActivity
          }
          className="w-24 shrink-0 text-right font-mono tabular-nums text-text-muted ui-meta"
        >
          {relativeTime(group.lastChangeAt)}
        </span>
      </button>
      {open ? (
        <div data-testid="work-row-body" className="space-y-2 border-t border-border px-3 py-2.5">
          {ready ? (
            <p className="flex flex-wrap gap-x-3 gap-y-1 ui-meta text-text-muted">
              <span>
                {t("views.work.counts.executing")} {counts.active ?? 0}
              </span>
              <span>
                {t("views.work.counts.pending")} {(counts.submitted ?? 0) + (counts.in_review ?? 0)}
              </span>
              <span>
                {t("views.work.counts.blocked")} {counts.blocked ?? 0}
              </span>
              <span>
                {t("views.work.counts.planned")} {counts.planned ?? 0}
              </span>
              <span>
                {t("views.work.counts.done")} {counts.done ?? 0}
              </span>
              <span className="text-text-faint">
                {t("views.work.counts.cancelled")} {counts.cancelled ?? 0}
              </span>
            </p>
          ) : (
            <p className="ui-meta text-text-muted">{t("views.work.reading")}</p>
          )}
          {health.mine.length > 0 ? (
            <div>
              <p className="ui-meta text-text-faint">{t("views.work.mineTitle")}</p>
              {health.mine.map((item) => (
                <DenseRow
                  key={item.ref}
                  tag={
                    <StatusTag
                      tone={ATTENTION_TONE[item.kind] ?? "neutral"}
                      label={t(`views.work.attention.${item.kind}`)}
                    />
                  }
                  title={item.title}
                  time={<span title={t("views.work.scoreTitle")}>{item.attention.score}</span>}
                />
              ))}
            </div>
          ) : (
            <p className="ui-meta text-text-faint">{t("views.work.mineEmpty")}</p>
          )}
          <div>
            <button
              type="button"
              data-testid="work-open"
              onClick={onOpen}
              className="rounded-xs border border-border bg-text/5 px-2.5 py-1 ui-meta text-text hover:bg-text/10"
            >
              {t("views.work.openWork")}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
