import { useEffect, useMemo, useState } from "react";
import { CaretDown, Funnel, Lightning, Package, WarningCircle } from "@phosphor-icons/react";
import type { TaskSnapshotProjectionRow } from "../../api/renderer-dto.ts";
import { CopyContextButton } from "../components/CopyContextButton.tsx";
import {
  aggregateExecutionEvidence,
  buildExecutionEvidenceContext,
  checkerResultField,
  field,
  filterExecutionEvidence,
  paginateExecutionEvidence,
  receiptField,
  type ExecutionEvidenceFilters,
  type ExecutionEvidenceOutput,
  type ExecutionEvidenceRow,
  type ExecutionEvidenceStats,
} from "../model/execution-evidence.ts";

interface ExecutionEvidenceViewProps {
  readonly rows: readonly TaskSnapshotProjectionRow[];
  readonly queryStatus: "loading" | "ready" | "error";
  readonly projectionStatus?: "ready" | "pending";
  readonly isFetching?: boolean;
  readonly error?: unknown;
  readonly onReload: () => void;
  readonly onReloadFromFirst: () => void;
}

export function ExecutionEvidenceView({
  rows,
  queryStatus,
  projectionStatus = "ready",
  isFetching = false,
  error,
  onReload,
  onReloadFromFirst,
}: ExecutionEvidenceViewProps) {
  const [receipt, setReceipt] = useState<ExecutionEvidenceFilters["receipt"]>("all");
  const [origin, setOrigin] = useState<ExecutionEvidenceFilters["origin"]>("all");
  const [pageIndex, setPageIndex] = useState(0);
  const model = useMemo(() => aggregateExecutionEvidence(rows), [rows]);
  const filtered = useMemo(() => filterExecutionEvidence(model.executions, { receipt, origin }), [model.executions, receipt, origin]);
  const page = useMemo(() => paginateExecutionEvidence(filtered, pageIndex), [filtered, pageIndex]);
  const groups = useMemo(() => groupExecutions(page.executions), [page.executions]);

  useEffect(() => setPageIndex(0), [receipt, origin]);
  useEffect(() => {
    if (pageIndex >= page.totalPages) setPageIndex(page.totalPages - 1);
  }, [pageIndex, page.totalPages]);

  const reloadFromFirst = () => {
    setPageIndex(0);
    onReloadFromFirst();
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="ui-title font-semibold">执行证据</h1>
          <span className="font-mono text-[13px] text-text-faint">task → execution → output · verified snapshot</span>
        </div>
        <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-text-muted">
          origin 与 checker receipt 均直接消费 daemon 投影；execution-level witness 只说明 execution cut，不等同 output receipt。
        </p>
      </header>

      <StatsStrip stats={model.stats} />
      <FilterBar
        receipt={receipt}
        origin={origin}
        visible={filtered.length}
        fetching={isFetching}
        onReceipt={setReceipt}
        onOrigin={setOrigin}
      />

      {projectionStatus === "pending" && queryStatus !== "error" && (
        <div className="border-b border-stale/30 bg-stale/10 px-4 py-2 font-mono text-[11px] text-stale">
          task snapshot 正在追赶 source revision；当前页可读但标记 stale，reload 会重读同一 query。
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {queryStatus === "loading" ? (
          <EmptyState>正在读取 execution evidence projection…</EmptyState>
        ) : queryStatus === "error" ? (
          <ErrorState error={error} onReload={onReload} onReloadFromFirst={reloadFromFirst} />
        ) : groups.length === 0 ? (
          <EmptyState>当前 snapshot 在所选 filter 下没有 execution evidence。</EmptyState>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => <TaskEvidenceGroup key={group.taskId} group={group} />)}
          </div>
        )}
      </div>

      {queryStatus === "ready" && (
        <PageControls
          pageNumber={page.pageNumber}
          totalPages={page.totalPages}
          hasPrevious={page.hasPreviousPage}
          hasNext={page.hasNextPage}
          disabled={isFetching}
          onPrevious={() => setPageIndex((value) => Math.max(0, value - 1))}
          onNext={() => setPageIndex((value) => value + 1)}
          onReload={onReload}
          onReloadFromFirst={reloadFromFirst}
        />
      )}
    </div>
  );
}

