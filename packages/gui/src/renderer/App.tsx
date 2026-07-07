import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import type { DomainStatus, TaskProjectionRow } from "../../../kernel/src/index.ts";
import { MOCK_DECISIONS, MOCK_FACTS } from "./mock-triadic-data.ts";
import {
  activeTaskCount,
  commandMessage,
  taskModule,
  useAppendTaskProgressMutation,
  useRebuildGovernanceMutation,
  useReviewTaskMutation,
  useSetTaskStatusMutation,
  useTaskDetailQuery,
  useTaskDocumentQuery,
  useTasksQuery
} from "./task-data.ts";
import {
  DecisionInboxView,
  DecisionMiniCard,
  DecisionPoolView,
  FactInspector,
  GraphView,
  compareDecisionPriority
} from "./triadic-views.tsx";

type ViewId = "overview" | "board" | "list" | "task" | "decisions" | "decisionPool" | "graph";

const navItems: ReadonlyArray<{ readonly id: ViewId; readonly label: string; readonly description: string }> = [
  { id: "overview", label: "Overview", description: "一屏三问" },
  { id: "board", label: "Board", description: "任务流" },
  { id: "list", label: "List", description: "审计表" },
  { id: "task", label: "Task Detail", description: "任务包" },
  { id: "decisions", label: "Decisions", description: "裁决收件箱" },
  { id: "decisionPool", label: "Decision Pool", description: "决策池" },
  { id: "graph", label: "Graph", description: "关系取证" }
];

const taskStatuses: ReadonlyArray<DomainStatus> = ["planned", "active", "blocked", "in_review", "done", "cancelled"];

