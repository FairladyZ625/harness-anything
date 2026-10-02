import { useMemo, useState, type ReactNode } from "react";
import { Plus } from "@phosphor-icons/react";
import type { SnapshotStatus, TaskRow } from "../model/types.ts";
import type { CatalogSnapshotSuccess } from "../api-client-catalog.ts";
import type { AgendaSuccess } from "../api-client.ts";
import type { AgendaAttentionItem } from "../../api/renderer-dto.ts";
import { StartWorkDialog } from "../components/StartWorkDialog.tsx";
import { t, type MessageKey } from "../i18n/index.tsx";
import {
  attentionByWork,
  collectWork,
  workHealth,
  workTier,
  WORK_TIERS,
  type WorkGroup,
  type WorkHealth,
  type WorkTier,
} from "../model/work-collections.ts";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { SegBar } from "../components/primitives/SegBar.tsx";
import { StatusTag, TONE_COLOR, type StatusTone } from "../components/primitives/StatusTag.tsx";
import {
  CardReason,
  SummaryCard,
  SummaryCardGroup,
  type SummaryCardSize,
} from "../components/primitives/SummaryCard.tsx";
import { splitTitleFocus, TitleText } from "../components/primitives/TitleText.tsx";
import { entryTitle, metaLine, waitingReason } from "./workspace/entry-lines.tsx";
import { formatListTime } from "../model/time.ts";
import { formatTime } from "../model/time.ts";

/** 注意力条目 kind → 状态色档:等你/阻塞红,裁决/评审/停滞琥珀,待跟进琥珀,可归档灰。 */
const ATTENTION_TONE: Record<string, StatusTone> = {
  "awaiting-you": "bad",
  blocked: "bad",
  rework: "wait",
  adjudication: "wait",
  decision: "wait",
  stalled: "wait",
  answered: "wait",
  archive: "neutral",
};

type WorkFilter = "attn" | "me" | "blocked" | "moving" | "stale" | "finished" | "all";
type WorkSort = "attn" | "activity" | "progress";

interface WorkEntry {
  readonly group: WorkGroup;
  readonly health: WorkHealth;
  /** 议程读面里本工作的阻塞/停滞条目;第二行报卡在哪个任务上。 */
  readonly stuck: readonly AgendaAttentionItem[];
}

const DAY_MS = 86_400_000;

/** 三档各用一种卡:要人出手的大卡,正常推进的小卡,可收尾的小方块沉底。 */
const TIER_CARD: Record<WorkTier, { readonly size: SummaryCardSize; readonly title: MessageKey }> = {
  attention: { size: "large", title: "views.work.tier.attention" },
  progress: { size: "small", title: "views.work.tier.progress" },
  closable: { size: "tile", title: "views.work.tier.closable" },
};

