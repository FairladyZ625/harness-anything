import { ArrowSquareOut, LinkSimple } from "@phosphor-icons/react";
import { useTriadicProjectionQuery } from "../../triadic-data.ts";
import type { TaskRow } from "../../model/types.ts";
import { normalizeTaskId } from "../../model/triadic.ts";
import { t } from "../../i18n/index.tsx";
import { IN_LABEL, OUT_LABEL } from "./constants.ts";
import { RelationRow } from "./RelationRow.tsx";
import { Section } from "../primitives/Section.tsx";
import { WorkLineageTree } from "../WorkLineageTree.tsx";

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
  const graph = useTriadicProjectionQuery(task.projectId, { decisionsEnabled: false });
  const relations = graph.relations;
  const taskRef = `task/${task.taskId}`;
  const outEdges = relations.filter((edge) => edge.from === taskRef || normalizeTaskId(edge.from) === task.taskId);
  const inEdges = relations.filter((edge) => edge.to === taskRef || normalizeTaskId(edge.to) === task.taskId);
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
      <Section title="任务关系" note="血缘与成本树、上级任务、承重决策与关系边的可跳转索引">
        <div className="grid gap-8 xl:grid-cols-2">
          {/* 血缘树(W3-T1)替换旧「父子 Task + Runtime session」两块平铺:子孙任务与
              Squad/Worker 派工轮在一棵实时树上,节点带状态/耗时/Token,任务节点开详情、
              派工节点落本页签对应会话(focusedSessionId)。 */}
          <RelationGroup title={t("views.lineage.sectionTitle")}>
            <p className="m-0 ui-micro leading-5 text-text-faint">{t("views.lineage.sectionNote")}</p>
            <WorkLineageTree
              repoId={task.projectId}
              rootTask={task}
              tasks={tasks}
              live={task.activeExecutionId !== undefined}
              onOpenTask={onSelect}
              onOpenSession={onOpenSession}
              testId="task-relations-lineage"
            />
          </RelationGroup>
          {task.parentTaskId ? (
            <RelationGroup title={t("views.lineage.parentTask")} count={1}>
              <EntityButton
                label="parent"
                id={task.parentTaskId}
                title={parent?.title ?? "父任务"}
                onClick={onSelect ? () => onSelect(task.parentTaskId!) : undefined}
              />
            </RelationGroup>
          ) : null}
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
      </Section>
    </section>
  );
}

function RelationGroup({
  title,
  count,
  children,
}: {
  readonly title: string;
  /** 组内条目数(血缘树组自己报实时计数,不给)。 */
  readonly count?: number;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 border-t border-border pt-3">
      <div className="mb-2 flex items-center gap-2">
        <LinkSimple weight="duotone" className="ui-body text-text-faint" />
        <h3 className="ui-body font-semibold text-text">{title}</h3>
        {count !== undefined && <span className="font-mono ui-micro text-text-faint">{count}</span>}
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
