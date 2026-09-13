import { useQuery } from "@tanstack/react-query";
import { ArrowSquareOut, LinkSimple } from "@phosphor-icons/react";
import { agentRuntimeClient, runtimeQueryKeys } from "../../agent-runtime-client.ts";
import { useTriadicProjectionQuery } from "../../triadic-data.ts";
import type { TaskRow } from "../../model/types.ts";
import { normalizeTaskId } from "../../model/triadic.ts";
import { t } from "../../i18n/index.tsx";
import { IN_LABEL, OUT_LABEL } from "./constants.ts";
import { RelationRow } from "./RelationRow.tsx";

export interface TaskDecisionRef {
  readonly decisionId: string;
  readonly title: string;
  readonly state: string;
}

export function TaskRelationsTab({
  task,
  tasks = [],
  decisions = [],
  onSelect,
  onNavigateDecision,
  onNavigateEntity,
  onOpenSession,
}: {
  readonly task: TaskRow;
  readonly tasks?: readonly TaskRow[];
  readonly decisions?: readonly TaskDecisionRef[];
  readonly onSelect?: (taskId: string) => void;
  readonly onNavigateDecision?: (decisionId: string) => void;
  readonly onNavigateEntity?: (ref: string) => void;
  readonly onOpenSession: (runtimeSessionId: string) => void;
}) {
  const runtime = useQuery({
    queryKey: runtimeQueryKeys.overview(task.projectId, task.taskId),
    queryFn: () => agentRuntimeClient.overview(task.projectId, task.taskId),
    staleTime: 4_000,
  });
  const graph = useTriadicProjectionQuery(task.projectId, { decisionsEnabled: false });
  const relations = graph.relations;
  const taskRef = `task/${task.taskId}`;
  const outEdges = relations.filter((edge) => edge.from === taskRef || normalizeTaskId(edge.from) === task.taskId);
  const inEdges = relations.filter((edge) => edge.to === taskRef || normalizeTaskId(edge.to) === task.taskId);
  const children = tasks.filter((candidate) => candidate.parentTaskId === task.taskId);
  const parent = tasks.find((candidate) => candidate.taskId === task.parentTaskId);
  const decisionIds = new Set<string>();
  for (const edge of [...outEdges, ...inEdges]) {
    for (const ref of [edge.from, edge.to]) if (ref.startsWith("decision/")) decisionIds.add(ref.split("/")[1] ?? "");
  }
  for (const id of task.spawningDecisionIds ?? []) decisionIds.add(id);
  const relatedDecisions = decisions.filter((decision) => decisionIds.has(decision.decisionId));

  return (
    <section data-testid="task-relations-tab">
      {graph.isPending && <p role="status">正在加载任务关系…</p>}
      {graph.isError && <p role="alert">任务关系读取失败，请刷新后重试。</p>}
      <SectionHeading />
      <div className="mt-7 grid gap-8 xl:grid-cols-2">
        <RelationGroup title="父子 Task" count={children.length + (task.parentTaskId ? 1 : 0)}>
          {task.parentTaskId ? (
            <EntityButton
              label="parent"
              id={task.parentTaskId}
              title={parent?.title ?? "父任务"}
              onClick={onSelect ? () => onSelect(task.parentTaskId!) : undefined}
            />
          ) : (
            <p className="ui-meta text-text-faint">这是根任务，没有 parent。</p>
          )}
          {children.map((child) => (
            <EntityButton
              key={child.taskId}
              label="child"
              id={child.taskId}
              title={child.title}
              onClick={onSelect ? () => onSelect(child.taskId) : undefined}
            />
          ))}
        </RelationGroup>
        <RelationGroup title="Decision" count={relatedDecisions.length}>
          {relatedDecisions.length === 0 ? (
            <p className="ui-meta text-text-faint">没有关联 decision。</p>
          ) : (
            relatedDecisions.map((decision) => (
              <EntityButton
                key={decision.decisionId}
                label={decision.state}
                id={decision.decisionId}
                title={decision.title}
                onClick={onNavigateDecision ? () => onNavigateDecision(decision.decisionId) : undefined}
              />
            ))
          )}
        </RelationGroup>
        <RelationGroup title="Runtime session" count={runtime.data?.sessions.length ?? 0}>
          {runtime.isPending ? (
            <p className="animate-pulse ui-meta text-text-faint">正在读取 session…</p>
          ) : runtime.isError ? (
            <p role="alert" className="ui-meta leading-5 text-danger">
              Session 读取失败：{runtime.error.message}
            </p>
          ) : runtime.data.sessions.length === 0 ? (
            <p className="ui-meta text-text-faint">没有与该任务绑定的 session。</p>
          ) : (
            runtime.data.sessions.map((session) => (
              <button
                key={session.runtimeSessionId}
                type="button"
                onClick={() => onOpenSession(session.runtimeSessionId)}
                className={
                  "group flex w-full items-center gap-3 border-b border-border/70 py-2.5 text-left " +
                  "last:border-b-0 hover:text-accent"
                }
              >
                <span className="font-mono ui-micro text-text-muted group-hover:text-accent">
                  {session.runtimeSessionId}
                </span>
                <span className="min-w-0 truncate ui-meta text-text-faint">
                  {session.definitionSnapshot?.model ?? t("agentRuntime.definitionSnapshotNotPersisted")}
                  {!session.definitionSnapshotPersisted && session.definitionSnapshot !== null
                    ? ` · ${t("agentRuntime.definitionSnapshotNotPersisted")}`
                    : ""}
                </span>
                <span className="ml-auto font-mono ui-micro text-text-faint">{session.liveness}</span>
                <ArrowSquareOut weight="bold" className="ui-meta text-text-faint group-hover:text-accent" />
              </button>
            ))
          )}
        </RelationGroup>
        <RelationGroup title="全部关系边" count={outEdges.length + inEdges.length}>
          {outEdges.length === 0 && inEdges.length === 0 ? (
            <p className="ui-meta text-text-faint">没有 active relation。</p>
          ) : (
            <div className="grid gap-2">
              {outEdges.map((edge, index) => (
                <RelationRow
                  key={`out-${edge.relationId ?? index}`}
                  peer={edge.to}
                  label={OUT_LABEL[edge.kind]}
                  provenance={edge.provenance}
                  title={peerTitle(edge.to, tasks, decisions)}
                  onSelect={onSelect}
                  onNavigateEntity={onNavigateEntity}
                />
              ))}
              {inEdges.map((edge, index) => (
                <RelationRow
                  key={`in-${edge.relationId ?? index}`}
                  peer={edge.from}
                  label={IN_LABEL[edge.kind]}
                  provenance={edge.provenance}
                  title={peerTitle(edge.from, tasks, decisions)}
                  onSelect={onSelect}
                  onNavigateEntity={onNavigateEntity}
                />
              ))}
            </div>
          )}
        </RelationGroup>
      </div>
    </section>
  );
}

