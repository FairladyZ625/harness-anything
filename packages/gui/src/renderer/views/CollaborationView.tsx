import { useMemo, useState, type ReactNode } from "react";
import { t, type MessageKey } from "../i18n/index.tsx";
import {
  applyCollaborationFilters,
  assignmentStateOf,
  collaborationFilterOptions,
  EMPTY_SESSION_AGENT_INDEX,
  hasCollaborationFilters,
  isExecutingLeasePhase,
  leaseNodeIdOf,
  leaseRuntimeSessionIdOf,
  NO_COLLABORATION_FILTERS,
  type CollaborationAgent,
  type CollaborationFilters,
  type CollaborationTask,
  type SessionAgentIndex,
} from "../model/collaboration.ts";
import { actorDisplayName } from "../model/actor-name.ts";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { IdText } from "../components/IdText.tsx";
import { RepoModeBadge, type RepoMode } from "../components/RepoModeBadge.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { RowTime } from "../components/primitives/DenseRow.tsx";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { Notice } from "../components/primitives/Notice.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag.tsx";

/**
 * 协作页(task_1bafbf09):本仓任务分工清单——每行同时回答「指派给谁(资格)」与
 * 「谁在实际执行(lease)」,两者不混为一个状态。数据来自 App 已读出的任务切面
 * (repo.tasks.list)与会话→Agent 索引(runtime-session-groups groupBy=agent),
 * 本页不自建读面、不判能力、不显示可抢语义。
 *
 * 入口按仓库模式显隐(纯本地无多节点面,见 navConfig fleetOnly);直接落到本页的
 * 纯本地会话给如实提示。节点汇总只列数据中出现过的 nodeId,在线状态本读面不提供。
 */

const LEASE_PHASE_LABEL_KEY: Readonly<Record<string, MessageKey>> = {
  held: "collaboration.phase.held",
  reserving: "collaboration.phase.reserving",
  orphaned: "collaboration.phase.orphaned",
  released: "collaboration.phase.released",
};
const LEASE_PHASE_TONE: Readonly<Record<string, StatusTone>> = {
  held: "active",
  reserving: "wait",
  orphaned: "bad",
  released: "neutral",
};
const LEASE_SOURCE_LABEL_KEY: Readonly<Record<string, MessageKey>> = {
  local: "collaboration.source.local",
  remote_direct: "collaboration.source.remoteDirect",
};