function StatsStrip({ stats }: { readonly stats: ExecutionEvidenceStats }) {
  const values: [label: string, value: number, tone?: string][] = [
    ["executions", stats.executions], ["有 execution 的 tasks", stats.tasksWithExecutions],
    ["outputs", stats.outputs], ["origin=archival", stats.archivalExecutions],
    ["origin=native", stats.nativeExecutions], ["passing receipt outputs", stats.passingReceiptOutputs],
    ...(stats.unknownOriginExecutions > 0 ? [["unknown origin", stats.unknownOriginExecutions, "text-status-unknown"] as [string, number, string]] : []),
  ];
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-px border-b border-border bg-border">
      {values.map(([label, value, tone]) => (
        <div key={label} className="bg-surface px-3 py-2">
          <div className={`font-mono text-[18px] font-semibold leading-tight tabular-nums ${tone ?? "text-text"}`}>{value}</div>
          <div className={`mt-0.5 truncate font-mono text-[11px] ${tone ?? "text-text-faint"}`} title={label}>{label}</div>
        </div>
      ))}
    </div>
  );
}

function FilterBar({ receipt, origin, visible, fetching, onReceipt, onOrigin }: {
  readonly receipt: ExecutionEvidenceFilters["receipt"];
  readonly origin: ExecutionEvidenceFilters["origin"];
  readonly visible: number;
  readonly fetching: boolean;
  readonly onReceipt: (value: ExecutionEvidenceFilters["receipt"]) => void;
  readonly onOrigin: (value: ExecutionEvidenceFilters["origin"]) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface/50 px-4 py-2">
      <Funnel weight="bold" className="text-[12px] text-text-faint" />
      <span className="mr-1 font-mono text-[11px] uppercase text-text-faint">receipt</span>
      <FilterChip label="全部" active={receipt === "all"} onClick={() => onReceipt("all")} />
      <FilterChip label="有通过 receipt" active={receipt === "passing"} tone="good" onClick={() => onReceipt("passing")} />
      <FilterChip label="无 receipt" active={receipt === "no-receipt"} tone="warn" onClick={() => onReceipt("no-receipt")} />
      <span className="ml-2 mr-1 font-mono text-[11px] uppercase text-text-faint">origin</span>
      <FilterChip label="全部" active={origin === "all"} onClick={() => onOrigin("all")} />
      <FilterChip label="归档" active={origin === "archival"} tone="warn" onClick={() => onOrigin("archival")} />
      <FilterChip label="原生" active={origin === "native"} tone="good" onClick={() => onOrigin("native")} />
      <span className="ml-auto font-mono text-[11px] text-text-faint">{fetching ? "reload…" : `${visible} visible executions`}</span>
    </div>
  );
}

function FilterChip({ label, active, tone = "neutral", onClick }: {
  readonly label: string;
  readonly active: boolean;
  readonly tone?: "neutral" | "good" | "warn";
  readonly onClick: () => void;
}) {
  const activeTone = tone === "good" ? "border-success/40 bg-success/10 text-success"
    : tone === "warn" ? "border-stale/40 bg-stale/10 text-stale" : "border-border-strong bg-surface-raised text-text";
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={`rounded-md border px-2 py-1 font-mono text-[11px] transition-colors duration-100 ${active ? activeTone : "border-border text-text-faint opacity-70 hover:border-border-strong hover:opacity-100"}`}>
      {label}
    </button>
  );
}

interface TaskEvidenceGroupModel {
  readonly taskId: string;
  readonly title: string;
  readonly executions: readonly ExecutionEvidenceRow[];
}

function TaskEvidenceGroup({ group }: { readonly group: TaskEvidenceGroupModel }) {
  const [expanded, setExpanded] = useState(true);
  const outputCount = group.executions.reduce((total, item) => total + item.outputs.length, 0);
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-raised/50">
        <CaretDown weight="bold" className={`shrink-0 text-text-faint transition-transform ${expanded ? "" : "-rotate-90"}`} />
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-[14px] text-text">{group.title}</strong>
          <span className="block truncate font-mono text-[11px] text-text-faint">{group.taskId}</span>
        </span>
        <span className="font-mono text-[11px] text-text-muted">{group.executions.length} executions · {outputCount} outputs</span>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border bg-bg/25 px-3 py-2.5">
          {group.executions.map((execution) => <ExecutionBlock key={execution.executionId} execution={execution} />)}
        </div>
      )}
    </section>
  );
}

