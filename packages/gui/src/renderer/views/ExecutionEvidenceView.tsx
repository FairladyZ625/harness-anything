import { useEffect, useState } from "react";
import { Funnel, Clipboard, Check, CaretDown, Package, Lightning } from "@phosphor-icons/react";
import {
  useExecutionEvidenceAggregation,
  loadExecutionEvidenceOutputs,
  type ExecutionAggregation,
  type ExecutionOutputRow,
  type ExecutionRow,
  type TaskExecutionGroup
} from "../execution-data.ts";
import {
  markPerf,
  startPerfNavigation,
  FIRST_USABLE_ATTR,
  FIRST_USABLE_VIEW_ATTR,
} from "../perf/first-usable.ts";
import { t } from "../i18n/index.tsx";

/**
 * 执行证据视图(mission B2 · 忠实还原 execution-view-prototype.html)。
 *
 * 核心 UX:交付主张 + 证据 + checker 验没验。
 * 排序信号 = checker receipt 状态:无 passing receipt 的交付浮顶(说做完了但没证据)。
 * 诚实呈现:几乎全是迁移归档(fact-execution-migration),outputs 是 inline 文本、无 receipt。
 *
 * 数据流：按 task 分组读取固定大小的 keyset page，空闲时预取下一页；DOM 只保留当前页。
 */

type FilterKey = "receiptPass" | "receiptNone" | "execArchival" | "execReal";

const FILTER_LABEL: Record<FilterKey, string> = {
  get receiptPass() { return t("views.executionEvidenceView.thereReceipt"); },
  get receiptNone() { return t("views.executionEvidenceView.noReceipt"); },
  get execArchival() { return t("views.executionEvidenceView.migrateArchive"); },
  get execReal() { return t("views.executionEvidenceView.realExecution"); }
};

export function ExecutionEvidenceView() {
  const aggregation = useExecutionEvidenceAggregation();

  const [filters, setFilters] = useState<Record<FilterKey, boolean>>({
    receiptPass: true,
    receiptNone: true,
    execArchival: true,
    execReal: true
  });
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const toggleFilter = (key: FilterKey) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // 全局 toast 自动消失(每次 setToastMessage 都会重置计时)。
  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(null), 1600);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  useEffect(() => {
    startPerfNavigation("executions");
  }, []);

  const pageReady = !aggregation.isLoading || aggregation.data.groups.length > 0;
  const firstUsable = pageReady && !aggregation.isError;

  useEffect(() => {
    if (!pageReady) return;
    markPerf("executions", "data-ready", {
      pageNumber: aggregation.pageNumber,
      groupCount: aggregation.data.groups.length,
      totalExecutions: aggregation.data.totalExecutions,
    });
    markPerf("executions", "first-meaningful-rows", {
      groupCount: aggregation.data.groups.length,
    });
  }, [pageReady, aggregation.pageNumber, aggregation.data.groups.length, aggregation.data.totalExecutions]);

  useEffect(() => {
    if (!firstUsable) return;
    // Interactive page controls + stats strip + at least the empty/list body.
    markPerf("executions", "first-usable", {
      pageNumber: aggregation.pageNumber,
      hasNextPage: aggregation.hasNextPage,
      groupCount: aggregation.data.groups.length,
    });
  }, [firstUsable, aggregation.pageNumber, aggregation.hasNextPage, aggregation.data.groups.length]);

  useEffect(() => {
    if (!aggregation.hasNextPage) return;
    // Prefetch is owned by the data hook; surface background-complete once next page exists.
    markPerf("executions", "background-preload-complete", {
      pageNumber: aggregation.pageNumber,
    });
  }, [aggregation.hasNextPage, aggregation.pageNumber]);

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      {...(firstUsable
        ? { [FIRST_USABLE_ATTR]: "true", [FIRST_USABLE_VIEW_ATTR]: "executions" }
        : { "data-execution-evidence-loading": aggregation.isLoading ? "true" : "false" })}
    >
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="ui-title font-semibold">{t("views.executionEvidenceView.evidenceExecution")}</h1>
          <span className="font-mono text-[13px] text-text-faint">
            {t("views.executionEvidenceView.sortByCheckerReceiptStatusFloatingTops")}</span>
        </div>
        <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-text-muted">
          {t("views.executionEvidenceView.deliverClaimEvidenceCheckerCoreSortingSignal")}</p>
      </header>

      <StatStrip aggregation={aggregation.data} />

      <FilterBar
        aggregation={aggregation.data}
        filters={filters}
        onToggle={toggleFilter}
        loading={aggregation.isLoading || aggregation.isFetching}
      />

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <ExecutionContent aggregation={aggregation} filters={filters} onToast={setToastMessage} />
      </div>

      {toastMessage && <Toast message={toastMessage} />}
    </div>
  );
}

