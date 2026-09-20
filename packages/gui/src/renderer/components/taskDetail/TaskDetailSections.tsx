import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowSquareOut, Circle, FileText } from "@phosphor-icons/react";
import type { AgentRuntimeEventsResult, AgentRuntimeSessionResult } from "@harness-anything/daemon/protocol";
import type { RelationFactRow, TaskDispatchProjectionRow } from "../../../api/renderer-dto.ts";
import { agentRuntimeClient, runtimeQueryKeys } from "../../agent-runtime-client.ts";
import { harnessClient } from "../../api-client.ts";
import { useTaskDocumentQuery } from "../../task-data.ts";
import { buildTriadicRendererData, useCompleteRelationGraphQuery, triadicQueryKeys } from "../../triadic-data.ts";
import { useFactArchiveVisibility } from "../../fact-archive-preferences.tsx";
import { formatTime } from "../../model/time.ts";
import type { RelationEdge, TaskRow } from "../../model/types.ts";

/**
 * 关系页签实际读取的决策字段:身份 + 标题 + 状态。刻意窄于 `DecisionRow`,
 * 让它既能吃全量决策行,也能吃常驻的摘要投影——任务详情因此不必为标题查表
 * 而读 4.2 MB 的决策全量行。
 */
/**
 * 证据页签的复制上下文还要 `riskTier`/`question`——比上面的身份引用多两个字段,
 * 仍远窄于 `DecisionRow`,所以它既吃全量决策行,也吃投影原行。
 */
export interface TaskTriageDecisionRef {
  readonly decisionId: string;
  readonly title: string;
  readonly state: string;
  readonly riskTier?: string | null;
  readonly question?: string;
}
import { activeProducesFactRefs } from "../../model/triadic.ts";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { buildFactTriage, SIGNAL_LABEL, type FactTriageItem } from "../../model/fact-triage.ts";
import { buildFactTriageContext } from "../../model/copy-context.ts";
import { CopyContextButton } from "../CopyContextButton.tsx";
import { DocReader } from "../DocReader.tsx";

