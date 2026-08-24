import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  ArrowSquareOut,
  CheckCircle,
  Circle,
  ClockCounterClockwise,
  FileText,
  LinkSimple,
  XCircle,
} from "@phosphor-icons/react";
import type {
  AgentRuntimeEventsResult,
  AgentRuntimeSessionResult,
} from "../../../../../daemon/src/agent-runtime-contract.ts";
import type { GuiSubmissionV1, RelationFactRow, TaskDispatchProjectionRow } from "../../../api/renderer-dto.ts";
import { agentRuntimeClient } from "../../agent-runtime-client.ts";
import { harnessClient } from "../../api-client.ts";
import type { TaskMutationFeedback } from "../../task-actions.ts";
import { useTaskDocumentQuery } from "../../task-data.ts";
import { buildTriadicRendererData, triadicQueryKeys } from "../../triadic-data.ts";
import { localDateTime } from "../../model/local-time.ts";
import type { DecisionRow, RelationEdge, TaskRow } from "../../model/types.ts";
import { normalizeTaskId } from "../../model/triadic.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { buildFactTriage, SIGNAL_LABEL, type FactTriageItem } from "../../model/fact-triage.ts";
import { buildFactTriageContext } from "../../model/copy-context.ts";
import {
  adaptTaskExecutions,
  buildExecutionEvidenceContext,
  checkerResultField,
  field,
  receiptField,
  type ExecutionEvidenceRow,
} from "../../model/execution-evidence.ts";
import { CloseoutBadge } from "../badges.tsx";
import { CopyContextButton } from "../CopyContextButton.tsx";
import { DocReader } from "../DocReader.tsx";
import { TaskControlPanel } from "../TaskControlPanel.tsx";
import { IN_LABEL, OUT_LABEL } from "./constants.ts";
import { RelationRow } from "./RelationRow.tsx";

interface TaskActionProps {
  readonly mutationFeedback?: TaskMutationFeedback;
  readonly onProgress?: (input: {
    text: string;
    evidence: ReadonlyArray<{ type: string; path: string; summary: string }>;
  }) => Promise<unknown>;
  readonly onSubmit?: (submission: GuiSubmissionV1) => Promise<unknown>;
}