function StatStrip({ aggregation }: { readonly aggregation: ExecutionAggregation }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-b border-border bg-surface px-4 py-2 font-mono text-[12px]">
      <StatItem label={t("views.executionEvidenceView.execute")} value={aggregation.totalExecutions} />
      <StatItem label={t("views.executionEvidenceView.thereTasksExecuted")} value={aggregation.tasksWithExecutions} />
      <StatItem label={t("views.executionEvidenceView.deliverOutput")} value={aggregation.totalOutputs} />
      <StatItem label={t("views.executionEvidenceView.migrationArchiveExecution")} value={aggregation.archivalExecutions} tone="warn" />
      <StatItem label={t("views.executionEvidenceView.realExecution")} value={aggregation.realExecutions} tone="good" />
      <StatItem label={t("views.executionEvidenceView.thereReceipt")} value={aggregation.passingReceiptOutputs} tone="warn" />
    </div>
  );
}

function StatItem({
  label,
  value,
  tone
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: "warn" | "good";
}) {
  const valueClass =
    tone === "warn" ? "text-stale" : tone === "good" ? "text-status-done" : "text-text";
  return (
    <span className="inline-flex items-baseline gap-1 text-text-faint">
      <span className={`text-[13px] font-semibold ${valueClass}`}>{value}</span>
      <span>{label}</span>
    </span>
  );
}

function FilterBar({
  aggregation,
  filters,
  onToggle,
  loading
}: {
  readonly aggregation: ExecutionAggregation;
  readonly filters: Record<FilterKey, boolean>;
  readonly onToggle: (key: FilterKey) => void;
  readonly loading: boolean;
}) {
  const chips: ReadonlyArray<{ key: FilterKey; tone: "pass" | "none" | "archival" | "real"; count: string }> = [
    { key: "receiptPass", tone: "pass", count: `${aggregation.passingReceiptOutputs}` },
    { key: "receiptNone", tone: "none", count: `${aggregation.totalOutputs}` },
    {
      key: "execArchival",
      tone: "archival",
      count: t("views.executionEvidenceView.archivalExecutionsExecutionTotalOutputsOutput", { archivalExecutions: aggregation.archivalExecutions, totalOutputs: aggregation.totalOutputs })
    },
    { key: "execReal", tone: "real", count: `${aggregation.realExecutions}` }
  ];

  // 当前过滤下的可见 task/output 计数(execution 轴 + receipt 轴 AND)。
  let visibleTasks = 0;
  let visibleOutputs = 0;
  for (const group of aggregation.groups) {
    let anyExecVisible = false;
    for (const execution of group.executions) {
      const execOk = (execution.archival && filters.execArchival) || (!execution.archival && filters.execReal);
      if (!execOk) continue;
      anyExecVisible = true;
      for (const output of execution.outputs) {
        if ((output.hasPassingReceipt && filters.receiptPass) || (!output.hasPassingReceipt && filters.receiptNone)) {
          visibleOutputs += 1;
        }
      }
    }
    if (anyExecVisible) visibleTasks += 1;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface/40 px-4 py-2">
      <Funnel weight="bold" className="mr-0.5 text-[12px] text-text-faint" />
      {chips.map((chip) => (
        <FilterChip
          key={chip.key}
          label={FILTER_LABEL[chip.key]}
          count={chip.count}
          tone={chip.tone}
          active={filters[chip.key]}
          onClick={() => onToggle(chip.key)}
        />
      ))}
      <span className="ml-auto inline-flex items-center gap-2 font-mono text-[11px] text-text-faint">
        {loading ? t("views.executionEvidenceView.loading") : t("views.executionEvidenceView.pageVisibleTasksTaskVisibleOutputsOutputPreviewVisible", { visibleTasks: visibleTasks, visibleOutputs: visibleOutputs })}
      </span>
    </div>
  );
}

