import type { WorkspaceScopeRead } from "../../api/renderer-dto.ts";
import type { TaskRow } from "../model/types.ts";
import { deriveAttestationLanes } from "../model/attestation-pool.ts";
import type { TaskMutationFeedback } from "../task-actions.ts";

export interface WorkspaceViewProps {
  readonly scope: WorkspaceScopeRead;
  readonly projectName: string;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenGroup: (taskId: string) => void;
  readonly tasks?: readonly TaskRow[];
  readonly onAttest?: (task: Pick<TaskRow, "taskId">, gateId: string, mode: "approve" | "override") => void;
  readonly onConsent?: (task: TaskRow, reviewId: string) => void;
  readonly feedback?: (taskId: string) => TaskMutationFeedback | undefined;
  readonly onLoadMore?: () => void;
  readonly loadingMore?: boolean;
}

const COUNT_LABELS = {
  done: "已完成",
  executing: "执行中",
  pending: "待处理",
  blocked: "阻塞",
  planned: "计划",
  cancelled: "取消",
} as const;

export function WorkspaceView({
  scope,
  projectName,
  onOpenTask,
  onOpenGroup,
  tasks = [],
  onAttest,
  onConsent,
  feedback,
  onLoadMore,
  loadingMore = false,
}: WorkspaceViewProps) {
  const members = new Set(scope.memberTaskIds),
    scopedTasks = tasks.filter(({ taskId }) => members.has(taskId)),
    lanes = deriveAttestationLanes(scopedTasks);
  return (
    <div data-testid="workspace-view" className="min-h-0 flex-1 overflow-y-auto p-5 md:p-7">
      <div className="mx-auto max-w-6xl space-y-6">
        <nav className="ui-meta text-text-muted" aria-label="工作范围">
          {[projectName, ...scope.ancestors.map(({ title }) => title), scope.root.title].join(" / ")}
        </nav>
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-border px-2 py-0.5 ui-meta text-text-muted">
              {scope.root.taskClass}
            </span>
            <span className="rounded border border-border px-2 py-0.5 ui-meta text-text-muted">
              {scope.root.status}
            </span>
          </div>
          <h1 className="text-2xl font-semibold text-text">{scope.root.title}</h1>
          <p className="text-sm text-text-muted">
            统计范围：{scope.scope.descendantCount} 个后代，{scope.scope.executableLeafCount} 个可执行叶子任务。
            父组与子组不重复计入；取消单列；归档 {scope.scope.archivedCount} 项。
          </p>
          {scope.goalMaterial ? (
            <p className="font-mono ui-meta text-accent">目标与完成条件 · {scope.goalMaterial.path}</p>
          ) : (
            <p className="ui-meta text-text-faint">目标材料未投影</p>
          )}
        </header>

        {scope.status === "pending" || scope.warnings.length ? (
          <div className="rounded border border-warning/50 bg-warning/10 p-3 text-sm text-text">
            范围数据尚未完整：显示 r{scope.watermark}，来源 r{scope.sourceRevision}
            {scope.warnings.length ? ` · ${scope.warnings.join("；")}` : ""}
          </div>
        ) : null}

        <section
          aria-labelledby="workspace-situation"
          className="rounded-lg border border-border bg-surface-raised p-4"
        >
          <h2 id="workspace-situation" className="mb-3 text-sm font-semibold text-text">
            本组现在的局面
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {Object.entries(COUNT_LABELS).map(([key, label]) => (
              <div key={key} className="rounded border border-border bg-surface px-3 py-2">
                <div className="text-xl font-semibold text-text">{scope.counts[key as keyof typeof scope.counts]}</div>
                <div className="ui-meta text-text-muted">{label}</div>
              </div>
            ))}
          </div>
        </section>

        {scope.incompleteParentRefs.length ? (
          <div className="rounded border border-warning/50 bg-warning/10 p-3 text-sm text-text">
            父链不完整：{scope.incompleteParentRefs.join("、")}
          </div>
        ) : null}

        <WorkspacePending
          tasks={scopedTasks}
          lanes={lanes}
          onOpenTask={onOpenTask}
          onAttest={onAttest}
          onConsent={onConsent}
          feedback={feedback}
        />

        <WorkspaceRows title="子组" rows={scope.groups} onOpen={onOpenGroup} />
        <WorkspaceRows title="任务" rows={scope.tasks} onOpen={onOpenTask} />
        {scope.page.nextCursor ? (
          <button
            type="button"
            data-testid="workspace-load-more"
            disabled={loadingMore}
            onClick={onLoadMore}
            className="rounded border border-border bg-surface-raised px-3 py-2 text-sm text-text disabled:opacity-60"
          >
            {loadingMore ? "正在加载…" : "加载更多"}
          </button>
        ) : null}
        <section className="grid gap-3 md:grid-cols-2">
          <EmptyPanel title="关键经过与材料" text="本切片尚未提供范围经过读面。" />
          <EmptyPanel title="依赖与风险" text="本切片尚未提供范围依赖读面。" />
        </section>
      </div>
    </div>
  );
}