export function TaskOverviewTab({ task }: { readonly task: TaskRow }) {
  const plan = useTaskDocumentQuery(task.projectId, task.taskId, "task_plan.md");
  const events = task.events ?? [];

  return (
    <div className="grid min-h-full gap-8" data-testid="task-overview-tab">
      <section className="min-w-0">
        <SectionHeading eyebrow="PLAN" title="任务计划" description="目标、验收与边界的完整原文" />
        <div className="mt-5">
          {/* TODO(read-model): repo.tasks.document.read only exposes body:string today.
              Keep the plan intact; do not parse markdown/frontmatter in the renderer.
              Replace this whole-body rendering when the backend projects plan sections. */}
          {plan.isPending ? (
            <Pending text="正在读取 task_plan…" />
          ) : plan.isError ? (
            <ReadError text={`任务计划读取失败：${plan.error.message}`} />
          ) : plan.data.status !== "ready" ? (
            <Pending text="任务计划投影尚未追平" />
          ) : plan.data.blobSha256 === null ? (
            <Empty text="该任务尚未物化 task_plan.md。物化后，这里会直接呈现计划正文。" />
          ) : (
            <DocReader content={plan.data.body} />
          )}
        </div>
      </section>

      <aside className="border-t border-border pt-6">
        <SectionHeading eyebrow="TIMELINE" title="进展时间线" description={`${events.length} 条生命周期记录`} />
        {events.length === 0 ? (
          <div className="mt-5">
            <Empty text="还没有 execution、review、consent 或 gate witness 记录。" />
          </div>
        ) : (
          <ol className="mt-5 grid gap-0" data-testid="task-progress-timeline">
            {events.map((event, index) => (
              <li key={`${event.at}-${event.summary}-${index}`} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-3">
                <div className="flex flex-col items-center">
                  <Circle weight="fill" className="mt-1 text-[9px] text-accent" />
                  {index < events.length - 1 ? <span className="min-h-8 w-px flex-1 bg-border" /> : null}
                </div>
                <div className="pb-5">
                  <p className="text-[13px] leading-5 text-text">{event.summary}</p>
                  <Timestamp value={event.at} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}

export function TaskDispatchTab({
  task,
  focusedSessionId,
  onNavigateEntity,
}: {
  readonly task: TaskRow;
  readonly focusedSessionId: string | null;
  /** G10 实体互链:派工链里的 session/agent/squad/provider ID 必须有路。 */
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const dispatches = useQuery({
    queryKey: ["task-detail", task.projectId, task.taskId, "dispatches"],
    queryFn: () => harnessClient.getTaskDispatches({ repoId: task.projectId, taskId: task.taskId }),
    staleTime: 4_000,
  });
  const rows = dispatches.data?.dispatches ?? [];
  const sessions = useQueries({
    queries: rows.map((row) => ({
      queryKey: ["task-detail", task.projectId, row.runtimeSessionId, "session"],
      queryFn: () => agentRuntimeClient.session(task.projectId, row.runtimeSessionId),
      staleTime: 4_000,
    })),
  });
  const events = useQueries({
    queries: rows.map((row) => ({
      queryKey: ["task-detail", task.projectId, row.runtimeSessionId, "events", "lifecycle:0"],
      queryFn: () => agentRuntimeClient.events(task.projectId, row.runtimeSessionId),
      staleTime: 4_000,
    })),
  });

  return (
    <section data-testid="task-dispatch-tab">
      <SectionHeading
        eyebrow="MISSION → DISPATCH → REPORT"
        title="派工链"
        description="派工身份、运行会话与最终报告来自 daemon 的结构化读面"
      />
      {dispatches.isPending ? (
        <div className="mt-5">
          <Pending text="正在读取派工记录…" />
        </div>
      ) : dispatches.isError ? (
        <div className="mt-5">
          <ReadError text={`派工记录读取失败：${dispatches.error.message}`} />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-5">
          <Empty text="该任务还没有派工记录。派工后，mission 身份、dispatch 与 report 会在这里串成一条链。" />
        </div>
      ) : (
        <div className="mt-6 grid gap-7">
          {rows.map((row, index) => (
            <DispatchChain
              key={row.dispatchId}
              row={row}
              onNavigateEntity={onNavigateEntity}
              session={sessions[index]?.data}
              sessionError={sessions[index]?.error}
              events={events[index]?.data}
              eventsError={events[index]?.error}
              focused={focusedSessionId === row.runtimeSessionId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DispatchChain({
  row,
  session,
  sessionError,
  events,
  eventsError,
  focused,
  onNavigateEntity,
}: {
  readonly onNavigateEntity: (ref: string) => void;
  readonly row: TaskDispatchProjectionRow;
  readonly session?: AgentRuntimeSessionResult;
  readonly sessionError?: Error | null;
  readonly events?: AgentRuntimeEventsResult;
  readonly eventsError?: Error | null;
  readonly focused: boolean;
}) {
  return (
    <article
      id={`runtime-session-${row.runtimeSessionId}`}
      data-testid={`dispatch-chain-${row.dispatchId}`}
      className={`border-t pt-4 ${focused ? "border-accent" : "border-border"}`}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusDot status={row.status} />
        <span className="font-mono text-[12px] font-semibold text-text">{row.dispatchId}</span>
        <EntityRefLink
          entityRef={`session/${row.runtimeSessionId}`}
          onNavigate={onNavigateEntity}
          title={row.runtimeSessionId}
          className="font-mono text-[11px] text-accent hover:underline"
        />
        <span className="ml-auto font-mono text-[11px] text-text-faint">{row.status}</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)_minmax(0,1.4fr)]">
        <ChainStep index="01" title="Mission">
          <p className="font-semibold text-text">{row.agentName ?? row.agentId ?? "执行者未投影"}</p>
          {row.agentId ? (
            <MetaLine
              label="agent"
              value={row.agentId}
              onNavigate={onNavigateEntity}
              entityRef={`agent/${row.agentId}`}
            />
          ) : (
            <MetaLine label="agent" value="—" />
          )}
          {row.squadId ? (
            <MetaLine
              label="squad"
              value={row.squadId}
              onNavigate={onNavigateEntity}
              entityRef={`squad/${row.squadId}`}
            />
          ) : (
            <MetaLine label="squad" value="—" />
          )}
          <MetaLine label="delegated by" value={row.delegatedByAgentName ?? row.delegatedByAgentId ?? "—"} />
          <p className="mt-3 text-[11px] leading-5 text-text-faint">
            当前读面不包含 mission 正文；这里仅展示结构化派工身份。
          </p>
        </ChainStep>
        <ChainStep index="02" title="Dispatch">
          <MetaLine label="execution" value={row.executionId} />
          <MetaLine
            label="instance"
            value={row.instanceId}
            onNavigate={onNavigateEntity}
            entityRef={`provider/${row.instanceId}`}
          />
          <MetaLine label="provider session" value={row.providerSessionId ?? "—"} />
          <MetaLine label="started" value={localDateTime(row.startedAt, true) ?? row.startedAt} />
          <MetaLine label="ended" value={row.endedAt ? (localDateTime(row.endedAt, true) ?? row.endedAt) : "运行中"} />
        </ChainStep>
        <ChainStep index="03" title="Report">
          {sessionError ? (
            <ReadError text={`Session 读取失败：${sessionError.message}`} />
          ) : !session ? (
            <Pending text="正在读取 session report…" />
          ) : session.result?.text ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-5 text-text">
              {session.result.text}
            </pre>
          ) : (
            <p className="text-[12px] leading-5 text-text-faint">该 session 尚无 report 结果。</p>
          )}
        </ChainStep>
      </div>
      <div className="mt-4 border-t border-border/70 pt-3">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint">Event stream</p>
        {/* TODO(read-model): repo.agentRuntime.events.read exposes only event headers.
            Render type/time only; never recover payloads by parsing daemon transport data. */}
        {eventsError ? (
          <ReadError text={`事件流读取失败：${eventsError.message}`} />
        ) : !events ? (
          <Pending text="正在读取事件类型与时间…" />
        ) : events.events.length === 0 ? (
          <p className="text-[11px] text-text-faint">暂无事件帧。</p>
        ) : (
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {events.events.map((event) => (
              <li key={event.cursor} className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-text-muted">{event.type}</span>
                <Timestamp value={event.occurredAt} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

const EMPTY_DECISION_LIST = { ok: true, decisions: [], warnings: [] } as const;

// W5:全局「事实分诊」列表页撤销,triage 信号并入本页签——同一关系投影上现算
// (buildFactTriage 纯前端派生,不新增读面),带信号的 fact 排前、severity 降序,
// 分诊队列的排序语义在 task 邻域内保留。
export function TaskEvidenceTab({
  task,
  tasks = [],
  relations = [],
  decisions = [],
  onNavigateEntity,
}: {
  readonly task: TaskRow;
  readonly tasks?: readonly TaskRow[];
  readonly relations?: readonly RelationEdge[];
  readonly decisions?: readonly DecisionRow[];
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const graph = useQuery({
    queryKey: triadicQueryKeys.graph(task.projectId),
    queryFn: () => harnessClient.getRelationGraph({ repoId: task.projectId }),
    staleTime: 10_000,
  });
  const facts = (graph.data?.facts ?? []).filter((fact) => fact.taskId === task.taskId);
  const triageByAnchor = useMemo(() => {
    if (!graph.data) return new Map<string, FactTriageItem>();
    const projected = buildTriadicRendererData({ graph: graph.data, decisions: EMPTY_DECISION_LIST });
    return new Map(
      buildFactTriage(projected.facts, projected.relations, projected.coverageRows, projected.factAnchors)
        .filter((item) => item.fact.taskId === task.taskId)
        .map((item) => [item.fact.anchor, item]),
    );
  }, [graph.data, task.taskId]);
  const orderedFacts = useMemo(() => {
    const anchorOf = (fact: RelationFactRow) => `${fact.taskId}/${fact.factId}`;
    const byAnchor = new Map(facts.map((fact) => [anchorOf(fact), fact]));
    const triaged = [...triageByAnchor.values()]
      .map((item) => ({ fact: byAnchor.get(item.fact.anchor), item }))
      .filter((entry): entry is { fact: RelationFactRow; item: FactTriageItem } => entry.fact !== undefined);
    const triagedAnchors = new Set(triaged.map(({ fact }) => anchorOf(fact)));
    return [
      ...triaged,
      ...facts.filter((fact) => !triagedAnchors.has(anchorOf(fact))).map((fact) => ({ fact, item: null })),
    ];
  }, [facts, triageByAnchor]);
  const signalledCount = orderedFacts.filter(({ item }) => item !== null).length;

  return (
    <section data-testid="task-evidence-tab">
      <SectionHeading
        eyebrow="FACTS"
        title="任务证据"
        description="按 taskId 从关系投影筛选；triage 信号（矛盾 / 孤儿 / 低置信 / 已被取代）在同一投影上现算"
        extra={
          facts.length > 0 ? (
            <span className="font-mono text-[11px] text-text-faint">
              {signalledCount} 条带信号 · {facts.length - signalledCount} healthy
            </span>
          ) : undefined
        }
      />
      {graph.isPending ? (
        <div className="mt-5">
          <Pending text="正在读取 facts…" />
        </div>
      ) : graph.isError ? (
        <div className="mt-5">
          <ReadError text={`Facts 读取失败：${graph.error.message}`} />
        </div>
      ) : facts.length === 0 ? (
        <div className="mt-5">
          <Empty text="该任务还没有 fact。记录可复核观察后，证据会按活性状态出现在这里。" />
        </div>
      ) : (
        <div className="mt-6 divide-y divide-border border-y border-border" data-testid="task-facts-list">
          {orderedFacts.map(({ fact, item }) => (
            <FactRow
              key={fact.factId}
              fact={fact}
              item={item}
              relations={relations}
              decisions={decisions}
              tasks={tasks}
              onNavigateEntity={onNavigateEntity}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function FactRow({
  fact,
  item,
  relations,
  decisions,
  tasks,
  onNavigateEntity,
}: {
  readonly fact: RelationFactRow;
  readonly item: FactTriageItem | null;
  readonly relations: readonly RelationEdge[];
  readonly decisions: readonly DecisionRow[];
  readonly tasks: readonly TaskRow[];
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const accent = item === null ? "" : "border-l-2 border-l-status-blocked pl-3";
  return (
    <article className={`grid gap-3 py-5 lg:grid-cols-[8rem_minmax(0,1fr)_13rem] ${accent}`}>
      <div>
        <p className="font-mono text-[11px] font-semibold text-text">{fact.factId}</p>
        <span
          className={`mt-1 inline-flex rounded px-1.5 py-0.5 font-mono text-[10px] ${fact.liveness === "standing" ? "bg-status-done/10 text-status-done" : "bg-surface-raised text-text-faint"}`}
        >
          {fact.liveness}
        </span>
      </div>
      <div className="min-w-0">
        {item && item.signals.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {item.signals.map((signal) => (
              <span
                key={signal.kind}
                title={signal.detail}
                className="inline-flex rounded border border-status-blocked/30 bg-status-blocked/10 px-1.5 py-0.5 font-mono text-[10px] text-status-blocked"
              >
                {SIGNAL_LABEL[signal.kind]}
              </span>
            ))}
            <span className="font-mono text-[10px] text-text-faint">severity {item.severity}</span>
          </div>
        )}
        <p className="text-[14px] leading-6 text-text">{fact.statement}</p>
        <p className="mt-2 break-all font-mono text-[11px] text-text-faint">source: {fact.source}</p>
        {onNavigateEntity && (
          <button
            type="button"
            data-testid={`task-fact-detail-${fact.factId}`}
            onClick={() => onNavigateEntity(`fact/${fact.taskId}/${fact.factId}`)}
            className="mt-2 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
          >
            <ArrowSquareOut weight="bold" className="text-[11px]" />
            事实详情
          </button>
        )}
      </div>
      <div className="grid content-start gap-2">
        {item && (
          <div className="flex justify-end">
            <CopyContextButton compact buildText={() => buildFactTriageContext(item, relations, decisions, tasks)} />
          </div>
        )}
        <dl className="grid content-start grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-[11px]">
          <dt className="text-text-faint">confidence</dt>
          <dd className="font-mono text-text-muted">{fact.confidence}</dd>
          <dt className="text-text-faint">observed</dt>
          <dd>
            <Timestamp value={fact.observedAt} />
          </dd>
          <dt className="text-text-faint">memory</dt>
          <dd className="font-mono text-text-muted">{fact.memoryClass}</dd>
        </dl>
      </div>
    </article>
  );
}

export function TaskRelationsTab({
  task,
  tasks = [],
  relations = [],
  decisions = [],
  onSelect,
  onNavigateDecision,
  onNavigateEntity,
  onOpenSession,
}: {
  readonly task: TaskRow;
  readonly tasks?: readonly TaskRow[];
  readonly relations?: readonly RelationEdge[];
  readonly decisions?: readonly DecisionRow[];
  readonly onSelect?: (taskId: string) => void;
  readonly onNavigateDecision?: (decisionId: string) => void;
  readonly onNavigateEntity?: (ref: string) => void;
  readonly onOpenSession: (runtimeSessionId: string) => void;
}) {
  const runtime = useQuery({
    queryKey: ["task-detail", task.projectId, task.taskId, "runtime-overview"],
    queryFn: () => agentRuntimeClient.overview(task.projectId, task.taskId),
    staleTime: 4_000,
  });
  const taskRef = `task/${task.taskId}`;
  const outEdges = relations.filter((edge) => edge.from === taskRef || normalizeTaskId(edge.from) === task.taskId);
  const inEdges = relations.filter((edge) => edge.to === taskRef || normalizeTaskId(edge.to) === task.taskId);
  const children = tasks.filter((candidate) => candidate.parentTaskId === task.taskId);
  const parent = tasks.find((candidate) => candidate.taskId === task.parentTaskId);
  const decisionIds = new Set<string>();
  for (const edge of [...outEdges, ...inEdges]) {
    for (const ref of [edge.from, edge.to]) if (ref.startsWith("decision/")) decisionIds.add(ref.split("/")[1] ?? "");
  }
  if (task.spawningDecision) decisionIds.add(task.spawningDecision);
  const relatedDecisions = decisions.filter((decision) => decisionIds.has(decision.decisionId));

  return (
    <section data-testid="task-relations-tab">
      <SectionHeading
        eyebrow="CONTEXT"
        title="任务关系"
        description="父子任务、承重决策、关系边与运行 session 的可跳转索引"
      />
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
            <p className="text-[12px] text-text-faint">这是根任务，没有 parent。</p>
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
            <p className="text-[12px] text-text-faint">没有关联 decision。</p>
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
            <Pending text="正在读取 session…" />
          ) : runtime.isError ? (
            <ReadError text={`Session 读取失败：${runtime.error.message}`} />
          ) : runtime.data.sessions.length === 0 ? (
            <p className="text-[12px] text-text-faint">没有与该任务绑定的 session。</p>
          ) : (
            runtime.data.sessions.map((session) => (
              <button
                key={session.runtimeSessionId}
                type="button"
                onClick={() => onOpenSession(session.runtimeSessionId)}
                className="group flex w-full items-center gap-3 border-b border-border/70 py-2.5 text-left last:border-b-0 hover:text-accent"
              >
                <span className="font-mono text-[11px] text-text-muted group-hover:text-accent">
                  {session.runtimeSessionId}
                </span>
                <span className="min-w-0 truncate text-[12px] text-text-faint">{session.definitionSnapshot.model}</span>
                <span className="ml-auto font-mono text-[10px] text-text-faint">{session.liveness}</span>
                <ArrowSquareOut weight="bold" className="text-[12px] text-text-faint group-hover:text-accent" />
              </button>
            ))
          )}
        </RelationGroup>

        <RelationGroup title="全部关系边" count={outEdges.length + inEdges.length}>
          {outEdges.length === 0 && inEdges.length === 0 ? (
            <p className="text-[12px] text-text-faint">没有 active relation。</p>
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

export function TaskCloseoutTab({
  task,
  mutationFeedback,
  onProgress,
  onSubmit,
}: { readonly task: TaskRow } & TaskActionProps) {
  const reviews = task.reviews ?? [],
    consents = task.consents ?? [],
    codeDocs = task.codeDocWitnesses ?? [],
    gateWitnesses = task.gateWitnesses ?? [];
  // W5:执行证据页撤销后,execution 输出/回执并入收口——从投影行原样适配
  // (model/execution-evidence),reviews/consents/gate 见证按 execution 对齐。
  const executions = useMemo(
    () =>
      task.executions === undefined || task.executionEvidence === undefined
        ? []
        : adaptTaskExecutions({
            taskId: task.taskId,
            updatedAt: task.lastKnownAt,
            snapshotAvailability: task.snapshotAvailability,
            snapshot: {
              task: { title: task.title },
              executions: task.executions,
              reviews: task.reviews ?? [],
              consents: task.consents ?? [],
              gateWitnesses: task.gateWitnesses ?? [],
            },
            executionEvidence: task.executionEvidence,
          }),
    [task],
  );
  return (
    <section data-testid="task-closeout-tab">
      <SectionHeading
        eyebrow="CLOSEOUT"
        title="收口与门"
        description="后端 closeoutAssessment、snapshot witness 与 execution 输出回执的原样展示"
      />
      <div className="mt-7 grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid content-start gap-8">
          <div className="flex flex-wrap items-center gap-3 border-y border-border py-4">
            <CloseoutBadge value={task.closeoutReadiness} />
            {task.closeoutBlocker ? (
              <span className="font-mono text-[11px] text-stale">blocker: {task.closeoutBlocker}</span>
            ) : null}
            {task.snapshotAvailability ? (
              <span className="ml-auto font-mono text-[10px] text-text-faint">
                availability · consent {task.snapshotAvailability.consents} · code/doc{" "}
                {task.snapshotAvailability.codeDocWitnesses} · gates {task.snapshotAvailability.gateWitnesses}
              </span>
            ) : null}
          </div>
          <AuditGroup title="Review" count={reviews.length}>
            {reviews.map((review) => (
              <AuditRow
                key={review.reviewId}
                id={review.reviewId}
                state={review.verdict}
                summary={review.reason}
                at={review.reviewedAt}
              />
            ))}
          </AuditGroup>
          <AuditGroup title="Consent" count={consents.length}>
            {consents.map((consent) => (
              <AuditRow
                key={consent.consentId}
                id={consent.consentId}
                state="recorded"
                summary={`review ${consent.reviewId}`}
                at={consent.consentedAt}
              />
            ))}
          </AuditGroup>
          <AuditGroup title="Code / doc witness" count={codeDocs.length}>
            {codeDocs.map((witness) => (
              <AuditRow
                key={witness.witnessId}
                id={witness.witnessId}
                state="reconciled"
                summary={witness.paths.join(", ")}
                at={witness.reconciledAt}
              />
            ))}
          </AuditGroup>
          <AuditGroup title="Gate witness" count={gateWitnesses.length}>
            {gateWitnesses.map((witness) => (
              <AuditRow
                key={witness.witnessId}
                id={witness.gateId}
                state={witness.result}
                summary={`${witness.checkerId} · ${witness.receiptId}`}
                at={witness.verifiedAt}
              />
            ))}
          </AuditGroup>
          <ExecutionOutputsGroup executions={executions} />
        </div>

        <aside className="grid content-start gap-7 border-t border-border pt-6 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-6">
          <div>
            <h3 className="text-[13px] font-semibold text-text">Gate assessment</h3>
            {task.gates.length === 0 ? (
              <p className="mt-3 text-[12px] text-text-faint">没有 completion gate。</p>
            ) : (
              <div className="mt-3 grid gap-2">
                {task.gates.map((gate) => (
                  <div key={gate.name} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 text-[11px]">
                    {gate.ok === true ? (
                      <CheckCircle weight="bold" className="mt-0.5 text-status-done" />
                    ) : gate.ok === false ? (
                      <XCircle weight="bold" className="mt-0.5 text-danger" />
                    ) : (
                      <ClockCounterClockwise weight="bold" className="mt-0.5 text-stale" />
                    )}
                    <div>
                      <p className="font-mono text-text-muted">{gate.name}</p>
                      {gate.detail ? <p className="mt-0.5 leading-5 text-text-faint">{gate.detail}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <TaskControlPanel task={task} feedback={mutationFeedback} onProgress={onProgress} onSubmit={onSubmit} />
        </aside>
      </div>
    </section>
  );
}

function AuditGroup({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-text">{title}</h3>
        <span className="font-mono text-[10px] text-text-faint">{count}</span>
      </div>
      {count === 0 ? (
        <p className="border-t border-border py-3 text-[12px] text-text-faint">暂无记录。</p>
      ) : (
        <div className="divide-y divide-border border-y border-border">{children}</div>
      )}
    </section>
  );
}

// Execution 输出与回执(原「执行证据」页的 per-task 内容):每个 execution 一块,
// 输出按 evidenceId/substrate/locator/receipt/result 逐条展示,回执判定着色。
function ExecutionOutputsGroup({ executions }: { readonly executions: readonly ExecutionEvidenceRow[] }) {
  return (
    <AuditGroup title="Execution 输出" count={executions.length}>
      {executions.map((execution) => (
        <article
          key={execution.executionId}
          data-testid={`task-execution-${execution.executionId}`}
          className="grid gap-3 py-3"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px]">
            <span className="font-semibold text-text">{execution.executionId}</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-text-muted">{field(execution.state)}</span>
            {execution.origin && (
              <span className="rounded border border-border px-1.5 py-0.5 text-text-faint">{execution.origin}</span>
            )}
            <span className="text-text-faint">
              iteration {field(execution.iteration)} · commit{" "}
              {field(execution.commitSha && execution.commitSha.slice(0, 10))}
            </span>
            <span className="ml-auto text-text-faint">
              {execution.outputs.length} outputs ·{" "}
              {execution.outputs.filter(({ isPassingReceipt }) => isPassingReceipt).length} passing
            </span>
          </div>
          {execution.outputs.length === 0 ? (
            <p className="text-[12px] text-text-faint">该 execution 没有输出记录。</p>
          ) : (
            <div className="grid gap-1">
              {execution.outputs.map((output, index) => (
                <div
                  key={`${output.evidenceId ?? "unknown"}-${index}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border/70 bg-surface-raised/35 px-2 py-1.5 font-mono text-[11px]"
                >
                  <span className="min-w-0 truncate text-text">{field(output.evidenceId)}</span>
                  <span className="min-w-0 truncate text-text-muted">
                    {field(output.substrate)} · {field(output.locator)}
                  </span>
                  <span
                    className={
                      output.isPassingReceipt
                        ? "text-status-done"
                        : output.checkerReceiptRef === null
                          ? "text-stale"
                          : "text-status-unknown"
                    }
                  >
                    {receiptField(output.checkerReceiptRef)} · {checkerResultField(output.checkerResult)}
                  </span>
                  <span className="ml-auto">
                    <CopyContextButton compact buildText={() => buildExecutionEvidenceContext(execution, output)} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </article>
      ))}
    </AuditGroup>
  );
}

function AuditRow({
  id,
  state,
  summary,
  at,
}: {
  readonly id: string;
  readonly state: string;
  readonly summary: string;
  readonly at: string;
}) {
  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[11rem_minmax(0,1fr)_9rem]">
      <div>
        <p className="font-mono text-[11px] text-text-muted">{id}</p>
        <p className="mt-0.5 font-mono text-[10px] text-text-faint">{state}</p>
      </div>
      <p className="min-w-0 break-words text-[12px] leading-5 text-text">{summary}</p>
      <Timestamp value={at} />
    </div>
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
        <LinkSimple weight="duotone" className="text-[14px] text-text-faint" />
        <h3 className="text-[13px] font-semibold text-text">{title}</h3>
        <span className="font-mono text-[10px] text-text-faint">{count}</span>
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
      <span className="w-14 shrink-0 rounded bg-surface-raised px-1 py-0.5 text-center font-mono text-[10px] text-text-faint">
        {label}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-text-muted group-hover:text-accent">{id}</span>
      <span className="min-w-0 truncate text-[12px] text-text-faint">{title}</span>
      {onClick ? (
        <ArrowSquareOut
          weight="bold"
          className="ml-auto shrink-0 text-[12px] text-text-faint group-hover:text-accent"
        />
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

function peerTitle(ref: string, tasks: readonly TaskRow[], decisions: readonly DecisionRow[]): string {
  if (ref.startsWith("decision/"))
    return decisions.find((decision) => decision.decisionId === ref.split("/")[1])?.title ?? "";
  if (ref.startsWith("task/") || !ref.includes("/"))
    return tasks.find((task) => task.taskId === normalizeTaskId(ref))?.title ?? "";
  return "";
}

function ChainStep({
  index,
  title,
  children,
}: {
  readonly index: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 border-t border-border pt-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[10px] text-accent">{index}</span>
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-muted">{title}</h3>
      </div>
      <div className="grid gap-1.5 text-[12px]">{children}</div>
    </div>
  );
}

function MetaLine({
  label,
  value,
  entityRef,
  onNavigate,
}: {
  readonly label: string;
  readonly value: string;
  /** 给了 ref+回调即渲染成实体链接(G10);不给则为非实体标识符的纯文本。 */
  readonly entityRef?: string;
  readonly onNavigate?: (ref: string) => void;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
      <span className="text-[11px] text-text-faint">{label}</span>
      {entityRef && onNavigate ? (
        <EntityRefLink
          entityRef={entityRef}
          onNavigate={onNavigate}
          title={value}
          className="min-w-0 break-all font-mono text-[11px] text-accent hover:underline"
        />
      ) : (
        <span className="min-w-0 break-all font-mono text-[11px] text-text-muted">{value}</span>
      )}
    </div>
  );
}

// Total over the dispatch wire vocabulary, so a newly added status has to declare its colour
// here rather than falling through to the faint default.
const dispatchStatusColor: Readonly<Record<TaskDispatchProjectionRow["status"], string>> = {
  running: "bg-status-active",
  succeeded: "bg-status-done",
  failed: "bg-danger",
  cancelled: "bg-text-faint",
  unknown: "bg-text-faint",
};
function StatusDot({ status }: { readonly status: TaskDispatchProjectionRow["status"] }) {
  return <span className={`size-2 rounded-full ${dispatchStatusColor[status]}`} aria-label={status} />;
}

function SectionHeading({
  eyebrow,
  title,
  description,
  extra,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly extra?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">{eyebrow}</p>
        <h2 className="mt-1 text-[18px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
        <p className="mt-1 max-w-[64ch] text-[12px] leading-5 text-text-faint">{description}</p>
      </div>
      {extra}
    </header>
  );
}

function Timestamp({ value }: { readonly value: string }) {
  return (
    <time dateTime={value} title={value} className="font-mono text-[10px] text-text-faint">
      {localDateTime(value, true) ?? value}
    </time>
  );
}

function Pending({ text }: { readonly text: string }) {
  return <p className="animate-pulse text-[12px] text-text-faint">{text}</p>;
}

function ReadError({ text }: { readonly text: string }) {
  return <p className="text-[12px] leading-5 text-danger">{text}</p>;
}

function Empty({ text }: { readonly text: string }) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-2 border border-dashed border-border-strong px-6 py-8 text-center">
      <FileText weight="duotone" className="text-xl text-text-faint" />
      <p className="max-w-lg text-[12px] leading-5 text-text-faint">{text}</p>
    </div>
  );
}