function ExecutionBlock({ execution }: { readonly execution: ExecutionEvidenceRow }) {
  const [expanded, setExpanded] = useState(false);
  const passing = execution.outputs.filter(({ isPassingReceipt }) => isPassingReceipt).length;
  return (
    <article className="rounded-md border border-border bg-bg/35">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised/45">
        <CaretDown weight="bold" className={`text-text-faint transition-transform ${expanded ? "" : "-rotate-90"}`} />
        <OriginBadge origin={execution.origin} />
        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-text-muted">{field(execution.state)}</span>
        <strong className="font-mono text-[12px] text-text">{execution.executionId}</strong>
        <span className="font-mono text-[11px] text-text-faint">iteration {field(execution.iteration)} · commit {short(execution.commitSha)}</span>
        <span className="ml-auto font-mono text-[11px] text-text-muted">{execution.outputs.length} outputs · {passing} passing</span>
      </button>

      <div className="border-t border-border/70 px-3 py-2">
        <div className="mb-1.5 flex flex-wrap gap-3 font-mono text-[11px] text-text-faint">
          <span>output 摘要（展开查看全量原文）</span>
          <span>execution-level witnesses: review {execution.reviews.length} · consent {execution.consents.length} · gate {execution.gateWitnesses.length}</span>
          <span className="text-status-unknown">不等同 output receipt</span>
        </div>
        {execution.outputs.length === 0 ? (
          <div className="rounded border border-dashed border-border px-2 py-2 font-mono text-[11px] text-text-faint">该 execution 没有 output。</div>
        ) : (
          <div className="space-y-1">
            {execution.outputs.slice(0, 3).map((output, index) => (
              <OutputSummary key={`${output.evidenceId ?? "unknown"}-${index}`} output={output} />
            ))}
            {execution.outputs.length > 3 && <div className="font-mono text-[11px] text-text-faint">+ {execution.outputs.length - 3} outputs，展开查看</div>}
          </div>
        )}
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <div className="space-y-2">
            {execution.outputs.map((output, index) => <OutputDetail key={`${output.evidenceId ?? "unknown"}-${index}`} execution={execution} output={output} />)}
          </div>
          <WitnessPanel execution={execution} />
        </div>
      )}
    </article>
  );
}

function OriginBadge({ origin }: { readonly origin: ExecutionEvidenceRow["origin"] }) {
  if (origin === "native") return <span className="inline-flex items-center gap-1 rounded border border-success/30 bg-success/10 px-1.5 py-0.5 font-mono text-[11px] text-success"><Lightning weight="bold" />原生</span>;
  if (origin === "archival") return <span className="inline-flex items-center gap-1 rounded border border-stale/30 bg-stale/10 px-1.5 py-0.5 font-mono text-[11px] text-stale"><Package weight="bold" />归档</span>;
  return <span className="inline-flex items-center gap-1 rounded border border-status-unknown/30 px-1.5 py-0.5 font-mono text-[11px] text-status-unknown"><WarningCircle weight="bold" />{field(origin)}</span>;
}

function OutputSummary({ output }: { readonly output: ExecutionEvidenceOutput }) {
  return (
    <div className="grid gap-x-3 gap-y-0.5 rounded border border-border/70 bg-surface-raised/35 px-2 py-1.5 font-mono text-[11px] md:grid-cols-[minmax(11rem,0.8fr)_minmax(14rem,1.4fr)_minmax(10rem,0.8fr)]">
      <span className="truncate text-text">{field(output.evidenceId)}</span>
      <span className="truncate text-text-muted">{field(output.substrate)} · {field(output.locator)}</span>
      <span className={output.isPassingReceipt ? "text-success" : output.checkerReceiptRef === null ? "text-stale" : "text-status-unknown"}>
        {receiptField(output.checkerReceiptRef)} · {checkerResultField(output.checkerResult)}
      </span>
    </div>
  );
}

function OutputDetail({ execution, output }: { readonly execution: ExecutionEvidenceRow; readonly output: ExecutionEvidenceOutput }) {
  return (
    <section className="rounded-md border border-border bg-surface-raised/30 p-2.5">
      <div className="grid gap-1 font-mono text-[11px] sm:grid-cols-2">
        <Field label="evidenceId" value={field(output.evidenceId)} />
        <Field label="substrate" value={field(output.substrate)} />
        <Field label="locator" value={field(output.locator)} />
        <Field label="checker receipt ref" value={receiptField(output.checkerReceiptRef)} />
        <Field label="checker result" value={checkerResultField(output.checkerResult)} />
      </div>
      <div className="mt-2 flex justify-end">
        <CopyContextButton compact buildText={() => buildExecutionEvidenceContext(execution, output)} />
      </div>
    </section>
  );
}