function FilterChip({
  label,
  count,
  tone,
  active,
  onClick
}: {
  readonly label: string;
  readonly count: string;
  readonly tone: "pass" | "none" | "archival" | "real";
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={active ? t("views.executionEvidenceView.clickHide") : t("views.executionEvidenceView.clickShow")}
      className={`ee-chip ee-chip-${tone} ${active ? "ee-chip-active" : ""}`}
    >
      <span className="ee-chip-label">{label}</span>
      <span className="ee-chip-count">{count}</span>
    </button>
  );
}

function ExecutionContent({
  aggregation,
  filters,
  onToast
}: {
  readonly aggregation: ReturnType<typeof useExecutionEvidenceAggregation>;
  readonly filters: Record<FilterKey, boolean>;
  readonly onToast: (message: string) => void;
}) {
  if (aggregation.isLoading && aggregation.data.groups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[14px] text-text-faint">
        {t("views.executionEvidenceView.loadingExecutionProjection")}</div>
    );
  }
  if (aggregation.isError) {
    return (
      <div className="rounded-lg border border-dashed border-danger/40 bg-danger/5 px-4 py-8 text-center text-[14px] text-danger">
        <div>{t("views.executionEvidenceView.failedReadExecutionProjectionDataGenerationMay")}</div>
        <button
          type="button"
          className="mt-3 rounded border border-danger/40 px-3 py-1.5 font-mono text-[12px]"
          onClick={aggregation.restartPagination}
        >
          {t("views.executionEvidenceView.reloadFromFirstPage")}</button>
      </div>
    );
  }

  const visibleGroups = aggregation.data.groups.filter((group) =>
    group.executions.some((execution) => executionVisible(execution, filters).execOk)
  );

  if (visibleGroups.length === 0) {
    return (
      <div className="space-y-3.5">
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[14px] text-text-faint">
          {t("views.executionEvidenceView.currentPageHasNoVisibleEvidenceExecution")}</div>
        <PageControls aggregation={aggregation} />
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      {visibleGroups.map((group, index) => (
        <TaskSection
          key={group.taskId}
          group={group}
          filters={filters}
          onToast={onToast}
          defaultCollapsed={index >= 8}
        />
      ))}
      <PageControls aggregation={aggregation} />
    </div>
  );
}

function PageControls({
  aggregation
}: {
  readonly aggregation: ReturnType<typeof useExecutionEvidenceAggregation>;
}) {
  if (!aggregation.hasPreviousPage && !aggregation.hasNextPage) return null;
  return (
    <nav aria-label={t("views.executionEvidenceView.executionEvidencePaging")} className="flex items-center justify-center gap-2 py-2 font-mono text-[12px]">
      <button
        type="button"
        className="rounded border border-border px-3 py-1.5 text-text-muted disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!aggregation.hasPreviousPage || aggregation.isFetching}
        onClick={aggregation.previousPage}
      >
        {t("views.executionEvidenceView.previousPage")}</button>
      <span className="min-w-16 text-center text-text-faint">{t("views.executionEvidenceView.no")}{aggregation.pageNumber} {t("views.executionEvidenceView.page")}</span>
      <button
        type="button"
        className="rounded border border-border px-3 py-1.5 text-text-muted disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!aggregation.hasNextPage || aggregation.isFetching}
        onClick={aggregation.nextPage}
      >
        {t("views.executionEvidenceView.nextPage")}</button>
    </nav>
  );
}

function executionVisible(
  execution: ExecutionRow,
  filters: Record<FilterKey, boolean>
): { readonly execOk: boolean; readonly anyOutputVisible: boolean } {
  const execOk = (execution.archival && filters.execArchival) || (!execution.archival && filters.execReal);
  if (!execOk) return { execOk: false, anyOutputVisible: false };
  const anyOutputVisible = execution.outputs.some(
    (output) =>
      (output.hasPassingReceipt && filters.receiptPass) ||
      (!output.hasPassingReceipt && filters.receiptNone)
  );
  return { execOk, anyOutputVisible };
}

function outputVisible(output: ExecutionOutputRow, filters: Record<FilterKey, boolean>): boolean {
  return (
    (output.hasPassingReceipt && filters.receiptPass) ||
    (!output.hasPassingReceipt && filters.receiptNone)
  );
}

