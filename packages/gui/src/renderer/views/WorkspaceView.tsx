import type { WorkspaceScopeRead } from "../../api/renderer-dto.ts";

export interface WorkspaceViewProps {
  readonly scope: WorkspaceScopeRead;
  readonly projectName: string;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenGroup: (taskId: string) => void;
}

const COUNT_LABELS = {
  done: "已完成",
  executing: "执行中",
  pending: "待处理",
  blocked: "阻塞",
  planned: "计划",
  cancelled: "取消",
} as const;

export function WorkspaceView({ scope, projectName, onOpenTask, onOpenGroup }: WorkspaceViewProps) {
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

        <WorkspaceRows title="子组" rows={scope.groups} onOpen={onOpenGroup} />
        <WorkspaceRows title="任务" rows={scope.tasks} onOpen={onOpenTask} />
        <section className="grid gap-3 md:grid-cols-2">
          <EmptyPanel title="关键经过与材料" text="本切片尚未提供范围经过读面。" />
          <EmptyPanel title="依赖与风险" text="本切片尚未提供范围依赖读面。" />
        </section>
      </div>
    </div>
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