function WorkspacePending({
  tasks,
  lanes,
  onOpenTask,
  onAttest,
  onConsent,
  feedback,
}: {
  readonly tasks: readonly TaskRow[];
  readonly lanes: ReturnType<typeof deriveAttestationLanes>;
  readonly onOpenTask: (taskId: string) => void;
  readonly onAttest?: WorkspaceViewProps["onAttest"];
  readonly onConsent?: WorkspaceViewProps["onConsent"];
  readonly feedback?: WorkspaceViewProps["feedback"];
}) {
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const count = lanes.gates.length + lanes.breakGlass.length + lanes.consents.length;
  return (
    <section className="space-y-2" aria-labelledby="workspace-pending">
      <h2 id="workspace-pending" className="text-sm font-semibold text-text">
        需要处理 · {count}
      </h2>
      {count === 0 ? (
        <p className="rounded border border-dashed border-border p-4 text-sm text-text-muted">
          本组当前没有待签发或待收口事项。
        </p>
      ) : (
        <div className="space-y-2">
          {[...lanes.gates, ...lanes.breakGlass].map((item) => {
            const state = feedback?.(item.taskId);
            return (
              <article
                key={`${item.taskId}:${item.gateId}:${item.mode}`}
                className="rounded-lg border border-border bg-surface-raised p-3"
              >
                <button
                  type="button"
                  className="text-left text-sm font-medium text-text"
                  onClick={() => onOpenTask(item.taskId)}
                >
                  {item.taskTitle}
                </button>
                <p className="mt-1 ui-meta text-text-muted">
                  门禁 {item.gateId} · {item.gateStatus} · execution {item.executionId ?? "未知"}
                </p>
                {item.detail ? <p className="mt-1 text-sm text-text-muted">{item.detail}</p> : null}
                <button
                  type="button"
                  disabled={!onAttest || state?.state === "pending"}
                  onClick={() => onAttest?.({ taskId: item.taskId }, item.gateId, item.mode)}
                  className="mt-2 rounded border border-border px-2 py-1 ui-meta text-text disabled:opacity-60"
                >
                  {item.mode === "approve" ? "签注" : "特批放行"}
                </button>
                {state ? (
                  <p className="mt-2 ui-meta text-text-muted">
                    {state.state} · {state.code ?? state.hint}
                  </p>
                ) : null}
              </article>
            );
          })}
          {lanes.consents.map((item) => {
            const task = taskById.get(item.taskId),
              approved = task?.reviews?.find((review) => review.verdict === "approved"),
              state = feedback?.(item.taskId);
            return (
              <article key={`${item.taskId}:consent`} className="rounded-lg border border-border bg-surface-raised p-3">
                <button
                  type="button"
                  className="text-left text-sm font-medium text-text"
                  onClick={() => onOpenTask(item.taskId)}
                >
                  {item.taskTitle}
                </button>
                <p className="mt-1 ui-meta text-text-muted">待同意本轮交付 · review {approved?.reviewId ?? "未投影"}</p>
                <button
                  type="button"
                  disabled={!task || !approved || !onConsent || state?.state === "pending"}
                  onClick={() => task && approved && onConsent?.(task, approved.reviewId)}
                  className="mt-2 rounded border border-border px-2 py-1 ui-meta text-text disabled:opacity-60"
                >
                  同意本轮交付
                </button>
                {state ? (
                  <p className="mt-2 ui-meta text-text-muted">
                    {state.state} · {state.code ?? state.hint}
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function WorkspaceRows({
  title,
  rows,
  onOpen,
}: {
  readonly title: string;
  readonly rows: WorkspaceScopeRead["tasks"];
  readonly onOpen: (taskId: string) => void;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {rows.length ? (
        rows.map((row) => (
          <button
            key={row.taskId}
            type="button"
            onClick={() => onOpen(row.taskId)}
            className="grid w-full grid-cols-[1fr_auto] gap-3 rounded-lg border border-border bg-surface-raised p-3 text-left hover:border-accent/60"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-text">{row.title}</span>
              <span className="block truncate font-mono ui-meta text-text-faint">{row.taskId}</span>
            </span>
            <span className="ui-meta text-text-muted">{row.status}</span>
          </button>
        ))
      ) : (
        <p className="rounded border border-dashed border-border p-4 text-sm text-text-muted">暂无{title}</p>
      )}
    </section>
  );
}

function EmptyPanel({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <section className="rounded-lg border border-dashed border-border p-4">
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      <p className="mt-2 text-sm text-text-muted">{text}</p>
    </section>
  );
}