function TaskSection({
  group,
  filters,
  onToast,
  defaultCollapsed = false,
}: {
  readonly group: TaskExecutionGroup;
  readonly filters: Record<FilterKey, boolean>;
  readonly onToast: (message: string) => void;
  readonly defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  // 整 task 段的"全部无 receipt"汇总(用于 header 元信息)。
  const totalOutputs = group.executions.reduce((sum, execution) => sum + execution.outputCount, 0);
  const hasAnyPassing = group.executions.some((execution) => execution.hasAnyPassingReceipt);

  return (
    <section className={`ee-task-section ${collapsed ? "ee-task-section-collapsed" : ""}`}>
      <button
        onClick={() => setCollapsed((prev) => !prev)}
        title={collapsed ? t("views.executionEvidenceView.clickExpand") : t("views.executionEvidenceView.clickCollapse")}
        className="ee-task-section-head"
      >
        <CaretDown weight="bold" className="ee-chevron" />
        <div className="min-w-0 flex-1">
          <div className="ee-ts-title">{group.title}</div>
          <div className="ee-ts-meta">
            <span className="ee-ts-taskid">{group.taskId}</span>
            <span className="ee-ts-exec-count">{t("views.executionEvidenceView.pageExecutions", { count: group.executions.length })}</span>
            <span className={`ee-ts-out-count ${hasAnyPassing ? "" : "text-stale"}`}>
              {totalOutputs} {t("views.executionEvidenceView.output")}{hasAnyPassing ? t("views.executionEvidenceView.someHaveReceipts") : t("views.executionEvidenceView.allWithoutReceipt")}
            </span>
          </div>
        </div>
      </button>
      {!collapsed && (
        <div className="ee-task-section-body">
          {group.executions.map((execution) => {
            const vis = executionVisible(execution, filters);
            if (!vis.execOk) return null;
            return (
              <ExecutionBlock
                key={execution.executionId}
                execution={execution}
                filters={filters}
                onToast={onToast}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function ExecutionBlock({
  execution,
  filters,
  onToast
}: {
  readonly execution: ExecutionRow;
  readonly filters: Record<FilterKey, boolean>;
  readonly onToast: (message: string) => void;
}) {
  const [loadedOutputs, setLoadedOutputs] = useState<ReadonlyArray<ExecutionOutputRow> | null>(null);
  const [loadingOutputs, setLoadingOutputs] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const outputs = loadedOutputs ?? execution.outputs;
  const visibleOutputs = outputs.filter((output) => outputVisible(output, filters));
  const loadAllOutputs = async () => {
    setLoadingOutputs(true);
    setLoadError(false);
    try {
      setLoadedOutputs(await loadExecutionEvidenceOutputs(execution.executionId));
    } catch {
      setLoadError(true);
    } finally {
      setLoadingOutputs(false);
    }
  };
  return (
    <div className="ee-exec-block">
      <div className="ee-exec-header">
        {execution.archival ? (
          <span className="ee-archival-badge"><Package weight="bold" className="text-[10px]" />{t("views.executionEvidenceView.migrateArchive")}</span>
        ) : (
          <span className="ee-real-badge"><Lightning weight="bold" className="text-[10px]" />{t("views.executionEvidenceView.realExecution")}</span>
        )}
        {!execution.archival && execution.executorId && (
          <span className="ee-executor-id">{execution.executorId}</span>
        )}
        <span className={`ee-state-pill ee-state-${execution.state}`}>{execution.state}</span>
        <span className="ee-exec-id">{execution.executionId}</span>
        {execution.responsibleHuman && (
          <span className="ee-responsible">@ {execution.responsibleHuman}</span>
        )}
        <span className="ee-submitted">{formatStamp(execution.submittedAt ?? execution.claimedAt)}</span>
      </div>
      {visibleOutputs.length > 0 ? (
        <div className="ee-exec-outputs">
          {visibleOutputs.map((output) => (
            <OutputCard key={output.evidenceId} output={output} archival={execution.archival} onToast={onToast} />
          ))}
        </div>
      ) : (
        <div className="ee-exec-empty">
          {t("views.executionEvidenceView.thereNoVisibleOutputRoundYet")}{(!filters.receiptNone || !filters.receiptPass) ? t("views.executionEvidenceView.affectedByReceiptFiltering") : "。"}
        </div>
      )}
      {execution.hasMoreOutputs && loadedOutputs === null && (
        <button
          type="button"
          className="mx-3 mb-3 rounded border border-border px-3 py-1.5 font-mono text-[11px] text-text-muted disabled:opacity-50"
          disabled={loadingOutputs}
          onClick={() => void loadAllOutputs()}
        >
          {loadingOutputs ? t("views.executionEvidenceView.loadingAllOutput") : t("views.executionEvidenceView.loadAllOutputCountOutputsDemand", { outputCount: execution.outputCount })}
        </button>
      )}
      {loadError && (
        <div className="mx-3 mb-3 font-mono text-[11px] text-danger">{t("views.executionEvidenceView.outputDetailsLoadingFailedPleaseTryAgain")}</div>
      )}
    </div>
  );
}

function OutputCard({
  output,
  archival,
  onToast
}: {
  readonly output: ExecutionOutputRow;
  readonly archival: boolean;
  readonly onToast: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const long_ = output.text.length > 160;
  const context = buildOutputContext(output);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(context);
    } catch {
      // 降级:secure context 不可用时用 execCommand 兜底
      const textarea = document.createElement("textarea");
      textarea.value = context;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
      } catch {
        // 静默失败:不阻塞交互
      }
      document.body.removeChild(textarea);
    }
    setCopied(true);
    onToast(t("views.executionEvidenceView.evidenceContextCopied"));
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <article className={`ee-out-card ${output.hasPassingReceipt ? "ee-out-has-receipt" : "ee-out-no-receipt"}`}>
      <div className="min-w-0 flex-1">
        <div
          className={`ee-out-text ${!expanded && long_ ? "ee-out-clamped" : ""}`}
          onClick={long_ ? () => setExpanded(true) : undefined}
          role={long_ ? "button" : undefined}
          tabIndex={long_ ? 0 : undefined}
        >
          {output.text}
        </div>
        {long_ && !expanded && (
          <button className="ee-out-expand" onClick={() => setExpanded(true)}>
            {t("views.executionEvidenceView.expandFullText")}</button>
        )}
        <div className="ee-out-footer">
          <span className="ee-evidence-id">{output.evidenceId}</span>
          {output.hasPassingReceipt ? (
            <span className="ee-receipt-badge ee-receipt-pass"><Check weight="bold" className="text-[10px]" />{t("views.executionEvidenceView.byReceipt")}</span>
          ) : (
            <span className="ee-receipt-badge ee-receipt-none">{t("views.executionEvidenceView.noReceipt2")}</span>
          )}
          <span className="ee-substrate-tag">{output.substrate}</span>
          {archival && <span className="ee-archival-corner"><Package weight="bold" className="text-[10px]" />{t("views.executionEvidenceView.archive")}</span>}
        </div>
      </div>
      <div className="ee-out-actions">
        <button
          onClick={onCopy}
          title={t("views.executionEvidenceView.copyContextPackageAvailableAgent")}
          className={`ee-copy-btn ${copied ? "ee-copy-btn-copied" : ""}`}
        >
          {copied ? <Check weight="bold" className="text-[12px]" /> : <Clipboard weight="bold" className="text-[12px]" />}
          <span>{copied ? t("views.executionEvidenceView.copied") : t("views.executionEvidenceView.copyContext")}</span>
        </button>
      </div>
    </article>
  );
}

function Toast({ message }: { readonly message: string }) {
  return (
    <div className="ee-toast ee-toast-show" role="status">
      <Check weight="bold" className="text-status-done" />
      <span>{message}</span>
    </div>
  );
}

function formatStamp(iso: string): string {
  // 2026-07-12T12:22:53.434Z -> 2026-07-12 12:22
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}

function buildOutputContext(output: ExecutionOutputRow): string {
  const lines: ReadonlyArray<string> = [
    t("views.executionEvidenceView.executionEvidenceContextPackage"),
    "",
    `evidence_id: ${output.evidenceId}`,
    `substrate: ${output.substrate}`,
    `hasReceipt: ${output.hasReceiptRef}`,
    "",
    t("views.executionEvidenceView.deliveryEvidenceOriginalText"),
    "",
    output.text,
    "",
    t("views.executionEvidenceView.copiedFromHarnessGuiExecutionEvidenceValue", { value: new Date().toISOString() })
  ];
  return lines.join("\n");
}