function SectionHeading() {
  return (
    <header className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1" data-testid="task-section-heading">
      <p className="shrink-0 font-mono ui-micro font-semibold uppercase tracking-[0.16em] text-accent">CONTEXT</p>
      <h2 className="shrink-0 ui-body font-semibold tracking-[-0.01em] text-text">任务关系</h2>
      <p className="min-w-0 truncate ui-micro leading-4 text-text-faint">
        父子任务、承重决策、关系边与运行 session 的可跳转索引
      </p>
    </header>
  );
}

function RelationGroup({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 border-t border-border pt-3">
      <div className="mb-2 flex items-center gap-2">
        <LinkSimple weight="duotone" className="ui-body text-text-faint" />
        <h3 className="ui-body font-semibold text-text">{title}</h3>
        <span className="font-mono ui-micro text-text-faint">{count}</span>
      </div>
      {children}
    </section>
  );
}

function EntityButton({
  label,
  id,
  title,
  onClick,
}: {
  readonly label: string;
  readonly id: string;
  readonly title: string;
  readonly onClick?: () => void;
}) {
  const content = (
    <>
      <span
        className={
          "w-14 shrink-0 rounded bg-surface-raised px-1 py-0.5 text-center font-mono " + "ui-micro text-text-faint"
        }
      >
        {label}
      </span>
      <span className="shrink-0 font-mono ui-micro text-text-muted group-hover:text-accent">{id}</span>
      <span className="min-w-0 truncate ui-meta text-text-faint">{title}</span>
      {onClick ? (
        <ArrowSquareOut weight="bold" className="ml-auto shrink-0 ui-meta text-text-faint group-hover:text-accent" />
      ) : null}
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-2 border-b border-border/70 py-2.5 text-left last:border-b-0"
    >
      {content}
    </button>
  ) : (
    <div className="group flex items-center gap-2 border-b border-border/70 py-2.5 last:border-b-0">{content}</div>
  );
}

function peerTitle(ref: string, tasks: readonly TaskRow[], decisions: readonly TaskDecisionRef[]): string {
  if (ref.startsWith("decision/"))
    return decisions.find((decision) => decision.decisionId === ref.split("/")[1])?.title ?? "";
  if (ref.startsWith("task/") || !ref.includes("/"))
    return tasks.find((task) => task.taskId === normalizeTaskId(ref))?.title ?? "";
  return "";
}
