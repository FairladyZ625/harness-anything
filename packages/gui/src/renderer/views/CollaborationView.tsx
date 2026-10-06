import { useMemo, useState, type ReactNode } from "react";
import { t, type MessageKey } from "../i18n/index.tsx";
import {
  CENTER_NODE_ID,
  EMPTY_SESSION_AGENT_INDEX,
  assignmentStateOf,
  isExecutingLeasePhase,
  leaseNodeIdOf,
  leaseRuntimeSessionIdOf,
  projectCenterLeaseSource,
  type CollaborationAgent,
  type CollaborationTask,
  type SessionAgentIndex,
} from "../model/collaboration.ts";
import { actorDisplayName } from "../model/actor-name.ts";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { IdText } from "../components/IdText.tsx";
import { RepoModeBadge, type RepoMode } from "../components/RepoModeBadge.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { Section } from "../components/primitives/Section.tsx";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag.tsx";

const PHASE_LABEL: Readonly<Record<string, MessageKey>> = {
  held: "collaboration.phase.held",
  reserving: "collaboration.phase.reserving",
  orphaned: "collaboration.phase.orphaned",
  released: "collaboration.phase.released",
};
const PHASE_TONE: Readonly<Record<string, StatusTone>> = {
  held: "active",
  reserving: "wait",
  orphaned: "bad",
  released: "neutral",
};
type FleetNode = {
  readonly id: string;
  readonly tasks: readonly CollaborationTask[];
  readonly executing: number;
  readonly owner: string | null;
};

export function CollaborationView({
  repoId,
  mode,
  tasks,
  ready,
  agents = EMPTY_SESSION_AGENT_INDEX,
  agentReadError = null,
  agentReadLoading = false,
  onOpenTask,
  onNavigateEntity,
  now = new Date().toISOString(),
}: {
  readonly repoId: string;
  readonly mode: RepoMode;
  readonly tasks: readonly CollaborationTask[];
  readonly ready: boolean;
  readonly agents?: SessionAgentIndex;
  readonly agentReadError?: string | null;
  readonly agentReadLoading?: boolean;
  readonly onOpenTask: (taskId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly now?: string;
}) {
  const projected = useMemo(() => projectCenterLeaseSource(tasks), [tasks]);
  const nodes = useMemo(() => nodeSummaries(projected), [projected]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [eventNode, setEventNode] = useState("all");
  const selected = selectedNode === null ? null : (nodes.find((node) => node.id === selectedNode) ?? null);
  const events = useMemo(() => eventRows(projected, nodes), [projected, nodes]);
  const visibleEvents = eventNode === "all" ? events : events.filter((event) => event.nodeId === eventNode);
  const executing = projected.filter((task) => isExecutingLeasePhase(task.leasePhase)).length;
  return (
    <section
      data-testid="collaboration-view"
      data-repo={repoId}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <PageHeader
        title={t("collaboration.title")}
        note="舰队拓扑：节点、通道与正在发生的事情"
        meta={`${nodes.length} 节点 · ${executing} 执行中 · ${events.length} 事件`}
        actions={<RepoModeBadge mode={mode} />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {mode === "local" ? (
          <p
            data-testid="collaboration-center-notice"
            className="mb-3 border-l-2 border-status-active pl-3 ui-meta text-text-muted"
          >
            {t("collaboration.centerNotice")}
          </p>
        ) : null}
        {agentReadError !== null ? (
          <p className="mb-3 ui-meta text-status-blocked">
            {t("collaboration.agentReadFailed", { error: agentReadError })}
          </p>
        ) : null}
        {!ready ? (
          <Empty>{t("collaboration.loading")}</Empty>
        ) : nodes.length === 0 ? (
          <Empty>{t("collaboration.empty")}</Empty>
        ) : null}
        {nodes.length > 0 ? (
          <>
            <Section title="舰队拓扑" note="点击节点查看运行、租约与同步状态" variant="panel">
              <div
                data-testid="collaboration-topology"
                className="relative grid min-h-[250px] grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3 p-4"
              >
                {nodes.map((node) => (
                  <div key={node.id} className={node.id === CENTER_NODE_ID ? "col-span-full flex justify-center" : ""}>
                    {node.id !== CENTER_NODE_ID ? (
                      <div aria-hidden="true" className="mx-auto mb-2 h-5 w-px bg-border" />
                    ) : null}
                    <NodeCard
                      node={node}
                      mode={mode}
                      selected={node.id === selectedNode}
                      onSelect={() => setSelectedNode(node.id)}
                    />
                  </div>
                ))}
              </div>
            </Section>
            {selected !== null ? (
              <NodeDetails
                node={selected}
                mode={mode}
                now={now}
                agents={agents}
                agentReadError={agentReadError !== null}
                agentReadLoading={agentReadLoading}
                onOpenTask={onOpenTask}
                onNavigateEntity={onNavigateEntity}
                onClose={() => setSelectedNode(null)}
              />
            ) : null}
            <Section
              title="事件流"
              count={visibleEvents.length}
              note="来自任务与租约投影；不在页面写入事件"
              action={
                <select
                  aria-label="按节点筛选事件"
                  value={eventNode}
                  onChange={(event) => setEventNode(event.target.value)}
                  className="border border-border bg-surface px-2 py-1 ui-meta text-text"
                >
                  <option value="all">全部节点</option>
                  {nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {nodeLabel(node.id, mode)}
                    </option>
                  ))}
                </select>
              }
              variant="panel"
            >
              <div data-testid="collaboration-events" className="divide-y divide-border">
                {visibleEvents.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-raised"
                    onClick={() => setSelectedNode(event.nodeId)}
                  >
                    <StatusTag tone={event.tone} label={event.label} />
                    <span className="min-w-0 flex-1 truncate ui-meta text-text">{event.detail}</span>
                    <span className="ui-micro text-text-faint">{nodeLabel(event.nodeId, mode)}</span>
                  </button>
                ))}
              </div>
            </Section>
          </>
        ) : null}
      </div>
    </section>
  );
}

