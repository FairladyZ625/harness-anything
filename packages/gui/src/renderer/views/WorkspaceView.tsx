import { ResultPagination } from "../components/ResultPagination.tsx";
import type { WorkspaceScopeRead } from "../../api/renderer-dto.ts";
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types.ts";
import { deriveAttestationLanes } from "../model/attestation-pool.ts";
import type { TaskMutationFeedback } from "../task-actions.ts";
import { useCadenceFeed } from "../cadence-feed.ts";
import { artifactsClient } from "../artifacts-client.ts";
import { workspaceGraphSlice, workspaceEvidenceOf } from "../model/workspace-evidence.ts";
import { eventTypeLabel, workspaceTitleIndex } from "../model/workspace-readable.ts";
import { formatTime } from "../model/time.ts";
import { EgoNeighborhood } from "../graph/EgoNeighborhood.tsx";
import { egoFactRefOf } from "../graph/egoCanvas.ts";
import { WorkspaceGoal } from "../components/WorkspaceGoal.tsx";
import { t } from "../i18n/index.tsx";

export interface WorkspaceViewProps {
  readonly scope: WorkspaceScopeRead;
  readonly repoId?: string;
  readonly projectName: string;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenGroup: (taskId: string) => void;
  readonly tasks?: readonly TaskRow[];
  readonly decisions?: readonly DecisionRow[];
  readonly facts?: readonly FactRef[];
  readonly relations?: readonly RelationEdge[];
  readonly onNavigateEntity?: (ref: string) => void;
  /** 图抽屉里的置顶开关。关系图页早已传它;不传,工作页的同一个抽屉就静默少一个动作。 */
  readonly onSetTaskPin?: (task: TaskRow, pinned: boolean) => void;
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
  repoId = "unselected",
  projectName,
  onOpenTask,
  onOpenGroup,
  tasks = [],
  decisions = [],
  facts = [],
  relations = [],
  onNavigateEntity,
  onSetTaskPin,
  onAttest,
  onConsent,
  feedback,
  onLoadMore,
  loadingMore = false,
}: WorkspaceViewProps) {
  const [tab, setTab] = useState("overview");
  const [focusRef, setFocusRef] = useState(`task/${scope.root.taskId}`);
  const [graphStats, setGraphStats] = useState({ nodes: 0, edges: 0, focusLabel: null as string | null });
  const onGraphStats = useCallback((next: typeof graphStats) => {
    setGraphStats((current) =>
      current.nodes === next.nodes && current.edges === next.edges && current.focusLabel === next.focusLabel
        ? current
        : next,
    );
  }, []);
  const graph = useMemo(() => {
    const slice = workspaceGraphSlice([scope.root.taskId, ...scope.memberTaskIds], relations);
    const refs = new Set(slice.nodeRefs);
    return {
      tasks: tasks.filter(({ taskId }) => refs.has(`task/${taskId}`)),
      decisions: decisions.filter(({ decisionId }) => refs.has(`decision/${decisionId}`)),
      facts: facts.filter((fact) => refs.has(egoFactRefOf(fact))),
      relations: [...slice.edges],
    };
  }, [scope.root.taskId, scope.memberTaskIds, tasks, decisions, facts, relations]);
  const members = new Set(scope.memberTaskIds),
    scopedTasks = tasks.filter(({ taskId }) => members.has(taskId)),
    lanes = deriveAttestationLanes(scopedTasks),
    // 标题只从本视图已经拿到的投影行里查,不为了可读性多开一个读面。
    titles = useMemo(
      () =>
        workspaceTitleIndex({
          tasks: [scope.root, ...scope.ancestors, ...scope.groups, ...scope.tasks, ...tasks],
          facts,
          decisions,
        }),
      [scope, tasks, facts, decisions],
    );
  return (
    <div data-testid="workspace-view" className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
      <div className="min-w-0 space-y-3">
        <nav className="ui-meta text-text-muted" aria-label="工作范围">
          {[projectName, ...scope.ancestors.map(({ title }) => title), scope.root.title].join(" / ")}
        </nav>
        <header className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="min-w-0 break-words text-xl font-semibold text-text">{scope.root.title}</h1>
            <span className="ui-meta text-text-muted">
              {scope.root.taskClass} · {scope.root.status}
            </span>
            <span className="text-sm text-text-muted">
              任务完成{" "}
              <strong className="text-text">
                {scope.counts.done} / {scope.scope.executableLeafCount}
              </strong>
            </span>
            <span className="text-sm text-text-muted">
              等待处理 {lanes.gates.length + lanes.breakGlass.length + lanes.consents.length}
            </span>
          </div>
          <details key={tab} open={tab === "overview"} className="ui-meta text-text-muted">
            <summary className="cursor-pointer">统计口径与范围</summary>
            <p>
              统计范围：{scope.scope.descendantCount} 个后代，{scope.scope.executableLeafCount} 个可执行叶子任务。
              父组与子组不重复计入；取消单列；归档 {scope.scope.archivedCount} 项。
            </p>
          </details>
        </header>

        {scope.status === "pending" || scope.warnings.length ? (
          <div className="rounded border border-warning/50 bg-warning/10 p-3 text-sm text-text">
            范围数据尚未完整：显示 r{scope.watermark}，来源 r{scope.sourceRevision}
            {scope.warnings.length ? ` · ${scope.warnings.join("；")}` : ""}
          </div>
        ) : null}

        {scope.incompleteParentRefs.length ? (
          <div className="rounded border border-warning/50 bg-warning/10 p-3 text-sm text-text">
            父链不完整：{scope.incompleteParentRefs.join("、")}
          </div>
        ) : null}

        <div role="tablist" aria-label="工作分区" className="flex gap-6 overflow-x-auto border-b border-border">
          {[
            ["overview", "概览"],
            ["tasks", `任务 ${scope.scope.executableLeafCount}`],
            ["evidence", "经过与证据"],
            ["relations", "关系"],
          ].map(([id, label]) => (
            <button
              key={id}
              id={`workspace-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls="workspace-panel"
              onClick={() => setTab(id)}
              className={`shrink-0 border-b-2 pb-2 text-sm ${tab === id ? "border-accent text-accent" : "border-transparent text-text-muted"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          id="workspace-panel"
          role="tabpanel"
          aria-labelledby={`workspace-tab-${tab}`}
          className={
            tab === "overview"
              ? "grid min-w-0 gap-9 min-[1101px]:grid-cols-[minmax(0,1fr)_314px] min-[1750px]:grid-cols-[minmax(0,1fr)_370px]"
              : "min-w-0"
          }
        >
          <div className="min-w-0 space-y-6">
            {tab === "overview" ? (
              <>
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
                        <div className="text-xl font-semibold text-text">
                          {scope.counts[key as keyof typeof scope.counts]}
                        </div>
                        <div className="ui-meta text-text-muted">{label}</div>
                      </div>
                    ))}
                  </div>
                </section>

                <WorkspacePending
                  tasks={scopedTasks}
                  lanes={lanes}
                  onOpenTask={onOpenTask}
                  onAttest={onAttest}
                  onConsent={onConsent}
                  feedback={feedback}
                />
                <WorkspaceRows
                  title="正在推进"
                  rows={scope.tasks.filter(({ status }) => status === "active" || status === "blocked")}
                  onOpen={onOpenTask}
                />
                <button type="button" className="text-sm text-accent" onClick={() => setTab("tasks")}>
                  查看全部任务 →
                </button>
              </>
            ) : null}
            {tab === "tasks" ? (
              <>
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
              </>
            ) : null}
            {tab === "evidence" && repoId !== "unselected" ? (
              <WorkspaceEvidenceSections
                repoId={repoId}
                memberTaskIds={scope.memberTaskIds}
                decisions={decisions}
                facts={facts}
                relations={relations}
                titles={titles}
                onNavigateEntity={onNavigateEntity}
              />
            ) : null}
            <section hidden={tab !== "relations"} className="space-y-2" aria-labelledby="workspace-graph">
              <h2 id="workspace-graph" className="sr-only">
                {t("views.workspace.localGraph")}
              </h2>
              <p className="text-sm text-text-muted">
                {t("views.workspace.localGraphNote")} · {graphStats.nodes} 节点 / {graphStats.edges} 关系。
                单击展开，双击设为画布中心；详情打开实体。
              </p>
              <div
                data-testid="workspace-graph-scroll"
                className="max-w-full overflow-x-auto rounded-lg border border-border"
              >
                <div data-testid="workspace-graph-canvas" className="h-[calc(100vh-240px)] min-h-[420px] min-w-[52rem]">
                  <EgoNeighborhood
                    {...graph}
                    focusRef={focusRef}
                    factAnchors={[]}
                    onNavigateEntity={onNavigateEntity}
                    onSetTaskPin={onSetTaskPin}
                    onRefocus={setFocusRef}
                    onLayoutStats={onGraphStats}
                    active={tab === "relations"}
                  />
                </div>
              </div>
            </section>
          </div>
          {tab === "overview" ? (
            <aside data-testid="workspace-sidebar" className="min-w-0 space-y-8">
              <WorkspaceGoal scope={scope} repoId={repoId} onOpenTask={onOpenTask} />
              <section className="space-y-3">
                <h2 className="text-sm font-semibold text-text">参与执行</h2>
                {scopedTasks.filter((task) => task.canonicalStatus === "active").length ? (
                  scopedTasks
                    .filter((task) => task.canonicalStatus === "active")
                    .map((task) => (
                      <button
                        key={task.taskId}
                        type="button"
                        onClick={() => onOpenTask(task.taskId)}
                        className="block w-full break-words border-b border-border pb-3 text-left text-sm text-text"
                      >
                        {task.title}
                        <span className="mt-1 block text-text-muted">
                          任务执行中 · {task.leaseHolder ?? "执行者未投影"}
                        </span>
                      </button>
                    ))
                ) : (
                  <p className="text-sm text-text-muted">当前没有执行中的任务。</p>
                )}
              </section>
              {repoId !== "unselected" ? (
                <WorkspaceEvidenceSections
                  historyOnly
                  repoId={repoId}
                  memberTaskIds={scope.memberTaskIds}
                  decisions={decisions}
                  facts={facts}
                  relations={relations}
                  titles={titles}
                  onNavigateEntity={onNavigateEntity}
                />
              ) : null}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function WorkspaceEvidenceSections({
  historyOnly = false,
  repoId,
  memberTaskIds,
  decisions,
  facts,
  relations,
  titles,
  onNavigateEntity,
}: {
  readonly historyOnly?: boolean;
  readonly repoId: string;
  readonly memberTaskIds: readonly string[];
  readonly decisions: readonly DecisionRow[];
  readonly facts: readonly FactRef[];
  readonly relations: readonly RelationEdge[];
  readonly titles: ReadonlyMap<string, string>;
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const feed = useCadenceFeed(repoId),
    artifactsQuery = useQuery({
      queryKey: ["artifacts", repoId, "md"],
      queryFn: () => artifactsClient.list(repoId, "md"),
      staleTime: 10_000,
      enabled: !historyOnly,
    }),
    evidence = useMemo(
      () =>
        workspaceEvidenceOf({
          memberTaskIds,
          events: feed.events,
          decisions,
          facts,
          relations,
          artifacts: artifactsQuery.data?.artifacts ?? [],
        }),
      [memberTaskIds, feed.events, decisions, facts, relations, artifactsQuery.data],
    );
  return (
    <>
      <WorkspaceHistory
        evidence={historyOnly ? { ...evidence, events: evidence.events.slice(0, 3) } : evidence}
        feed={feed}
        titles={titles}
        onNavigateEntity={onNavigateEntity}
      />
      {historyOnly ? null : <WorkspaceEvidencePanel evidence={evidence} onNavigateEntity={onNavigateEntity} />}
    </>
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

const WORKSPACE_HISTORY_ROWS = 40;

function WorkspaceHistory({
  evidence,
  feed,
  titles,
  onNavigateEntity,
}: {
  readonly evidence: ReturnType<typeof workspaceEvidenceOf>;
  readonly feed: ReturnType<typeof useCadenceFeed>;
  readonly titles: ReadonlyMap<string, string>;
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(evidence.events.length / WORKSPACE_HISTORY_ROWS) - 1));
  const rows = evidence.events.slice(currentPage * WORKSPACE_HISTORY_ROWS, (currentPage + 1) * WORKSPACE_HISTORY_ROWS),
    // 「只有索引、没有正文」是整个窗口的一个性质,不是每一行各自的新闻:整段至多说一次。
    anyPayloadLess = rows.some(({ summary }) => summary === null);
  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4" aria-labelledby="workspace-history">
      <h2 id="workspace-history" className="text-sm font-semibold text-text">
        {t("views.workspace.history")}
      </h2>
      <p className="mt-1 ui-meta text-text-muted">
        {t("views.workspace.eventWindow", {
          mode: feed.mode ?? t("views.workspace.sourcePending"),
          coverage: t(feed.historyComplete ? "views.workspace.windowComplete" : "views.workspace.windowPartial"),
        })}
      </p>
      {anyPayloadLess ? <p className="mt-1 ui-meta text-text-muted">{t("views.workspace.payloadMissing")}</p> : null}
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">{t("views.workspace.historyEmpty")}</p>
      ) : (
        <ol className="mt-3">
          {rows.map((event, index) => {
            const taskRef = event.taskId === null ? null : `task/${event.taskId}`,
              // 标题在读面里就用标题,没有就如实退回原始 task id——不猜。
              taskName = (taskRef === null ? undefined : titles.get(taskRef)) ?? event.taskId;
            return (
              <li key={event.key} className="min-w-0">
                {index === 0 || event.at?.slice(0, 10) !== rows[index - 1]?.at?.slice(0, 10) ? (
                  <p className="border-b border-border py-2 ui-meta font-semibold text-text-muted">
                    {event.at?.slice(0, 10) ?? t("views.workspace.timeMissing")}
                  </p>
                ) : null}
                <div className="flex items-baseline gap-3 border-b border-border/50 py-1.5">
                  <time className="shrink-0 font-mono ui-meta text-text-muted">
                    {event.at ? formatTime(event.at, { style: "month-day-time" }) : "—"}
                  </time>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      title={`${event.type} · ${event.taskId ?? ""}`}
                      className="block w-full break-words text-left text-sm text-text"
                      onClick={() => taskRef !== null && onNavigateEntity?.(taskRef)}
                    >
                      <span className="font-medium">{eventTypeLabel(event.type)}</span>
                      <span className="text-text-muted"> · {taskName ?? t("views.workspace.entityMissing")}</span>
                    </button>
                    {event.summary === null ? null : (
                      <details className="ui-meta text-text-muted">
                        <summary className="cursor-pointer">查看记录摘要</summary>
                        <p className="break-words py-1 text-sm">{event.summary}</p>
                      </details>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <ResultPagination
        label="经过"
        page={currentPage}
        total={evidence.events.length}
        size={WORKSPACE_HISTORY_ROWS}
        onChange={setPage}
      />
    </section>
  );
}

function WorkspaceEvidencePanel({
  evidence,
  onNavigateEntity,
}: {
  readonly evidence: ReturnType<typeof workspaceEvidenceOf>;
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4" aria-labelledby="workspace-evidence">
      <h2 id="workspace-evidence" className="text-sm font-semibold text-text">
        {t("views.workspace.evidence")}
      </h2>
      <div className="mt-3 min-w-0 space-y-2">
        <EvidenceList
          title={t("views.workspace.decisions")}
          rows={evidence.decisions.map((row) => ({
            ref: `decision/${row.decisionId}`,
            title: row.title,
            meta: row.state,
          }))}
          onOpen={onNavigateEntity}
        />
        <EvidenceList
          title={t("views.workspace.facts")}
          rows={evidence.facts.map((row) => ({
            ref: row.anchor,
            title: row.text,
            meta: row.invalidated
              ? t("views.workspace.superseded")
              : row.archived
                ? t("views.workspace.archived")
                : row.confidence,
          }))}
          onOpen={onNavigateEntity}
        />
        <EvidenceList
          title={t("views.workspace.artifacts")}
          rows={evidence.artifacts.map((row) => ({
            ref: row.taskId ? `task/${row.taskId}` : row.path,
            title: row.path,
            meta: `${row.timeSource} · ${row.time}`,
          }))}
          onOpen={onNavigateEntity}
        />
      </div>
      {evidence.missingRefs.length ? (
        <p className="mt-3 break-words text-sm text-warning">
          {t("views.workspace.missingRefs", { refs: evidence.missingRefs.join("、") })}
        </p>
      ) : null}
    </section>
  );
}

function EvidenceList({
  title,
  rows,
  onOpen,
}: {
  readonly title: string;
  readonly rows: readonly { ref: string; title: string; meta: string }[];
  readonly onOpen?: (ref: string) => void;
}) {
  const [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  return (
    <details className="min-w-0 border-b border-border pb-2">
      <summary className="cursor-pointer text-sm font-semibold text-text">
        {title} · {rows.length}
      </summary>
      {rows.length ? (
        <ul className="mt-2">
          {rows.slice(currentPage * 20, (currentPage + 1) * 20).map((row) => (
            <li key={`${row.ref}:${row.title}`} className="min-w-0 border-t border-border/50 py-2">
              <details className="min-w-0">
                <summary className="cursor-pointer break-words text-sm text-text">
                  {row.title.length > 100 ? `${row.title.slice(0, 100)}…` : row.title}
                </summary>
                <p className="my-2 break-words text-sm text-text-muted">{row.title}</p>
                <button type="button" className="text-sm text-accent" onClick={() => onOpen?.(row.ref)}>
                  打开来源 →
                </button>
              </details>
              <p className="break-words ui-meta text-text-muted">{row.meta}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-text-muted">{t("views.workspace.none")}</p>
      )}
      <ResultPagination label={title} page={currentPage} total={rows.length} size={20} onChange={setPage} />
    </details>
  );
}
