import type { WorkspaceScopeRead } from "../../api/renderer-dto.ts";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types.ts";
import { deriveAttestationLanes } from "../model/attestation-pool.ts";
import type { TaskMutationFeedback } from "../task-actions.ts";
import { useCadenceFeed } from "../cadence-feed.ts";
import { artifactsClient } from "../artifacts-client.ts";
import { normalizedRef, workspaceEvidenceOf, workspaceGraphSlice } from "../model/workspace-evidence.ts";
import {
  eventTypeLabel,
  relationKindLabel,
  workspaceNodeLabel,
  workspaceNodeText,
  workspaceTitleIndex,
} from "../model/workspace-readable.ts";
import { formatTime } from "../model/time.ts";
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
  onAttest,
  onConsent,
  feedback,
  onLoadMore,
  loadingMore = false,
}: WorkspaceViewProps) {
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
        {repoId === "unselected" ? null : (
          <WorkspaceEvidenceSections
            repoId={repoId}
            memberTaskIds={scope.memberTaskIds}
            decisions={decisions}
            facts={facts}
            relations={relations}
            titles={titles}
            onNavigateEntity={onNavigateEntity}
          />
        )}
      </div>
    </div>
  );
}

function WorkspaceEvidenceSections({
  repoId,
  memberTaskIds,
  decisions,
  facts,
  relations,
  titles,
  onNavigateEntity,
}: {
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
      <WorkspaceHistory evidence={evidence} feed={feed} titles={titles} onNavigateEntity={onNavigateEntity} />
      <WorkspaceEvidencePanel evidence={evidence} onNavigateEntity={onNavigateEntity} />
      <WorkspaceLocalGraph
        memberTaskIds={memberTaskIds}
        relations={relations}
        titles={titles}
        onNavigateEntity={onNavigateEntity}
      />
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
  const rows = evidence.events.slice(0, WORKSPACE_HISTORY_ROWS),
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
        <ol className="mt-3 space-y-2">
          {rows.map((event) => {
            const taskRef = event.taskId === null ? null : `task/${event.taskId}`,
              // 标题在读面里就用标题,没有就如实退回原始 task id——不猜。
              taskName = (taskRef === null ? undefined : titles.get(taskRef)) ?? event.taskId;
            return (
              <li key={event.key} className="rounded border border-border bg-surface p-3">
                <button
                  type="button"
                  title={`${event.type}${event.taskId === null ? "" : ` · ${event.taskId}`}`}
                  className="block w-full break-words text-left text-sm text-text"
                  onClick={() => taskRef !== null && onNavigateEntity?.(taskRef)}
                >
                  <span className="font-medium">{eventTypeLabel(event.type)}</span>
                  <span className="text-text-muted">
                    {" · "}
                    {taskName ?? t("views.workspace.entityMissing")}
                  </span>
                </button>
                {event.summary === null ? null : (
                  <p className="mt-1 break-words text-sm text-text-muted">{event.summary}</p>
                )}
                <p className="mt-1 ui-meta text-text-faint">
                  {event.at ? formatTime(event.at, { style: "month-day-time" }) : t("views.workspace.timeMissing")}
                </p>
              </li>
            );
          })}
        </ol>
      )}
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
      <div className="mt-3 grid min-w-0 gap-4 md:grid-cols-3">
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
  // 正文里的长无空格串(`start/progress.append/submit/…`、产物路径)曾把自己的列撑宽、
  // 压到右边那列上。min-w-0 让列不被 min-content 顶开,块级按钮 + break-words 让串在本列内断行。
  return (
    <div className="min-w-0">
      <h3 className="ui-meta font-semibold text-text-muted">{title}</h3>
      {rows.length ? (
        <ul className="mt-2 space-y-2">
          {rows.map((row) => (
            <li key={`${row.ref}:${row.title}`} className="min-w-0">
              <button
                type="button"
                className="block w-full break-words text-left text-sm text-text hover:text-accent"
                onClick={() => onOpen?.(row.ref)}
              >
                {row.title}
              </button>
              <p className="break-words ui-meta text-text-faint">{row.meta}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-text-muted">{t("views.workspace.none")}</p>
      )}
    </div>
  );
}

function WorkspaceLocalGraph({
  memberTaskIds,
  relations,
  titles,
  onNavigateEntity,
}: {
  readonly memberTaskIds: readonly string[];
  readonly relations: readonly RelationEdge[];
  readonly titles: ReadonlyMap<string, string>;
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set()),
    graph = useMemo(
      () => workspaceGraphSlice(memberTaskIds, relations, expanded),
      [memberTaskIds, relations, expanded],
    ),
    external = new Set(graph.externalRefs);
  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4" aria-labelledby="workspace-graph">
      <h2 id="workspace-graph" className="text-sm font-semibold text-text">
        {t("views.workspace.localGraph")}
      </h2>
      <p className="mt-1 ui-meta text-text-muted">{t("views.workspace.localGraphNote")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {graph.nodeRefs.map((ref) => {
          const node = workspaceNodeLabel(ref, titles);
          return (
            <button
              key={ref}
              // 原始引用退为悬停,不占版面;标题缺位时正文里就是原始 id,不补造。
              title={ref}
              type="button"
              className={`max-w-full break-words rounded border px-2 py-1 text-left ui-meta ${external.has(ref) ? "border-warning/60 text-warning" : "border-border text-text"}`}
              onClick={() =>
                external.has(ref) ? setExpanded((current) => new Set([...current, ref])) : onNavigateEntity?.(ref)
              }
            >
              <span className="text-text-faint">{node.kindLabel}</span>
              {" · "}
              {workspaceNodeText(node)}
              {external.has(ref) ? t("views.workspace.externalExpand") : ""}
            </button>
          );
        })}
      </div>
      {graph.edges.length ? (
        <ul className="mt-3 space-y-1 ui-meta text-text-muted">
          {graph.edges.map((edge) => {
            const from = workspaceNodeLabel(normalizedRef(edge.from), titles),
              to = workspaceNodeLabel(normalizedRef(edge.to), titles);
            return (
              <li
                key={edge.relationId ?? `${edge.from}:${edge.kind}:${edge.to}`}
                title={`${edge.from} — ${edge.kind} → ${edge.to}`}
                className="break-words"
              >
                {workspaceNodeText(from)} <span className="text-text-faint">{relationKindLabel(edge.kind)}</span> →{" "}
                {workspaceNodeText(to)}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-text-muted">{t("views.workspace.graphEmpty")}</p>
      )}
    </section>
  );
}