function nodeSummaries(tasks: readonly CollaborationTask[]): readonly FleetNode[] {
  const map = new Map<string, CollaborationTask[]>();
  for (const task of tasks) {
    const node = leaseNodeIdOf(task.leaseSource);
    if (node === null) continue;
    const list = map.get(node) ?? [];
    list.push(task);
    map.set(node, list);
  }
  return [...map.entries()]
    .map(([id, nodeTasks]) => ({
      id,
      tasks: nodeTasks,
      executing: nodeTasks.filter((task) => isExecutingLeasePhase(task.leasePhase)).length,
      owner: nodeTasks.find((task) => task.leaseActor)?.leaseActor?.principal.personId ?? null,
    }))
    .sort(
      (left, right) =>
        Number(left.id !== CENTER_NODE_ID) - Number(right.id !== CENTER_NODE_ID) ||
        right.executing - left.executing ||
        left.id.localeCompare(right.id),
    );
}
function nodeLabel(id: string, mode: RepoMode): string {
  return id === CENTER_NODE_ID
    ? t(mode === "local" ? "collaboration.centerNodeLocal" : "collaboration.centerNode")
    : id;
}
function NodeCard({
  node,
  mode,
  selected,
  onSelect,
}: {
  readonly node: FleetNode;
  readonly mode: RepoMode;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`collaboration-node-${node.id}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={`w-full max-w-[300px] border px-3 py-3 text-left transition-colors ${selected ? "border-accent bg-surface-raised" : "border-border bg-surface hover:border-accent"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold ui-body">{nodeLabel(node.id, mode)}</span>
        <StatusTag tone={node.executing > 0 ? "active" : "neutral"} label={node.executing > 0 ? "执行中" : "空闲"} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 ui-micro text-text-muted">
        <span>角色</span>
        <span className="text-right">{node.id === CENTER_NODE_ID ? "center" : "edge"}</span>
        <span>owner</span>
        <span className="truncate text-right">{node.owner ?? "未提供"}</span>
        <span>当前 cut</span>
        <span className="text-right">{node.tasks.length ? `${node.tasks.length} leases` : "未提供"}</span>
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-border pt-2 ui-micro text-text-faint">
        <span>通道</span>
        <span>
          {node.id === CENTER_NODE_ID ? "local" : "replica"} ·{" "}
          {node.id === CENTER_NODE_ID ? "fresh" : node.executing ? "lag" : "未同步"}
        </span>
      </div>
    </button>
  );
}

function NodeDetails({
  node,
  mode,
  now,
  agents,
  agentReadError,
  agentReadLoading,
  onOpenTask,
  onNavigateEntity,
  onClose,
}: {
  readonly node: FleetNode;
  readonly mode: RepoMode;
  readonly now: string;
  readonly agents: SessionAgentIndex;
  readonly agentReadError: boolean;
  readonly agentReadLoading: boolean;
  readonly onOpenTask: (id: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <Section
      title={nodeLabel(node.id, mode)}
      note="节点详情"
      action={
        <button type="button" onClick={onClose} className="text-accent ui-meta">
          关闭
        </button>
      }
      variant="panel"
    >
      <div data-testid="collaboration-node-details" className="grid gap-4 p-4 lg:grid-cols-2">
        <DetailBlock title="在做什么">
          {node.tasks.length === 0 ? (
            <p className="ui-meta text-text-muted">当前没有任务租约。</p>
          ) : (
            node.tasks.map((task) => (
              <TaskDetail
                key={task.taskId}
                task={task}
                now={now}
                agents={agents}
                agentReadError={agentReadError}
                agentReadLoading={agentReadLoading}
                onOpenTask={onOpenTask}
                onNavigateEntity={onNavigateEntity}
              />
            ))
          )}
        </DetailBlock>
        <DetailBlock title="内部状态">
          <DetailLine label="daemon" value="未提供（当前读面未暴露 daemon health）" />
          <DetailLine label="构建" value="未提供（当前读面未暴露 build）" />
          <DetailLine
            label="副本视图"
            value={node.id === CENTER_NODE_ID ? "center canonical view" : "未提供（节点视图 ID 未接入协作读面）"}
          />
          <DetailLine label="watch / pull" value={node.id === CENTER_NODE_ID ? "watch 未提供" : "同步通道未提供"} />
          <DetailLine label="最近失败" value="未提供（无 canonical lifecycle failure 记录）" />
        </DetailBlock>
      </div>
    </Section>
  );
}
function TaskDetail({
  task,
  now,
  agents,
  agentReadError,
  agentReadLoading,
  onOpenTask,
  onNavigateEntity,
}: {
  readonly task: CollaborationTask;
  readonly now: string;
  readonly agents: SessionAgentIndex;
  readonly agentReadError: boolean;
  readonly agentReadLoading: boolean;
  readonly onOpenTask: (id: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const session = leaseRuntimeSessionIdOf(task.leaseActor);
  const agent: CollaborationAgent | undefined = session === null ? undefined : agents.agentOfSession.get(session);
  const actor = task.leaseActor ? actorDisplayName(task.leaseActor.principal.personId) : null;
  const phase = task.leasePhase;
  return (
    <article className="border-t border-border py-2 first:border-t-0">
      <div className="flex items-center gap-2">
        <StatusTag status={task.coordinationStatus} />
        <button
          type="button"
          data-testid={`collaboration-task-${task.taskId}`}
          onClick={() => onOpenTask(task.taskId)}
          className="truncate text-left ui-body hover:underline"
        >
          {task.title}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 ui-micro text-text-muted">
        <span>{actor ? actor.name : "未提供"}</span>
        {agent ? (
          <EntityRefLink entityRef={`agent/${agent.agentId}`} onNavigate={onNavigateEntity}>
            {agent.label}
          </EntityRefLink>
        ) : session ? (
          <span>{agentReadError ? "无权限查看 Agent" : agentReadLoading ? "正在读取 Agent" : "Agent 未提供"}</span>
        ) : null}
        {session ? (
          <EntityRefLink entityRef={`session/${session}`} onNavigate={onNavigateEntity} title={session}>
            session
          </EntityRefLink>
        ) : null}
        <span>
          {phase ? (
            <StatusTag
              mono
              tone={PHASE_TONE[phase] ?? "neutral"}
              label={PHASE_LABEL[phase] ? t(PHASE_LABEL[phase]) : phase}
            />
          ) : (
            "租约状态未提供"
          )}
        </span>
        <span>资格：{assignmentStateOf(task, now) === "expired" ? "已过期" : task.assignment ? "有效" : "未指派"}</span>
      </div>
    </article>
  );
}
function DetailBlock({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 font-semibold ui-body">{title}</h3>
      {children}
    </div>
  );
}
function DetailLine({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex justify-between gap-3 border-t border-border py-1.5 ui-meta">
      <span className="text-text-faint">{label}</span>
      <span className="text-right text-text-muted">{value}</span>
    </div>
  );
}
type FleetEvent = {
  readonly id: string;
  readonly nodeId: string;
  readonly tone: StatusTone;
  readonly label: string;
  readonly detail: string;
};
function eventRows(tasks: readonly CollaborationTask[], nodes: readonly FleetNode[]): readonly FleetEvent[] {
  const events: FleetEvent[] = [];
  for (const task of tasks) {
    const nodeId = leaseNodeIdOf(task.leaseSource);
    if (nodeId === null) continue;
    events.push({
      id: `${task.taskId}:lease`,
      nodeId,
      tone: isExecutingLeasePhase(task.leasePhase) ? "active" : "neutral",
      label: task.leasePhase === "held" ? "lease held" : "task observed",
      detail: task.title,
    });
  }
  for (const node of nodes.filter((entry) => entry.id !== CENTER_NODE_ID))
    events.push({
      id: `${node.id}:sync`,
      nodeId: node.id,
      tone: node.executing > 0 ? "wait" : "neutral",
      label: node.executing > 0 ? "replica lag" : "replica observed",
      detail: `${node.tasks.length} task lease${node.tasks.length === 1 ? "" : "s"} visible`,
    });
  return events;
}
export function CollaborationNodeRef({ nodeId, mode }: { readonly nodeId: string; readonly mode: RepoMode }) {
  return nodeId === CENTER_NODE_ID ? (
    <span title={CENTER_NODE_ID} className="font-mono ui-micro">
      {nodeLabel(nodeId, mode)}
    </span>
  ) : (
    <IdText value={nodeId} />
  );
}