export function CollaborationView({
  repoId,
  mode,
  tasks,
  ready,
  agents = EMPTY_SESSION_AGENT_INDEX,
  onOpenTask,
  onNavigateEntity,
  now = new Date().toISOString(),
}: {
  readonly repoId: string;
  /** 当前仓的 registry v2 模式;本页在纯本地只给提示,不渲染多节点面。 */
  readonly mode: RepoMode;
  readonly tasks: readonly CollaborationTask[];
  /** 任务切面是否已读完(App 的 repo.tasks.list status);未完时行集渐进成形。 */
  readonly ready: boolean;
  /** 会话→声明 Agent 索引(App 从 runtime-session-groups groupBy=agent 读面折算);缺省空 = Agent 维度缺席。 */
  readonly agents?: SessionAgentIndex;
  readonly onOpenTask: (taskId: string) => void;
  /** 会话等可寻址实体的统一出口(session/<id> 落会话页)。 */
  readonly onNavigateEntity: (ref: string) => void;
  /** 注入时钟(测试用);缺省当前时间。 */
  readonly now?: string;
}) {
  const [filters, setFilters] = useState<CollaborationFilters>(NO_COLLABORATION_FILTERS);
  const options = useMemo(() => collaborationFilterOptions(tasks, agents), [tasks, agents]);
  const rows = useMemo(() => applyCollaborationFilters(tasks, filters, agents), [tasks, filters, agents]);
  // 页头「执行中」与行内 phase 同源:只认 held/reserving;orphaned/released 是持有人在
  // 但不在执行,actor 存在不等于执行中。
  const executing = useMemo(() => tasks.filter((task) => isExecutingLeasePhase(task.leasePhase)).length, [tasks]);
  const filtering = hasCollaborationFilters(filters);

  return (
    <section
      data-testid="collaboration-view"
      data-repo={repoId}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <PageHeader
        title={t("collaboration.title")}
        note={t("collaboration.note")}
        meta={t("collaboration.summary", { total: tasks.length, executing })}
        actions={<RepoModeBadge mode={mode} />}
      />
      {mode === "local" ? (
        <Notice tone="neutral" variant="strip" testId="collaboration-local-notice">
          {t("collaboration.localNotice")}
        </Notice>
      ) : null}
      {options.persons.length > 0 || options.agents.length > 0 || options.nodes.length > 0 ? (
        <div
          data-testid="collaboration-filters"
          className="flex shrink-0 flex-wrap items-start gap-x-5 gap-y-1.5 border-b border-border px-5 py-1.5"
        >
          {options.persons.length > 0 ? (
            <FilterDimension
              testId="collaboration-filter-person"
              label={t("collaboration.filterPerson")}
              total={tasks.length}
              options={options.persons.map(({ id, count }) => ({
                key: id,
                label: <span title={id}>{actorDisplayName(id).name}</span>,
                count,
              }))}
              value={filters.person}
              onChange={(person) => setFilters((current) => ({ ...current, person }))}
            />
          ) : null}
          {options.agents.length > 0 ? (
            <FilterDimension
              testId="collaboration-filter-agent"
              label={t("collaboration.filterAgent")}
              total={tasks.length}
              labelTitle={agents.truncated ? t("collaboration.agentTruncated") : undefined}
              options={options.agents.map(({ id, label, count }) => ({
                key: id,
                label: <span title={id}>{label}</span>,
                count,
              }))}
              value={filters.agent}
              onChange={(agent) => setFilters((current) => ({ ...current, agent }))}
            />
          ) : null}
          {options.nodes.length > 0 ? (
            <FilterDimension
              testId="collaboration-filter-node"
              label={t("collaboration.filterNode")}
              total={tasks.length}
              options={options.nodes.map(({ nodeId, count }) => ({
                key: nodeId,
                label: <span title={nodeId}>{nodeId}</span>,
                count,
              }))}
              value={filters.node}
              onChange={(node) => setFilters((current) => ({ ...current, node }))}
            />
          ) : null}
        </div>
      ) : null}
      {options.nodes.length > 0 ? (
        <div
          data-testid="collaboration-nodes"
          className="flex max-h-24 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 overflow-y-auto border-b border-border px-5 py-1.5 ui-meta text-text-muted"
        >
          <span className="text-text-faint">{t("collaboration.nodeLabel")}</span>
          {options.nodes.map(({ nodeId, executing: nodeExecuting, assigned }) => (
            <span key={nodeId} data-node={nodeId} className="flex items-center gap-1">
              <IdText value={nodeId} />
              <span>
                {t("collaboration.nodeExecuting", { count: nodeExecuting })} ·{" "}
                {t("collaboration.nodeAssigned", { count: assigned })}
              </span>
            </span>
          ))}
          <span className="text-text-faint">{t("collaboration.nodeOnlineUnknown")}</span>
        </div>
      ) : null}
      <div data-testid="collaboration-list" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {rows.length === 0 ? (
          <div className="px-5 py-3">
            {filtering ? (
              <p data-testid="collaboration-filter-empty" className="ui-meta text-text-muted">
                {t("collaboration.filterEmpty")}{" "}
                <button
                  type="button"
                  data-testid="collaboration-filter-clear"
                  onClick={() => setFilters(NO_COLLABORATION_FILTERS)}
                  className="text-accent underline underline-offset-2"
                >
                  {t("collaboration.filterClear")}
                </button>
              </p>
            ) : (
              <Empty>{t(ready ? "collaboration.empty" : "collaboration.loading")}</Empty>
            )}
          </div>
        ) : (
          rows.map((task) => (
            <CollaborationRow
              key={task.taskId}
              task={task}
              now={now}
              agents={agents}
              onOpenTask={onOpenTask}
              onNavigateEntity={onNavigateEntity}
            />
          ))
        )}
      </div>
    </section>
  );
}

/** 单维度筛选:全部 + 实际出现过的值(带计数);空维度不渲染。 */
function FilterDimension({
  testId,
  label,
  labelTitle,
  total,
  options,
  value,
  onChange,
}: {
  readonly testId: string;
  readonly label: string;
  /** 维度名上的悬停说明(如 Agent 读面被截断时点名映射可能缺组)。 */
  readonly labelTitle?: string;
  readonly total: number;
  readonly options: readonly { readonly key: string; readonly label: ReactNode; readonly count: number }[];
  readonly value: string | null;
  readonly onChange: (next: string | null) => void;
}) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-text-faint ui-meta" title={labelTitle}>
        {label}
      </span>
      <FilterChips
        chips={[
          { key: "__all__", label: t("collaboration.filterAll"), count: total },
          ...options.map(({ key, label: optionLabel, count }) => ({
            key,
            label: optionLabel,
            count,
          })),
        ]}
        value={value ?? "__all__"}
        onChange={(key) => onChange(key === "__all__" ? null : key)}
      />
    </div>
  );
}