function WitnessPanel({ execution }: { readonly execution: ExecutionEvidenceRow }) {
  return (
    <section className="rounded-md border border-status-unknown/25 bg-status-unknown/5 p-2.5">
      <div className="flex items-center gap-2 text-[11px] text-status-unknown">
        <WarningCircle weight="bold" />
        <strong>execution-level witnesses · 不等同 output receipt</strong>
      </div>
      <div className="mt-2 grid gap-2 font-mono text-[11px] text-text-muted md:grid-cols-3">
        <WitnessList label="reviews · snapshot-validated" values={execution.reviews.map((item) => `${item.reviewId} · ${item.verdict}`)} />
        <WitnessList label={`consents · ${execution.witnessAvailability.consents}`} values={execution.consents.map((item) => `${item.consentId} → ${item.reviewId}`)} />
        <WitnessList label={`gate · ${execution.witnessAvailability.gateWitnesses}`} values={execution.gateWitnesses.map((item) => `${item.gateId} · ${item.receiptId} · ${item.result}`)} />
      </div>
    </section>
  );
}

function WitnessList({ label, values }: { readonly label: string; readonly values: readonly string[] }) {
  return <div><strong className="text-text-faint">{label}</strong>{values.length ? values.map((value) => <div key={value} className="mt-1 break-all">{value}</div>) : <div className="mt-1 text-text-faint">none / 当前 cut 无记录</div>}</div>;
}

function Field({ label, value }: { readonly label: string; readonly value: string }) {
  return <span className="min-w-0"><strong className="text-text-faint">{label}: </strong><span className="break-all text-text-muted">{value}</span></span>;
}

function PageControls({ pageNumber, totalPages, hasPrevious, hasNext, disabled, onPrevious, onNext, onReload, onReloadFromFirst }: {
  readonly pageNumber: number; readonly totalPages: number; readonly hasPrevious: boolean; readonly hasNext: boolean; readonly disabled: boolean;
  readonly onPrevious: () => void; readonly onNext: () => void; readonly onReload: () => void; readonly onReloadFromFirst: () => void;
}) {
  const button = "rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-[11px] text-text-muted transition-colors duration-100 hover:border-border-strong hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text-muted";
  return (
    <nav aria-label="execution evidence 分页" className="flex flex-wrap items-center justify-center gap-2 border-t border-border bg-surface px-4 py-2">
      <button type="button" className={button} disabled={disabled || !hasPrevious} onClick={onPrevious}>上一页</button>
      <span className="min-w-20 text-center font-mono text-[11px] tabular-nums text-text-faint">第 {pageNumber} / {totalPages} 页</span>
      <button type="button" className={button} disabled={disabled || !hasNext} onClick={onNext}>下一页</button>
      <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
      <button type="button" className={button} disabled={disabled} onClick={onReload}>reload 当前 query</button>
      <button type="button" className={button} disabled={disabled} onClick={onReloadFromFirst}>从第一页重新加载</button>
    </nav>
  );
}

function ErrorState({ error, onReload, onReloadFromFirst }: { readonly error: unknown; readonly onReload: () => void; readonly onReloadFromFirst: () => void }) {
  const button = "rounded-md border border-danger/40 px-3 py-1.5 font-mono text-[11px] text-danger transition-colors duration-100 hover:bg-danger/10";
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/5 px-4 py-10 text-center text-[13px] text-danger">
      <WarningCircle weight="duotone" className="mx-auto mb-2 text-[26px]" />
      <div>读取 execution evidence 失败：{error instanceof Error ? error.message : String(error ?? "unknown")}</div>
      <div className="mt-3 flex justify-center gap-2">
        <button type="button" className={button} onClick={onReload}>重试当前查询</button>
        <button type="button" className={button} onClick={onReloadFromFirst}>从第一页重新加载</button>
      </div>
    </div>
  );
}

function EmptyState({ children }: { readonly children: string }) {
  return <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-[13px] leading-relaxed text-text-faint">{children}</div>;
}

function groupExecutions(executions: readonly ExecutionEvidenceRow[]): TaskEvidenceGroupModel[] {
  const groups = new Map<string, TaskEvidenceGroupModel>();
  for (const execution of executions) {
    const current = groups.get(execution.taskId);
    groups.set(execution.taskId, current
      ? { ...current, executions: [...current.executions, execution] }
      : { taskId: execution.taskId, title: execution.taskTitle, executions: [execution] });
  }
  return [...groups.values()];
}

function short(value: string | undefined): string {
  return value ? value.slice(0, 10) : field(value);
}
