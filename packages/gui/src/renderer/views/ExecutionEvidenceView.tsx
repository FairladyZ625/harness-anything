import { useEffect, useMemo, useState } from "react";
import { CaretDown, Funnel, Lightning, Package, WarningCircle } from "@phosphor-icons/react";
import type { TaskSnapshotProjectionRow } from "../../api/renderer-dto.ts";
import { CopyContextButton } from "../components/CopyContextButton.tsx";
import { t } from "../i18n/index.tsx";
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
          <h1 className="ui-title font-semibold">{t("views.executionEvidenceView.evidenceExecution")}</h1>
          <span className="font-mono text-[13px] text-text-faint">{t("views.executionEvidenceView.verifiedSnapshot")}</span>
        </div>
        <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-text-muted">
          {t("views.executionEvidenceView.originCheckerWitness")}
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
          {t("views.executionEvidenceView.snapshotCatchingUp")}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {queryStatus === "loading" ? (
          <EmptyState>{t("views.executionEvidenceView.loadingExecutionProjection")}</EmptyState>
        ) : queryStatus === "error" ? (
          <ErrorState error={error} onReload={onReload} onReloadFromFirst={reloadFromFirst} />
        ) : groups.length === 0 ? (
          <EmptyState>{t("views.executionEvidenceView.emptySnapshotFilter")}</EmptyState>
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
    [t("views.executionEvidenceView.statsExecutions"), stats.executions], [t("views.executionEvidenceView.statsTasksWithExecutions"), stats.tasksWithExecutions],
    [t("views.executionEvidenceView.statsOutputs"), stats.outputs], [t("views.executionEvidenceView.statsArchival"), stats.archivalExecutions],
    [t("views.executionEvidenceView.statsNative"), stats.nativeExecutions], [t("views.executionEvidenceView.statsPassingReceipt"), stats.passingReceiptOutputs],
    ...(stats.unknownOriginExecutions > 0 ? [[t("views.executionEvidenceView.statsUnknownOrigin"), stats.unknownOriginExecutions, "text-status-unknown"] as [string, number, string]] : []),
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
      <span className="mr-1 font-mono text-[11px] uppercase text-text-faint">{t("views.executionEvidenceView.receiptFilter")}</span>
      <FilterChip label={t("views.executionEvidenceView.all")} active={receipt === "all"} onClick={() => onReceipt("all")} />
      <FilterChip label={t("views.executionEvidenceView.thereReceipt")} active={receipt === "passing"} tone="good" onClick={() => onReceipt("passing")} />
      <FilterChip label={t("views.executionEvidenceView.noReceipt")} active={receipt === "no-receipt"} tone="warn" onClick={() => onReceipt("no-receipt")} />
      <span className="ml-2 mr-1 font-mono text-[11px] uppercase text-text-faint">{t("views.executionEvidenceView.originFilter")}</span>
      <FilterChip label={t("views.executionEvidenceView.all")} active={origin === "all"} onClick={() => onOrigin("all")} />
      <FilterChip label={t("views.executionEvidenceView.archive")} active={origin === "archival"} tone="warn" onClick={() => onOrigin("archival")} />
      <FilterChip label={t("views.executionEvidenceView.native")} active={origin === "native"} tone="good" onClick={() => onOrigin("native")} />
      <span className="ml-auto font-mono text-[11px] text-text-faint">{fetching ? t("views.executionEvidenceView.reload") : t("views.executionEvidenceView.visibleExecutions", { count: visible })}</span>
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
        <span className="font-mono text-[11px] text-text-muted">{t("views.executionEvidenceView.groupCounts", { executions: group.executions.length, outputs: outputCount })}</span>
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
        <span className="font-mono text-[11px] text-text-faint">{t("views.executionEvidenceView.iterationCommit", { iteration: field(execution.iteration), commit: short(execution.commitSha) })}</span>
        <span className="ml-auto font-mono text-[11px] text-text-muted">{t("views.executionEvidenceView.outputCounts", { outputs: execution.outputs.length, passing })}</span>
      </button>

      <div className="border-t border-border/70 px-3 py-2">
        <div className="mb-1.5 flex flex-wrap gap-3 font-mono text-[11px] text-text-faint">
          <span>{t("views.executionEvidenceView.outputSummary")}</span>
          <span>{t("views.executionEvidenceView.executionWitnessCounts", { reviews: execution.reviews.length, consents: execution.consents.length, gates: execution.gateWitnesses.length })}</span>
          <span className="text-status-unknown">{t("views.executionEvidenceView.notOutputReceipt")}</span>
        </div>
        {execution.outputs.length === 0 ? (
          <div className="rounded border border-dashed border-border px-2 py-2 font-mono text-[11px] text-text-faint">{t("views.executionEvidenceView.noExecutionOutput")}</div>
        ) : (
          <div className="space-y-1">
            {execution.outputs.slice(0, 3).map((output, index) => (
              <OutputSummary key={`${output.evidenceId ?? "unknown"}-${index}`} output={output} />
            ))}
            {execution.outputs.length > 3 && <div className="font-mono text-[11px] text-text-faint">{t("views.executionEvidenceView.moreOutputs", { count: execution.outputs.length - 3 })}</div>}
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
  if (origin === "native") return <span className="inline-flex items-center gap-1 rounded border border-success/30 bg-success/10 px-1.5 py-0.5 font-mono text-[11px] text-success"><Lightning weight="bold" />{t("views.executionEvidenceView.native")}</span>;
  if (origin === "archival") return <span className="inline-flex items-center gap-1 rounded border border-stale/30 bg-stale/10 px-1.5 py-0.5 font-mono text-[11px] text-stale"><Package weight="bold" />{t("views.executionEvidenceView.archive")}</span>;
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
        <Field label={t("views.executionEvidenceView.evidenceId")} value={field(output.evidenceId)} />
        <Field label={t("views.executionEvidenceView.substrate")} value={field(output.substrate)} />
        <Field label={t("views.executionEvidenceView.locator")} value={field(output.locator)} />
        <Field label={t("views.executionEvidenceView.checkerReceiptRef")} value={receiptField(output.checkerReceiptRef)} />
        <Field label={t("views.executionEvidenceView.checkerResult")} value={checkerResultField(output.checkerResult)} />
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
        <strong>{t("views.executionEvidenceView.witnessTitle")}</strong>
      </div>
      <div className="mt-2 grid gap-2 font-mono text-[11px] text-text-muted md:grid-cols-3">
        <WitnessList label={t("views.executionEvidenceView.reviewsSnapshotValidated")} values={execution.reviews.map((item) => `${item.reviewId} · ${item.verdict}`)} />
        <WitnessList label={`consents · ${execution.witnessAvailability.consents}`} values={execution.consents.map((item) => `${item.consentId} → ${item.reviewId}`)} />
        <WitnessList label={`gate · ${execution.witnessAvailability.gateWitnesses}`} values={execution.gateWitnesses.map((item) => `${item.gateId} · ${item.receiptId} · ${item.result}`)} />
      </div>
    </section>
  );
}

function WitnessList({ label, values }: { readonly label: string; readonly values: readonly string[] }) {
  return <div><strong className="text-text-faint">{label}</strong>{values.length ? values.map((value) => <div key={value} className="mt-1 break-all">{value}</div>) : <div className="mt-1 text-text-faint">{t("views.executionEvidenceView.noneCurrentCut")}</div>}</div>;
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
    <nav aria-label={t("views.executionEvidenceView.paginationLabel")} className="flex flex-wrap items-center justify-center gap-2 border-t border-border bg-surface px-4 py-2">
      <button type="button" className={button} disabled={disabled || !hasPrevious} onClick={onPrevious}>{t("views.executionEvidenceView.previousPage")}</button>
      <span className="min-w-20 text-center font-mono text-[11px] tabular-nums text-text-faint">{t("views.executionEvidenceView.pageOf", { page: pageNumber, total: totalPages })}</span>
      <button type="button" className={button} disabled={disabled || !hasNext} onClick={onNext}>{t("views.executionEvidenceView.nextPage")}</button>
      <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
      <button type="button" className={button} disabled={disabled} onClick={onReload}>{t("views.executionEvidenceView.reloadCurrentQuery")}</button>
      <button type="button" className={button} disabled={disabled} onClick={onReloadFromFirst}>{t("views.executionEvidenceView.reloadFromFirstPage")}</button>
    </nav>
  );
}

function ErrorState({ error, onReload, onReloadFromFirst }: { readonly error: unknown; readonly onReload: () => void; readonly onReloadFromFirst: () => void }) {
  const button = "rounded-md border border-danger/40 px-3 py-1.5 font-mono text-[11px] text-danger transition-colors duration-100 hover:bg-danger/10";
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/5 px-4 py-10 text-center text-[13px] text-danger">
      <WarningCircle weight="duotone" className="mx-auto mb-2 text-[26px]" />
      <div>{t("views.executionEvidenceView.readFailed", { error: error instanceof Error ? error.message : String(error ?? "unknown") })}</div>
      <div className="mt-3 flex justify-center gap-2">
        <button type="button" className={button} onClick={onReload}>{t("views.executionEvidenceView.retryCurrentQuery")}</button>
        <button type="button" className={button} onClick={onReloadFromFirst}>{t("views.executionEvidenceView.reloadFromFirstPage")}</button>
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
