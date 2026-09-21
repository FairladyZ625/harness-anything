import { useMemo, useState } from "react";
import type { TaskRow } from "../model/types.ts";
import { useWorkspaceScopeQuery, combineWorkspaceScopePages } from "../workspace-scope-data.ts";

/** Grouping follows projected parent links; it does not infer delivery readiness. */
export function workCollections(tasks: readonly TaskRow[]): { groups: TaskRow[]; isolated: TaskRow[] } {
  const parents = new Set(tasks.flatMap((task) => (task.parentTaskId ? [task.parentTaskId] : [])));
  const groups = tasks.filter((task) => parents.has(task.taskId) || task.taskClass === "milestone");
  const groupIds = new Set(groups.map((task) => task.taskId));
  const isolated = tasks.filter((task) => !task.parentTaskId && !groupIds.has(task.taskId));
  const newest = (a: TaskRow, b: TaskRow) => b.lastKnownAt.localeCompare(a.lastKnownAt);
  return { groups: groups.sort(newest), isolated: isolated.sort(newest) };
}

export function WorkView({
  tasks,
  repoId,
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
  const [limit, setLimit] = useState(12);
  const [isolatedLimit, setIsolatedLimit] = useState(20);
  const collections = useMemo(() => workCollections(tasks), [tasks]);
  const matches = (task: TaskRow) =>
    `${task.title} ${task.taskId}`.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const groups = collections.groups.filter(matches),
    isolated = collections.isolated.filter(matches);
  return (
    <div data-testid="work-view" className="min-h-0 flex-1 space-y-7 overflow-y-auto p-5 md:p-7">
      <header>
        <h1 className="text-2xl font-semibold text-text">工作</h1>
        <p className="mt-2 text-sm text-text-muted">围绕交付目标查看任务组，或继续一项独立工作。</p>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <input
          aria-label="搜索工作"
          placeholder="搜索工作名称或任务…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(12);
            setIsolatedLimit(20);
          }}
          className="min-w-0 flex-1 rounded border border-border bg-surface-raised px-3 py-2 text-sm text-text"
        />
        <span className="rounded border border-border px-3 py-2 text-sm text-text-muted">当前仓库 · {projectName}</span>
      </div>
      {!ready ? (
        <p role="status" className="text-sm text-warning">
          任务范围仍在读取，分组与数量尚不完整。
        </p>
      ) : null}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text">任务组 · {groups.length}</h2>
        <div className="grid min-w-0 gap-4 min-[1101px]:grid-cols-2 min-[1750px]:grid-cols-3">
          {groups.slice(0, limit).map((task) => (
            <WorkGroupCard key={task.taskId} task={task} repoId={repoId} onOpen={onOpenGroup} />
          ))}
        </div>
        {ready && groups.length === 0 ? <p className="text-sm text-text-muted">没有匹配的任务组。</p> : null}
        {groups.length > limit ? (
          <button type="button" onClick={() => setLimit(limit + 12)} className="text-sm text-accent">
            显示更多任务组 ({limit} / {groups.length})
          </button>
        ) : null}
      </section>
      <section data-testid="isolated-work" className="space-y-3 border-t border-border pt-6">
        <h2 className="text-lg font-semibold text-text">独立工作 · {isolated.length}</h2>
        <p className="text-sm text-text-muted">未归入其他任务组的顶层工作。</p>
        {isolated.slice(0, isolatedLimit).map((task) => (
          <button
            type="button"
            key={task.taskId}
            onClick={() => onOpenTask(task.taskId)}
            className="flex w-full items-center justify-between gap-4 border-b border-border py-3 text-left text-sm text-text"
          >
            <span className="min-w-0 break-words">{task.title}</span>
            <span className="shrink-0 text-text-muted">{task.canonicalStatus ?? task.rawStatus}</span>
          </button>
        ))}
        {ready && isolated.length === 0 ? <p className="text-sm text-text-muted">当前没有匹配的独立工作。</p> : null}
        {isolated.length > isolatedLimit ? (
          <button type="button" onClick={() => setIsolatedLimit(isolatedLimit + 20)} className="text-sm text-accent">
            显示更多独立工作 ({isolatedLimit} / {isolated.length})
          </button>
        ) : null}
      </section>
    </div>
  );
}

function WorkGroupCard({
  task,
  repoId,
  onOpen,
}: {
  readonly task: TaskRow;
  readonly repoId: string;
  readonly onOpen: (id: string) => void;
}) {
  const query = useWorkspaceScopeQuery(repoId, task.taskId);
  const scope = combineWorkspaceScopePages(query.data?.pages ?? []);
  return (
    <button
      type="button"
      onClick={() => onOpen(task.taskId)}
      className="min-w-0 space-y-4 rounded-lg border border-border bg-surface-raised p-5 text-left hover:border-accent/60"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="break-words text-base font-semibold text-text">{task.title}</h3>
        <span className="shrink-0 rounded bg-surface px-2 py-1 ui-meta text-text-muted">
          {task.canonicalStatus ?? task.rawStatus}
        </span>
      </div>
      {scope?.status === "ready" ? (
        <>
          <div className="flex items-center gap-3">
            <progress
              aria-label={`${task.title} · 任务完成`}
              value={scope.counts.done}
              max={scope.scope.executableLeafCount || 1}
              className="h-1.5 min-w-0 flex-1 accent-accent"
            />
            <span className="text-sm text-text-muted">
              {scope.counts.done} / {scope.scope.executableLeafCount}
            </span>
          </div>
          <p className="ui-meta text-text-muted">可执行叶子任务 · 取消 {scope.counts.cancelled} 项（包含在分母中）</p>
          <p className="border-t border-border pt-3 text-sm text-text-muted">
            待处理 {scope.counts.pending} · 阻塞 {scope.counts.blocked} · 执行中 {scope.counts.executing}
          </p>
        </>
      ) : (
        <p className="text-sm text-text-muted">{query.isError ? "范围读取失败，打开工作查看" : "正在读取工作进展…"}</p>
      )}
    </button>
  );
}