function CollaborationRow({
  task,
  now,
  agents,
  onOpenTask,
  onNavigateEntity,
}: {
  readonly task: CollaborationTask;
  readonly now: string;
  readonly agents: SessionAgentIndex;
  readonly onOpenTask: (taskId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const assignee = task.assignment?.assignee;
  const assignmentState = assignmentStateOf(task, now);
  const leaseActor = task.leaseActor;
  const leaseNodeId = leaseNodeIdOf(task.leaseSource);
  const runtimeSessionId = leaseRuntimeSessionIdOf(leaseActor);
  // Agent 只认索引映射(投影里 dispatch 行 agentId 的权威绑定);映射不上如实
  // 「未提供」,不拿会话/实例字符串冒充。
  const agent: CollaborationAgent | undefined =
    runtimeSessionId === null ? undefined : agents.agentOfSession.get(runtimeSessionId);
  const phase = task.leasePhase;
  const principal = leaseActor === undefined ? null : actorDisplayName(leaseActor.principal.personId);
  return (
    <article
      data-testid="collaboration-row"
      data-task-id={task.taskId}
      className="flex shrink-0 flex-col gap-1 border-t border-border px-5 py-2.5"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <StatusTag status={task.coordinationStatus} />
        <button
          type="button"
          data-testid={`collaboration-task-${task.taskId}`}
          title={task.taskId}
          onClick={() => onOpenTask(task.taskId)}
          className="min-w-0 truncate text-left text-text ui-body hover:underline"
        >
          {task.title}
        </button>
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1 ui-meta text-text-muted">
        <EntityRefLink
          entityRef={`task/${task.taskId}`}
          onNavigate={(ref) => onOpenTask(ref.slice("task/".length))}
          className="text-text-faint"
        />
        {/* 资格侧:指派对象与期限。过期只说明资格放开,不构成可抢。 */}
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-text-faint">{t("collaboration.assigneeLabel")}</span>
          {assignee === undefined ? (
            <span>{t("collaboration.assigneeNone")}</span>
          ) : (
            <>
              {assignmentState === "expired" ? (
                <span className="text-status-submitted">{t("collaboration.assigneeExpired")}</span>
              ) : null}
              <span>
                {t(`taskAssignment.${assignee.kind === "team" ? "team" : assignee.nodeId ? "node" : "person"}`)}
              </span>
              <IdText value={assignee.kind === "team" ? assignee.teamId : (assignee.nodeId ?? assignee.personId)} />
              <RowTime at={task.assignment!.expiresAt} className="text-text-faint" />
            </>
          )}
        </span>
        {/* 执行侧:lease 持有人/会话、执行节点、phase 与到期,全部来自结构字段。 */}
        <span className="flex min-w-0 flex-wrap items-baseline gap-1.5">
          <span className="text-text-faint">{t("collaboration.executorLabel")}</span>
          {leaseActor === undefined ? (
            <span>{t("collaboration.noLease")}</span>
          ) : (
            <>
              <span title={principal!.full}>{principal!.name}</span>
              {agent !== undefined ? (
                <EntityRefLink
                  entityRef={`agent/${agent.agentId}`}
                  onNavigate={onNavigateEntity}
                  title={agent.agentId}
                  className="text-text-muted"
                >
                  {agent.label}
                </EntityRefLink>
              ) : runtimeSessionId !== null ? (
                <span className="text-text-faint">{t("collaboration.agentNotProvided")}</span>
              ) : null}
              {runtimeSessionId !== null ? (
                <EntityRefLink
                  entityRef={`session/${runtimeSessionId}`}
                  onNavigate={onNavigateEntity}
                  title={leaseActor.executor!.id}
                />
              ) : leaseActor.executor !== null ? (
                <IdText value={leaseActor.executor.id} />
              ) : null}
              {leaseNodeId !== null ? (
                <span className="flex items-baseline gap-1">
                  <span className="text-text-faint">@</span>
                  <IdText value={leaseNodeId} />
                </span>
              ) : typeof task.leaseSource === "string" ? (
                <span className="text-text-faint">
                  {t(LEASE_SOURCE_LABEL_KEY[task.leaseSource] ?? "collaboration.source.other")}
                </span>
              ) : (
                <span className="text-text-faint">{t("collaboration.source.other")}</span>
              )}
              {phase !== undefined ? (
                <StatusTag
                  mono
                  tone={LEASE_PHASE_TONE[phase] ?? "neutral"}
                  label={LEASE_PHASE_LABEL_KEY[phase] !== undefined ? t(LEASE_PHASE_LABEL_KEY[phase]) : phase}
                />
              ) : null}
              {task.leaseExpiresAt !== undefined ? (
                <RowTime at={task.leaseExpiresAt} className="text-text-faint" />
              ) : null}
            </>
          )}
        </span>
      </div>
    </article>
  );
}