export function App(): ReactElement {
  const [view, setView] = useState<ViewId>("overview");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedFactId, setSelectedFactId] = useState<string | null>(null);
  const tasksQuery = useTasksQuery();
  const rebuild = useRebuildGovernanceMutation();
  const tasks = tasksQuery.data?.tasks ?? [];
  const warnings = tasksQuery.data?.warnings ?? [];

  useEffect(() => {
    if (!selectedTaskId && tasks[0]) setSelectedTaskId(tasks[0].taskId);
  }, [selectedTaskId, tasks]);

  return (
    <div className="op-shell">
      <aside className="op-sidebar">
        <div className="op-brand">
          <span className="op-brand-mark" aria-hidden="true">HA</span>
          <div>
            <strong>Harness Anything</strong>
            <span>Operator GUI V1</span>
          </div>
        </div>
        <nav className="op-nav" aria-label="Operator views">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`op-nav-item ${view === item.id ? "is-active" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.description}</small>
            </button>
          ))}
        </nav>
        <section className="op-source-panel" aria-label="Data source summary">
          <DataPill tone="real">TASK REAL</DataPill>
          <DataPill tone="mock">DECISION / FACT MOCK</DataPill>
          <p>Task surfaces read and write through <code>window.harness</code>. Triadic projection views stay mock until application read services exist.</p>
        </section>
      </aside>

      <main className="op-main" tabIndex={-1}>
        <header className="op-topbar">
          <div>
            <p className="op-kicker">Local repository workspace</p>
            <h1>{navItems.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="op-topbar-actions" role="status" aria-live="polite">
            <span>{tasksQuery.isFetching ? "Refreshing task projection..." : `${tasks.length} task rows`}</span>
            <button type="button" className="op-button" onClick={() => void rebuild.mutate()} disabled={rebuild.isPending}>
              Rebuild projection
            </button>
          </div>
        </header>

        {tasksQuery.isError ? (
          <BridgeError message={tasksQuery.error instanceof Error ? tasksQuery.error.message : "Unknown task bridge error."} />
        ) : (
          <ViewSwitch
            view={view}
            tasks={tasks}
            warnings={warnings}
            loading={tasksQuery.isLoading}
            selectedTaskId={selectedTaskId}
            onSelectTask={(taskId) => {
              setSelectedTaskId(taskId);
              setView("task");
            }}
            onOpenView={setView}
            onOpenFact={setSelectedFactId}
          />
        )}
      </main>

      <FactInspector factId={selectedFactId} onClose={() => setSelectedFactId(null)} />
    </div>
  );
}

function ViewSwitch(props: {
  readonly view: ViewId;
  readonly tasks: ReadonlyArray<TaskProjectionRow>;
  readonly warnings: ReadonlyArray<{ readonly code: string; readonly message: string; readonly severity: string }>;
  readonly loading: boolean;
  readonly selectedTaskId: string | null;
  readonly onSelectTask: (taskId: string) => void;
  readonly onOpenView: (view: ViewId) => void;
  readonly onOpenFact: (factId: string) => void;
}): ReactElement {
  if (props.loading) {
    return <EmptyState title="Loading task rows from local bridge" body="The renderer is waiting on the sandboxed preload bridge." />;
  }
  if (props.tasks.length === 0 && (props.view === "board" || props.view === "list" || props.view === "task")) {
    return <EmptyState title="No task rows available from the local task bridge." body="This is a real empty state, not prototype filler." testId="task-empty-state" />;
  }

  switch (props.view) {
    case "overview":
      return <OverviewView {...props} />;
    case "board":
      return <BoardView tasks={props.tasks} onSelectTask={props.onSelectTask} />;
    case "list":
      return <ListView tasks={props.tasks} onSelectTask={props.onSelectTask} />;
    case "task":
      return <TaskDetailView taskId={props.selectedTaskId ?? props.tasks[0]?.taskId ?? null} onSelectTask={props.onSelectTask} />;
    case "decisions":
      return <DecisionInboxView onOpenFact={props.onOpenFact} />;
    case "decisionPool":
      return <DecisionPoolView onOpenFact={props.onOpenFact} />;
    case "graph":
      return <GraphView onOpenFact={props.onOpenFact} />;
  }
}

function OverviewView({
  tasks,
  warnings,
  onSelectTask,
  onOpenView,
  onOpenFact
}: {
  readonly tasks: ReadonlyArray<TaskProjectionRow>;
  readonly warnings: ReadonlyArray<{ readonly code: string; readonly message: string; readonly severity: string }>;
  readonly onSelectTask: (taskId: string) => void;
  readonly onOpenView: (view: ViewId) => void;
  readonly onOpenFact: (factId: string) => void;
}): ReactElement {
  const blocked = tasks.filter((task) => task.coordinationStatus === "blocked");
  const review = tasks.filter((task) => task.coordinationStatus === "in_review" || task.closeoutReadiness === "ready");
  const proposed = MOCK_DECISIONS.filter((decision) => decision.state === "proposed")
    .sort(compareDecisionPriority)
    .slice(0, 3);
  const healthFacts = MOCK_FACTS.filter((fact) => fact.state !== "live");

  return (
    <section className="op-overview" aria-label="Overview answers">
      <QuestionPanel
        number="1"
        title="今天要裁什么"
        actionLabel="Open decision inbox"
        onAction={() => onOpenView("decisions")}
        badge={<DataPill tone="mock">MOCK</DataPill>}
      >
        <div className="decision-stack">
          {proposed.map((decision) => (
            <DecisionMiniCard key={decision.id} decision={decision} onOpenFact={onOpenFact} />
          ))}
        </div>
      </QuestionPanel>

      <QuestionPanel
        number="2"
        title="现在在跑什么"
        actionLabel="Open board"
        onAction={() => onOpenView("board")}
        badge={<DataPill tone="real">TASK REAL</DataPill>}
      >
        <div className="metric-grid" data-testid="real-task-summary">
          <Metric label="Active work" value={activeTaskCount(tasks)} />
          <Metric label="Blocked" value={blocked.length} tone={blocked.length > 0 ? "danger" : "default"} />
          <Metric label="In review" value={review.length} />
        </div>
        <TaskShortList tasks={[...blocked, ...review].slice(0, 5)} onSelectTask={onSelectTask} />
      </QuestionPanel>

      <QuestionPanel
        number="3"
        title="什么在风化"
        actionLabel="Open graph"
        onAction={() => onOpenView("graph")}
        badge={<DataPill tone="mixed">MIXED</DataPill>}
      >
        <div className="health-list">
          {warnings.slice(0, 3).map((warning) => (
            <article key={`${warning.code}-${warning.message}`} className="health-row">
              <strong>{warning.code}</strong>
              <span>{warning.message}</span>
            </article>
          ))}
          {healthFacts.map((fact) => (
            <button key={fact.id} type="button" className="health-row is-button" onClick={() => onOpenFact(fact.id)}>
              <strong>{fact.state}</strong>
              <span>{fact.id}</span>
            </button>
          ))}
          {warnings.length === 0 && healthFacts.length === 0 ? (
            <p className="muted">No projection warnings from the task bridge. Mock fact health remains available in Graph.</p>
          ) : null}
        </div>
      </QuestionPanel>
    </section>
  );
}

function BoardView({
  tasks,
  onSelectTask
}: {
  readonly tasks: ReadonlyArray<TaskProjectionRow>;
  readonly onSelectTask: (taskId: string) => void;
}): ReactElement {
  const columns = [
    { id: "open", label: "Open" },
    { id: "blocked", label: "Blocked" },
    { id: "in_review", label: "In review" },
    { id: "terminal", label: "Terminal" },
    { id: "unknown", label: "Unknown" }
  ] as const;

  return (
    <section className="board-grid" aria-label="Task board backed by real task projection">
      {columns.map((column) => {
        const columnTasks = tasks.filter((task) => task.coordinationStatus === column.id);
        return (
          <section key={column.id} className="board-column" aria-labelledby={`board-${column.id}`}>
            <header>
              <h2 id={`board-${column.id}`}>{column.label}</h2>
              <span>{columnTasks.length}</span>
            </header>
            <div className="task-card-stack">
              {columnTasks.map((task) => (
                <TaskCard key={task.taskId} task={task} onSelectTask={onSelectTask} />
              ))}
              {columnTasks.length === 0 ? <p className="muted">No tasks in this lane.</p> : null}
            </div>
          </section>
        );
      })}
    </section>
  );
}

function ListView({
  tasks,
  onSelectTask
}: {
  readonly tasks: ReadonlyArray<TaskProjectionRow>;
  readonly onSelectTask: (taskId: string) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return tasks;
    return tasks.filter((task) => `${task.taskId} ${task.title} ${taskModule(task)} ${task.rawStatus}`.toLowerCase().includes(normalized));
  }, [query, tasks]);

  return (
    <section className="list-view">
      <label className="search-field">
        <span>Filter real task rows</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="task id, title, module, status" />
      </label>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Closeout</th>
              <th>Module</th>
              <th>Freshness</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((task) => (
              <tr key={task.taskId}>
                <td>
                  <button type="button" className="table-task-button" onClick={() => onSelectTask(task.taskId)}>
                    <strong>{task.taskId}</strong>
                    <span>{task.title}</span>
                  </button>
                </td>
                <td><StatusBadge value={task.canonicalStatus} /></td>
                <td>{task.closeoutReadiness}</td>
                <td>{taskModule(task)}</td>
                <td>{task.freshness}</td>
                <td>{formatDate(task.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TaskDetailView({
  taskId,
  onSelectTask
}: {
  readonly taskId: string | null;
  readonly onSelectTask: (taskId: string) => void;
}): ReactElement {
  const detailQuery = useTaskDetailQuery(taskId);
  const [documentPath, setDocumentPath] = useState<string | null>(null);
  const [progressText, setProgressText] = useState("");
  const setStatus = useSetTaskStatusMutation();
  const appendProgress = useAppendTaskProgressMutation();
  const review = useReviewTaskMutation();

  useEffect(() => {
    const firstPath = detailQuery.data?.documents[0]?.path ?? null;
    setDocumentPath((current) => current ?? firstPath);
  }, [detailQuery.data?.documents]);

  const documentQuery = useTaskDocumentQuery(taskId, documentPath);
  const task = detailQuery.data?.task;
  const feedback = commandMessage(setStatus.data ?? appendProgress.data ?? review.data);

  if (!taskId) return <EmptyState title="No task selected" body="Open a task from the board or list." />;
  if (detailQuery.isLoading) return <EmptyState title="Loading task detail" body={taskId} />;
  if (detailQuery.isError || !task) {
    return <BridgeError message={detailQuery.error instanceof Error ? detailQuery.error.message : `Unable to load ${taskId}.`} />;
  }

  return (
    <section className="task-detail-layout">
      <article className="task-detail-main">
        <div className="detail-title-row">
          <div>
            <p className="op-kicker">Task package</p>
            <h2>{task.title}</h2>
            <p className="muted">{task.taskId} · {task.sourcePath}</p>
          </div>
          <DataPill tone="real">TASK REAL</DataPill>
        </div>
        <div className="detail-grid">
          <Field label="Status" value={task.canonicalStatus} />
          <Field label="Coordination" value={task.coordinationStatus} />
          <Field label="Closeout" value={task.closeoutReadiness} />
          <Field label="Module" value={taskModule(task)} />
          <Field label="Engine" value={task.lifecycleEngine} />
          <Field label="Freshness" value={task.freshness} />
        </div>

        <section className="action-panel" aria-label="Task actions">
          <h3>Status transition</h3>
          <div className="button-row">
            {taskStatuses.map((status) => (
              <button
                key={status}
                type="button"
                className="op-button"
                disabled={setStatus.isPending || task.canonicalStatus === status}
                onClick={() => void setStatus.mutate({ taskId: task.taskId, status })}
              >
                {status}
              </button>
            ))}
          </div>
          <button type="button" className="op-button is-primary" disabled={review.isPending} onClick={() => void review.mutate({ taskId: task.taskId })}>
            Move to review
          </button>
        </section>

        <form
          className="action-panel"
          onSubmit={(event) => {
            event.preventDefault();
            if (!progressText.trim()) return;
            appendProgress.mutate({ taskId: task.taskId, text: progressText.trim() });
            setProgressText("");
          }}
        >
          <label>
            <span>Append progress through task bridge</span>
            <textarea value={progressText} onChange={(event) => setProgressText(event.target.value)} rows={4} />
          </label>
          <button type="submit" className="op-button is-primary" disabled={appendProgress.isPending || !progressText.trim()}>
            Append progress
          </button>
          {feedback ? <p className="command-feedback" role="status">{feedback}</p> : null}
        </form>
      </article>

      <aside className="document-panel" aria-label="Task documents">
        <h3>Documents</h3>
        <div className="doc-tabs" role="list">
          {detailQuery.data?.documents.map((document) => (
            <button
              key={document.path}
              type="button"
              className={documentPath === document.path ? "is-active" : ""}
              onClick={() => setDocumentPath(document.path)}
            >
              {document.path}
            </button>
          ))}
        </div>
        <pre className="doc-body">{documentQuery.isLoading ? "Loading document..." : documentQuery.data?.body ?? "Document is not available."}</pre>
        <button type="button" className="link-button" onClick={() => onSelectTask(task.taskId)}>Refresh this task</button>
      </aside>
    </section>
  );
}

function QuestionPanel({
  number,
  title,
  actionLabel,
  onAction,
  badge,
  children
}: {
  readonly number: string;
  readonly title: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
  readonly badge: ReactElement;
  readonly children: ReactElement | ReadonlyArray<ReactElement>;
}): ReactElement {
  return (
    <article className="question-panel">
      <header>
        <span className="question-number">{number}</span>
        <div>
          <h2>{title}</h2>
          {badge}
        </div>
      </header>
      <div className="question-body">{children}</div>
      <button type="button" className="op-button is-primary" onClick={onAction}>{actionLabel}</button>
    </article>
  );
}

function TaskCard({ task, onSelectTask }: { readonly task: TaskProjectionRow; readonly onSelectTask: (taskId: string) => void }): ReactElement {
  return (
    <button type="button" className="task-card" onClick={() => onSelectTask(task.taskId)}>
      <span className="task-card-id">{task.taskId}</span>
      <strong>{task.title}</strong>
      <span>{taskModule(task)} · {task.closeoutReadiness}</span>
      <span className="task-card-footer">{task.lifecycleEngine} · {task.freshness}</span>
    </button>
  );
}

function TaskShortList({ tasks, onSelectTask }: { readonly tasks: ReadonlyArray<TaskProjectionRow>; readonly onSelectTask: (taskId: string) => void }): ReactElement {
  if (tasks.length === 0) return <p className="muted">No blocked or review-ready task rows.</p>;
  return (
    <div className="short-list">
      {tasks.map((task) => (
        <button key={task.taskId} type="button" onClick={() => onSelectTask(task.taskId)}>
          <strong>{task.taskId}</strong>
          <span>{task.title}</span>
        </button>
      ))}
    </div>
  );
}

function DataPill({ tone, children }: { readonly tone: "real" | "mock" | "mixed"; readonly children: string }): ReactElement {
  return <span className={`data-pill is-${tone}`}>{children}</span>;
}

function Metric({ label, value, tone = "default" }: { readonly label: string; readonly value: number; readonly tone?: "default" | "danger" }): ReactElement {
  return (
    <div className={`metric is-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: string | number | undefined }): ReactElement {
  return (
    <div className="field-row">
      <dt>{label}</dt>
      <dd>{value ?? "n/a"}</dd>
    </div>
  );
}

function StatusBadge({ value }: { readonly value: string }): ReactElement {
  return <span className={`status-badge status-${value.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`}>{value}</span>;
}

function EmptyState({ title, body, testId }: { readonly title: string; readonly body: string; readonly testId?: string }): ReactElement {
  return (
    <section className="empty-state" data-testid={testId}>
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  );
}

function BridgeError({ message }: { readonly message: string }): ReactElement {
  return (
    <section className="empty-state is-error" role="alert">
      <h2>Task bridge unavailable</h2>
      <p>{message}</p>
    </section>
  );
}

function formatDate(value: string | undefined): string {
  if (!value) return "n/a";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
