import { useMemo, useState } from "react";
import type { TaskRow } from "../model/types.ts";
import { collectWork, type WorkGroup } from "../model/work-collections.ts";
import { ResultPagination } from "../components/ResultPagination.tsx";
import { formatTime } from "../model/time.ts";

export function WorkView({
  tasks,
  projectName,
  ready,
  onOpenGroup,
  onOpenTask,
}: {
  readonly tasks: readonly TaskRow[];
  readonly repoId: string;
  readonly projectName: string;
  readonly ready: boolean;
  readonly onOpenGroup: (id: string) => void;
  readonly onOpenTask: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("unfinished");
  const [sort, setSort] = useState("activity");
  const [groupPage, setGroupPage] = useState(0);
  const [isolatedPage, setIsolatedPage] = useState(0);
  const [showIsolated, setShowIsolated] = useState(false);
  const collections = useMemo(() => collectWork(tasks), [tasks]);
  const matches = (task: TaskRow) =>
    `${task.title} ${task.taskId}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
    (status === "all" ||
      (status === "unfinished"
        ? !["done", "cancelled"].includes(task.canonicalStatus ?? "")
        : task.canonicalStatus === status));
  const groups = collections.groups.filter(({ task }) => matches(task));
  if (sort === "size") groups.sort((a, b) => b.leaves - a.leaves);
  const isolated = collections.isolated.filter(matches);
  const gp = Math.min(groupPage, Math.max(0, Math.ceil(groups.length / 24) - 1));
  const ip = Math.min(isolatedPage, Math.max(0, Math.ceil(isolated.length / 20) - 1));
  const resetPages = () => {
    setGroupPage(0);
    setIsolatedPage(0);
  };
  return (
    <div data-testid="work-view" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 md:p-5">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold text-text">工作</h1>
        <span className="text-sm text-text-muted">当前仓库 · {projectName}</span>
      </header>
      <div className="flex flex-wrap items-center gap-2 text-sm text-text">
        <input
          aria-label="搜索工作"
          placeholder="搜索工作名称或任务…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            resetPages();
          }}
          className="min-w-0 flex-1 rounded border border-border bg-surface-raised px-3 py-2"
        />
        <select
          aria-label="工作状态"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            resetPages();
          }}
          className="rounded border border-border bg-surface-raised p-2"
        >
          {[
            ["unfinished", "未结束"],
            ["all", "全部状态"],
            ["active", "执行中"],
            ["planned", "计划中"],
            ["blocked", "阻塞"],
            ["submitted", "待评审"],
            ["in_review", "评审中"],
            ["done", "已完成"],
            ["cancelled", "已取消"],
          ].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="工作排序"
          value={sort}
          onChange={(event) => {
            setSort(event.target.value);
            resetPages();
          }}
          className="rounded border border-border bg-surface-raised p-2"
        >
          <option value="activity">近期活跃</option>
          <option value="size">任务量 · 可执行叶子</option>
        </select>
      </div>
      <details className="ui-meta text-text-muted">
        <summary className="cursor-pointer">活跃口径：执行 · 评审 · 签发 · 门见证（含后代）</summary>
        <p className="mt-1">
          取本组及全部后代的执行、评审、签发、代码文档见证、门见证时间最大值。有活动的组在前；无活动的组按创建时间倒序在后。任务完成仅计后代叶子，父组不重复计入；取消包含在分母中，不代表交付已获认可。
        </p>
      </details>
      {!ready ? (
        <p role="status" className="text-sm text-warning">
          任务范围仍在读取，分组与数量尚不完整。
        </p>
      ) : null}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text">
          任务组 · {groups.length} / {collections.groups.length}
        </h2>
        <div className="grid min-w-0 gap-2 min-[1101px]:grid-cols-2 min-[1750px]:grid-cols-3">
          {groups.slice(gp * 24, (gp + 1) * 24).map((group) => (
            <WorkGroupCard key={group.task.taskId} group={group} ready={ready} onOpen={onOpenGroup} />
          ))}
        </div>
        {ready && !groups.length ? <p className="text-sm text-text-muted">没有匹配的任务组。</p> : null}
        <ResultPagination label="任务组" page={gp} total={groups.length} size={24} onChange={setGroupPage} />
      </section>
      <section data-testid="isolated-work" className="space-y-2 border-t border-border pt-3">
        <button
          type="button"
          aria-expanded={showIsolated}
          onClick={() => setShowIsolated(!showIsolated)}
          className="text-sm font-semibold text-text"
        >
          {showIsolated ? "收起" : "展开"}独立工作 · {isolated.length} / {collections.isolated.length}
        </button>
        <p className="ui-meta text-text-muted">
          未归入任务组的顶层工作 · 使用上方搜索与状态筛选；历史工作可在“全部状态”中找到。
        </p>
        {showIsolated ? (
          <>
            {isolated.slice(ip * 20, (ip + 1) * 20).map((task) => (
              <button
                type="button"
                key={task.taskId}
                onClick={() => onOpenTask(task.taskId)}
                className="flex w-full items-center justify-between gap-3 border-b border-border py-2 text-left text-sm text-text"
              >
                <span className="min-w-0 break-words">{task.title}</span>
                <span className="shrink-0 text-text-muted">{task.canonicalStatus ?? task.rawStatus}</span>
              </button>
            ))}
            {ready && !isolated.length ? <p className="text-sm text-text-muted">当前没有匹配的独立工作。</p> : null}
            <ResultPagination label="独立工作" page={ip} total={isolated.length} size={20} onChange={setIsolatedPage} />
          </>
        ) : null}
      </section>
    </div>
  );
}

function WorkGroupCard({
  group,
  ready,
  onOpen,
}: {
  readonly group: WorkGroup;
  readonly ready: boolean;
  readonly onOpen: (id: string) => void;
}) {
  const { task, counts, leaves, activity } = group;
  const pending = (counts.submitted ?? 0) + (counts.in_review ?? 0);
  return (
    <button
      type="button"
      data-testid="work-group-card"
      onClick={() => onOpen(task.taskId)}
      className="min-w-0 space-y-2 rounded border border-border bg-surface-raised p-3 text-left hover:border-accent/60"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 break-words text-sm font-semibold text-text" title={task.title}>
          {task.title}
        </h3>
        <span className="shrink-0 ui-meta text-text-muted">{task.canonicalStatus ?? task.rawStatus}</span>
      </div>
      {ready ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 ui-meta text-text-muted">
          <progress
            aria-label={`${task.title} · 任务完成`}
            value={counts.done ?? 0}
            max={leaves || 1}
            className="h-1 min-w-8 flex-1 accent-accent"
          />
          <span>
            {counts.done ?? 0} / {leaves} 叶子
          </span>
          {pending ? <span>待处理 {pending}</span> : null}
          {counts.blocked ? <span>阻塞 {counts.blocked}</span> : null}
          {counts.active ? <span>执行中 {counts.active}</span> : null}
          {counts.cancelled ? <span>取消 {counts.cancelled}</span> : null}
        </div>
      ) : (
        <p className="ui-meta text-text-muted">正在读取完整任务范围…</p>
      )}
      <p
        className="ui-meta text-text-muted"
        title={activity ? `${activity.taskId} · ${activity.summary}` : "无生命周期活动，排在有活动组之后"}
      >
        {activity
          ? `执行 · 评审 · 签发 · 门见证：${formatTime(activity.at, { style: "month-day-time" })}`
          : `暂无活动 · 创建 ${task.createdAt ? formatTime(task.createdAt, { style: "month-day-time" }) : "时间未知"}`}
      </p>
    </button>
  );
}