/**
 * 工作页(S4,dec_B3D40712A6B050D83F1C2EF78D CH1 的「工作」区域放大成整页):每个工作一张
 * 概况卡,按注意力分三组(互斥)——需要你看的大卡、在推进的小卡、可收尾的小方块。大卡
 * 自上而下:标题与最后活动、为什么要你看、谁在跑、任务构成条与数字、最近一次活动。
 * 筛选默认「全部」(分档已经表达轻重),筛选与排序作用于三组;搜索同时匹配工作标题与
 * 其下任务标题,命中任务显示在所属卡片底部;排序默认用 daemon 议程读面的注意力分(与
 * 总览同一序)。数据全部来自 App 已挂载的任务切面与议程读面,本页不另发请求。顶部仍是
 * 「开始一项工作」的唯一入口(dec_DC3A1BB9 CH3)。
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
  renderHeader,
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
  /** 页头渲染:缺省装「工作 + 结论 + 开始一项工作」;工作台面板可只保留主动作。 */
  readonly renderHeader?: (slot: { readonly startWorkAction: ReactNode }) => ReactNode;
}) {
  const [startWorkOpen, setStartWorkOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [sort, setSort] = useState<WorkSort>("attn");
  const collections = useMemo(() => collectWork(tasks), [tasks]);
  const attention = useMemo(() => attentionByWork(agenda?.attentionItems ?? []), [agenda]);
  const now = Date.now();
  const entries: WorkEntry[] = collections.groups.map((group) => ({
    group,
    health: workHealth(group, attention.get(group.task.taskId), now),
    stuck: attention.get(group.task.taskId)?.stuck ?? [],
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
  const titleOf = (taskId: string) => tasks.find((task) => task.taskId === taskId)?.title;
  const startWorkAction = (
    <button
      type="button"
      onClick={() => setStartWorkOpen(true)}
      data-testid="work-start-work"
      className="ml-auto inline-flex items-center gap-1.5 self-center rounded-md border border-accent bg-accent px-2.5 py-1 ui-meta font-medium text-accent-fg hover:opacity-90"
    >
      <Plus weight="bold" aria-hidden />
      {t("views.work.startWork.cta")}
    </button>
  );
  return (
    <div data-testid="work-view" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 md:p-5">
      {renderHeader !== undefined ? (
        renderHeader({ startWorkAction })
      ) : (
        <header className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-xl font-semibold text-text">工作</h1>
          <span data-testid="work-summary" className="text-sm text-text-muted">
            {t("views.work.summary", { count: entries.length, mine: mineWorks })}
          </span>
          {startWorkAction}
        </header>
      )}
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
      {ready && !rows.length ? <p className="text-sm text-text-muted">{t("views.work.empty")}</p> : null}
      {/* 组与组之间 20–24px(标准 §3);没有成员的组整段不出现。 */}
      <div className="space-y-6 pt-1">
        {WORK_TIERS.map((tier) => {
          const members = rows.filter((entry) => workTier(entry.health) === tier);
          return members.length === 0 ? null : (
            <SummaryCardGroup
              key={tier}
              size={TIER_CARD[tier].size}
              title={t(TIER_CARD[tier].title)}
              count={members.length}
              testId={`work-tier-${tier}`}
            >
              {members.map((entry) => (
                <WorkCard
                  key={entry.group.task.taskId}
                  entry={entry}
                  size={TIER_CARD[tier].size}
                  titleOf={titleOf}
                  hits={searchHits(entry)}
                  ready={ready}
                  now={now}
                  onOpen={() => onOpenTask(entry.group.task.taskId)}
                />
              ))}
            </SummaryCardGroup>
          );
        })}
      </div>
    </div>
  );
}

interface WorkReason {
  readonly tone: StatusTone;
  readonly label: string;
  readonly text: string | undefined;
}

/**
 * 为什么要你看:等你 > 阻塞 > 停滞,几句都成立就都写,各占一行。等你报第一件事(多件带
 * 「另 N 件」);阻塞报第一个带阻塞贡献的任务,读不到贡献就报议程里的阻塞条目,再不然报
 * 第一个处于阻塞状态的任务——已经报了「等你」时不重复同一条 awaits 边或同一个任务。
 */
function workReasons(
  { group, health, stuck }: WorkEntry,
  titleOf: (taskId: string) => string | undefined,
  now: number,
): readonly WorkReason[] {
  const reasons: WorkReason[] = [],
    mine = health.mine[0];
  if (mine !== undefined)
    reasons.push({
      tone: ATTENTION_TONE[mine.kind] ?? "bad",
      label: t(`views.work.attention.${mine.kind}` as MessageKey),
      text:
        health.mine.length > 1
          ? t("views.work.reason.more", { text: mine.title, count: health.mine.length - 1 })
          : mine.title,
    });
  if (health.blocked) {
    const blockersOf = ({ blockers }: TaskRow) =>
        (blockers ?? []).filter(({ kind }) => mine === undefined || kind === "depends-on"),
      blockedTask = [group.task, ...group.members].find((row) => blockersOf(row).length > 0),
      blockedTitle =
        stuck.find(({ kind, title }) => kind === "blocked" && title !== mine?.title)?.title ??
        group.members.find(({ canonicalStatus, title }) => canonicalStatus === "blocked" && title !== mine?.title)
          ?.title;
    reasons.push({
      tone: "bad",
      label: t("views.work.flag.blocked"),
      text:
        blockedTask !== undefined
          ? waitingReason(blockersOf(blockedTask), titleOf)
          : blockedTitle === undefined
            ? undefined
            : splitTitleFocus(blockedTitle).focus,
    });
  }
  if (health.stale) {
    const days = Math.floor((now - Date.parse(group.lastChangeAt)) / DAY_MS);
    reasons.push({
      tone: "wait",
      label: t("views.work.flag.stale"),
      text: days >= 1 ? t("views.work.reason.staleDays", { days }) : undefined,
    });
  }
  return reasons;
}

/** 构成数字的顺序与颜色:与 SegBar 的分段同序同色,为 0 的不显示。 */
const COUNT_PARTS: readonly {
  readonly key: MessageKey;
  readonly tone: StatusTone;
  readonly statuses: readonly SnapshotStatus[];
}[] = [
  { key: "views.work.counts.done", tone: "done", statuses: ["done"] },
  { key: "views.work.counts.executing", tone: "active", statuses: ["active"] },
  { key: "views.work.counts.pending", tone: "wait", statuses: ["submitted", "in_review"] },
  { key: "views.work.counts.blocked", tone: "bad", statuses: ["blocked"] },
  { key: "views.work.counts.planned", tone: "plan", statuses: ["planned"] },
];

function WorkCard({
  entry,
  size,
  titleOf,
  hits,
  ready,
  now,
  onOpen,
}: {
  readonly entry: WorkEntry;
  readonly size: SummaryCardSize;
  /** 卡住本工作的任务可能在工作之外,标题从全仓任务切面查。 */
  readonly titleOf: (taskId: string) => string | undefined;
  /** 搜索命中的后代任务,显示在所属卡片底部(样张 v1 的「↳ 命中行」)。 */
  readonly hits: readonly TaskRow[];
  readonly ready: boolean;
  readonly now: number;
  readonly onOpen: () => void;
}) {
  const { group } = entry,
    { task, counts } = group,
    done = counts.done ?? 0,
    effective = group.leaves - (counts.cancelled ?? 0),
    lastActivity = formatTime(group.lastChangeAt, { style: "month-day-time" }) ?? group.lastChangeAt,
    { focus, supplement } = entryTitle(task.title),
    reasons = size === "large" ? workReasons(entry, titleOf, now) : [],
    all = [task, ...group.members],
    // 第一个在跑的任务:与 `group.live` 同一判据。执行者的名字本页读不到,不写机器标识。
    runner = all.find(({ activeExecutionId }) => activeExecutionId !== undefined),
    // 最近有动静的任务:只报它的标题,不显示生命周期事件的机器摘要。
    recent = all.find(({ taskId }) => taskId === group.activity?.taskId),
    ago = (
      <span
        data-testid="work-last-activity"
        title={group.activity ? `${group.activity.taskId} · ${group.activity.summary} · ${lastActivity}` : lastActivity}
      >
        {formatListTime(group.lastChangeAt)}
      </span>
    ),
    progress = (
      <span className="font-mono tabular-nums text-text-muted ui-meta">
        {done}/{effective}
      </span>
    );
  return (
    <SummaryCard
      size={size}
      testId="work-row"
      attrs={{ "data-work-id": task.taskId }}
      title={focus}
      subtitle={size === "large" ? supplement : undefined}
      aside={size === "tile" ? undefined : ago}
      tone={reasons[0]?.tone}
      onOpen={onOpen}
    >
      {reasons.length > 0 ? (
        <div data-testid="work-flags" className="space-y-1.5">
          {reasons.map((reason) => (
            <CardReason key={reason.label} tone={reason.tone} label={reason.label}>
              {reason.text}
            </CardReason>
          ))}
        </div>
      ) : null}
      {size === "large" && group.live > 0 ? (
        <p data-testid="work-running" className="flex min-w-0 items-center gap-2 text-text-muted ui-meta">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-active" />
          <span className="min-w-0 truncate">
            {metaLine([
              t("views.work.running", { count: group.live }),
              runner === undefined ? undefined : splitTitleFocus(runner.title).focus,
            ])}
          </span>
        </p>
      ) : null}
      {size === "tile" ? (
        <p className="flex min-w-0 items-center gap-1.5 font-mono tabular-nums text-text-faint ui-meta">
          {ready ? <span data-testid="work-progress">{`${done}/${effective}`}</span> : null}
          {ready ? <span aria-hidden>·</span> : null}
          {ago}
        </p>
      ) : ready ? (
        <>
          <div data-testid="work-progress" className="flex items-center gap-2.5">
            <SegBar
              counts={counts as Partial<Record<SnapshotStatus, number>>}
              // 构成条在卡上加粗(SegBar 默认 h-1,根字号 14px 下是 3.5px):大卡 6px,小卡 4px。
              className={`min-w-0 flex-1 ${size === "large" ? "h-[6px]!" : "h-[4px]!"}`}
            />
            {progress}
          </div>
          {size === "large" ? (
            <p data-testid="work-counts" className="flex flex-wrap gap-x-3 gap-y-0.5 text-text-muted ui-meta">
              {COUNT_PARTS.map(({ key, tone, statuses }) => {
                const count = statuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
                return count === 0 ? null : (
                  <span key={key}>
                    {t(key)}{" "}
                    <b className="font-mono font-semibold tabular-nums" style={{ color: TONE_COLOR[tone] }}>
                      {count}
                    </b>
                  </span>
                );
              })}
            </p>
          ) : (
            <p className="truncate text-text-faint ui-meta">
              {group.live > 0
                ? t("views.work.running", { count: group.live })
                : metaLine([
                    (counts.planned ?? 0) > 0 ? `${t("views.work.counts.planned")} ${counts.planned ?? 0}` : undefined,
                    t("views.work.idle"),
                  ])}
            </p>
          )}
        </>
      ) : null}
      {size === "large" && recent !== undefined ? (
        <p data-testid="work-recent" className="truncate text-text-faint ui-meta">
          {t("views.work.recent", { title: splitTitleFocus(recent.title).focus })}
        </p>
      ) : null}
      {hits.length > 0 ? (
        <div className="space-y-1 border-t border-border pt-2">
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
        </div>
      ) : null}
    </SummaryCard>
  );
}