export function TaskOverviewTab({ task }: { readonly task: TaskRow }) {
  const plan = useTaskDocumentQuery(task.projectId, task.taskId, "task_plan.md");
  const events = task.events ?? [];

  return (
    // 时间线不独占整列:容器 <1600px 时间线作为正文下方分区随内容高度增长;
    // ≥1600px 收窄为右侧 19rem inspector,正文占满剩余宽度(量尺是 TaskDetailView 的 main 容器)。
    <div
      className="grid min-h-full gap-8 @min-[1600px]:grid-cols-[minmax(0,1fr)_19rem]"
      data-testid="task-overview-tab"
    >
      <section className="min-w-0">
        <SectionHeading eyebrow="PLAN" title="任务计划" description="目标、验收与边界的完整原文" />
        <div className="mt-4">
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

      <aside className="border-t border-border pt-6 @min-[1600px]:border-t-0 @min-[1600px]:border-l @min-[1600px]:pl-6 @min-[1600px]:pt-0">
        <SectionHeading eyebrow="TIMELINE" title="进展时间线" description={`${events.length} 条生命周期记录`} />
        {events.length === 0 ? (
          <div className="mt-4">
            <Empty text="还没有 execution、review、consent 或 gate witness 记录。" />
          </div>
        ) : (
          <ol className="mt-4 grid gap-0" data-testid="task-progress-timeline">
            {events.map((event, index) => (
              <li key={`${event.at}-${event.summary}-${index}`} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-3">
                <div className="flex flex-col items-center">
                  <Circle weight="fill" className="mt-1 ui-micro text-accent" />
                  {index < events.length - 1 ? <span className="min-h-8 w-px flex-1 bg-border" /> : null}
                </div>
                <div className="pb-5">
                  <p className="ui-body leading-5 text-text">{event.summary}</p>
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
    queryKey: runtimeQueryKeys.dispatches(task.projectId, task.taskId),
    queryFn: () => harnessClient.getTaskDispatches({ repoId: task.projectId, taskId: task.taskId }),
    staleTime: 4_000,
  });
  const rows = dispatches.data?.dispatches ?? [];
  const sessions = useQueries({
    queries: rows.map((row) => ({
      queryKey: runtimeQueryKeys.session(task.projectId, row.runtimeSessionId),
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
        <span className="font-mono ui-meta font-semibold text-text">{row.dispatchId}</span>
        <EntityRefLink
          entityRef={`session/${row.runtimeSessionId}`}
          onNavigate={onNavigateEntity}
          title={row.runtimeSessionId}
          className="font-mono ui-micro text-accent hover:underline"
        />
        <span className="ml-auto font-mono ui-micro text-text-faint">{row.status}</span>
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
          <p className="mt-3 ui-micro leading-5 text-text-faint">
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
          <MetaLine
            label="started"
            value={formatTime(row.startedAt, { style: "date-time-seconds" }) ?? row.startedAt}
          />
          <MetaLine
            label="ended"
            value={row.endedAt ? (formatTime(row.endedAt, { style: "date-time-seconds" }) ?? row.endedAt) : "运行中"}
          />
        </ChainStep>
        <ChainStep index="03" title="Report">
          {sessionError ? (
            <ReadError text={`Session 读取失败：${sessionError.message}`} />
          ) : !session ? (
            <Pending text="正在读取 session report…" />
          ) : session.result?.text ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans ui-meta leading-5 text-text">
              {session.result.text}
            </pre>
          ) : (
            <p className="ui-meta leading-5 text-text-faint">该 session 尚无 report 结果。</p>
          )}
        </ChainStep>
      </div>
      <div className="mt-4 border-t border-border/70 pt-3">
        <p className="mb-2 font-mono ui-micro uppercase tracking-[0.16em] text-text-faint">Event stream</p>
        {/* TODO(read-model): repo.agentRuntime.events.read exposes only event headers.
            Render type/time only; never recover payloads by parsing daemon transport data. */}
        {eventsError ? (
          <ReadError text={`事件流读取失败：${eventsError.message}`} />
        ) : !events ? (
          <Pending text="正在读取事件类型与时间…" />
        ) : events.events.length === 0 ? (
          <p className="ui-micro text-text-faint">暂无事件帧。</p>
        ) : (
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {events.events.map((event) => (
              <li key={event.cursor} className="flex items-center gap-2 ui-micro">
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
const emptyGraph = {
  ok: true as const,
  edges: [],
  coverageRows: [],
  factAnchors: [],
  facts: [],
  warnings: [],
};

// W5:全局「事实分诊」列表页撤销,triage 信号并入本页签——同一关系投影上现算
// (buildFactTriage 纯前端派生,不新增读面),带信号的 fact 排前、severity 降序,
// 分诊队列的排序语义在 task 邻域内保留。
// 本页签读完整三元投影(图 + 决策全量行),读面归页签自己:复制上下文要
// `riskTier`/`question` 这类只有全量决策行才带的字段,而摘要投影只够徽章与标题。
// 键与完整投影视图共享,从决策/图视图进来时命中同一份缓存。
export function TaskEvidenceTab({
  task,
  tasks = [],
  relations = [],
  onNavigateEntity,
}: {
  readonly task: TaskRow;
  readonly tasks?: readonly TaskRow[];
  readonly relations?: readonly RelationEdge[];
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const graph = useCompleteRelationGraphQuery(task.projectId, true);
  const decisionRows = useQuery({
    queryKey: triadicQueryKeys.decisions(task.projectId),
    queryFn: () => harnessClient.getDecisions({ repoId: task.projectId }),
    staleTime: 10_000,
  });
  const decisions = decisionRows.data?.decisions ?? [];
  // 三元读一次、统一过 current 收口:owned 产出边、事实行与 triage 输入共用同一份投影,
  // 不再各自消费原始边切面。
  const projected = useMemo(
    () => buildTriadicRendererData({ graph: graph.data ?? emptyGraph, decisions: EMPTY_DECISION_LIST }),
    [graph.data],
  );
  const ownedFactRefs = useMemo(
    () => new Set(activeProducesFactRefs(projected.relations, `task/${task.taskId}`).map((edge) => edge.targetRef)),
    [projected.relations, task.taskId],
  );
  // 已归档 Fact 默认退出证据列表(dec_62CAE6CA,与图/切面同一开关);开关放行时
  // 行内带「已归档」标记,不冒充活证据。
  const { showArchivedFacts } = useFactArchiveVisibility();
  const facts = useMemo(
    () =>
      (graph.data?.facts ?? []).filter(
        (fact) => ownedFactRefs.has(fact.ref) && (showArchivedFacts || fact.archived !== true),
      ),
    [graph.data, ownedFactRefs, showArchivedFacts],
  );
  const triageByAnchor = useMemo(
    () =>
      new Map(
        buildFactTriage(projected.facts, projected.relations, projected.coverageRows, projected.factAnchors)
          .filter((item) =>
            ownedFactRefs.has(item.fact.anchor.startsWith("fact/") ? item.fact.anchor : `fact/${item.fact.anchor}`),
          )
          .map((item) => [item.fact.anchor, item]),
      ),
    [ownedFactRefs, projected],
  );
  const orderedFacts = useMemo(() => {
    const anchorOf = (fact: RelationFactRow) => fact.ref;
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
            <span className="ml-auto shrink-0 font-mono ui-micro text-text-faint">
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
  readonly decisions: readonly TaskTriageDecisionRef[];
  readonly tasks: readonly TaskRow[];
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const accent = item === null ? "" : "border-l-2 border-l-status-blocked pl-3";
  return (
    <article className={`grid gap-3 py-5 lg:grid-cols-[8rem_minmax(0,1fr)_13rem] ${accent}`}>
      <div>
        <p className="font-mono ui-micro font-semibold text-text">{fact.factId}</p>
        <span
          className={`mt-1 inline-flex rounded px-1.5 py-0.5 font-mono ui-micro ${fact.liveness === "standing" ? "bg-status-done/10 text-status-done" : "bg-surface-raised text-text-faint"}`}
        >
          {fact.liveness}
        </span>
        {fact.archived === true && (
          <span className="mt-1 inline-flex rounded bg-surface-raised px-1.5 py-0.5 font-mono ui-micro text-text-faint">
            已归档
          </span>
        )}
      </div>
      <div className="min-w-0">
        {item && item.signals.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {item.signals.map((signal) => (
              <span
                key={signal.kind}
                title={signal.detail}
                className="inline-flex rounded border border-status-blocked/30 bg-status-blocked/10 px-1.5 py-0.5 font-mono ui-micro text-status-blocked"
              >
                {SIGNAL_LABEL[signal.kind]}
              </span>
            ))}
            <span className="font-mono ui-micro text-text-faint">severity {item.severity}</span>
          </div>
        )}
        <p className="ui-body leading-6 text-text">{fact.statement}</p>
        <p className="mt-2 break-all font-mono ui-micro text-text-faint">source: {fact.source}</p>
        {onNavigateEntity && (
          <button
            type="button"
            data-testid={`task-fact-detail-${fact.factId}`}
            onClick={() => onNavigateEntity(`fact/${fact.factId}`)}
            className="mt-2 inline-flex items-center gap-1 ui-micro text-accent hover:underline"
          >
            <ArrowSquareOut weight="bold" className="ui-micro" />
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
        <dl className="grid content-start grid-cols-[5rem_1fr] gap-x-2 gap-y-1 ui-micro">
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
        <span className="font-mono ui-micro text-accent">{index}</span>
        <h3 className="ui-meta font-semibold uppercase tracking-[0.12em] text-text-muted">{title}</h3>
      </div>
      <div className="grid gap-1.5 ui-meta">{children}</div>
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
      <span className="ui-micro text-text-faint">{label}</span>
      {entityRef && onNavigate ? (
        <EntityRefLink
          entityRef={entityRef}
          onNavigate={onNavigate}
          title={value}
          className="min-w-0 break-all font-mono ui-micro text-accent hover:underline"
        />
      ) : (
        <span className="min-w-0 break-all font-mono ui-micro text-text-muted">{value}</span>
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
  lost: "bg-text-faint",
};
function StatusDot({ status }: { readonly status: TaskDispatchProjectionRow["status"] }) {
  return <span className={`size-2 rounded-full ${dispatchStatusColor[status]}`} aria-label={status} />;
}

// 信息密度(task_9f39e256):分区标题从三行(eyebrow/标题/描述)压成单行 inline 条——
// eyebrow + 标题 + 描述同行基线对齐,描述截断;信息一条不少,高度从 ~67px 降到 ~20px。
export function SectionHeading({
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
    <header className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1" data-testid="task-section-heading">
      <p className="shrink-0 font-mono ui-micro font-semibold uppercase tracking-[0.16em] text-accent">{eyebrow}</p>
      <h2 className="shrink-0 ui-body font-semibold tracking-[-0.01em] text-text">{title}</h2>
      <p className="min-w-0 truncate ui-micro leading-4 text-text-faint">{description}</p>
      {extra}
    </header>
  );
}

export function Timestamp({ value }: { readonly value: string }) {
  return (
    <time dateTime={value} title={value} className="font-mono ui-micro text-text-faint">
      {formatTime(value, { style: "date-time-seconds" }) ?? value}
    </time>
  );
}

function Pending({ text }: { readonly text: string }) {
  return <p className="animate-pulse ui-meta text-text-faint">{text}</p>;
}

export function ReadError({ text }: { readonly text: string }) {
  return <p className="ui-meta leading-5 text-danger">{text}</p>;
}

function Empty({ text }: { readonly text: string }) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-2 border border-dashed border-border-strong px-6 py-8 text-center">
      <FileText weight="duotone" className="text-xl text-text-faint" />
      <p className="max-w-lg ui-meta leading-5 text-text-faint">{text}</p>
    </div>
  );
}
