import { useEffect, useState } from "react";
import { Funnel, Clipboard, Check, CaretDown, Package, Lightning } from "@phosphor-icons/react";
import type { TaskProjectionRow } from "../../api/renderer-dto.ts";
import { useTasksQuery } from "../task-data.ts";
import {
  useTaskExecutionsAggregation,
  type ExecutionAggregation,
  type ExecutionOutputRow,
  type ExecutionRow,
  type TaskExecutionGroup
} from "../execution-data.ts";

/**
 * 执行证据视图(mission B2 · 忠实还原 execution-view-prototype.html)。
 *
 * 核心 UX:交付主张 + 证据 + checker 验没验。
 * 排序信号 = checker receipt 状态:无 passing receipt 的交付浮顶(说做完了但没证据)。
 * 诚实呈现:几乎全是迁移归档(fact-execution-migration),outputs 是 inline 文本、无 receipt。
 *
 * 数据流：一次拉取全局 execution 投影，再按 task 在前端聚合。
 */

type FilterKey = "receiptPass" | "receiptNone" | "execArchival" | "execReal";

const FILTER_LABEL: Record<FilterKey, string> = {
  receiptPass: "有通过 receipt",
  receiptNone: "无 receipt",
  execArchival: "迁移归档",
  execReal: "真实执行"
};

export function ExecutionEvidenceView() {
  const tasksQuery = useTasksQuery();
  const tasks: ReadonlyArray<TaskProjectionRow> = tasksQuery.data?.tasks ?? [];
  const aggregation = useTaskExecutionsAggregation(tasks, tasksQuery.isLoading);

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

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="ui-title font-semibold">执行证据</h1>
          <span className="font-mono text-[13px] text-text-faint">
            按 checker receipt 状态排序 · 声称交付却无证据的浮顶
          </span>
        </div>
        <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-text-muted">
          交付主张 + 证据 + checker 验没验。核心排序信号 = checker receipt 状态:无 passing receipt 的交付浮顶
          (说做完了但没证据)。迁移归档的历史交付证据在此归宿。
        </p>
      </header>

      <StatStrip aggregation={aggregation.data} />

      <FilterBar
        aggregation={aggregation.data}
        filters={filters}
        onToggle={toggleFilter}
        loading={aggregation.isLoading}
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
      <StatItem label="执行" value={aggregation.totalExecutions} />
      <StatItem label="有执行的 task" value={aggregation.tasksWithExecutions} />
      <StatItem label="交付输出" value={aggregation.totalOutputs} />
      <StatItem label="迁移归档执行" value={aggregation.archivalExecutions} tone="warn" />
      <StatItem label="真实执行" value={aggregation.realExecutions} tone="good" />
      <StatItem label="有通过 receipt" value={aggregation.passingReceiptOutputs} tone="warn" />
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
      count: `${aggregation.archivalExecutions} 执行 · ${aggregation.totalOutputs} 输出`
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
        {loading ? "加载中…" : `${visibleTasks} task · ${visibleOutputs} output visible`}
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
      title={active ? "点击隐藏" : "点击显示"}
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
  readonly aggregation: ReturnType<typeof useTaskExecutionsAggregation>;
  readonly filters: Record<FilterKey, boolean>;
  readonly onToast: (message: string) => void;
}) {
  if (aggregation.isLoading && aggregation.data.groups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[14px] text-text-faint">
        正在加载执行投影…
      </div>
    );
  }
  if (aggregation.isError) {
    return (
      <div className="rounded-lg border border-dashed border-danger/40 bg-danger/5 px-4 py-8 text-center text-[14px] text-danger">
        读取执行投影失败。请确认 daemon 已挂账本且 bridge 路由可用。
      </div>
    );
  }

  const visibleGroups = aggregation.data.groups.filter((group) =>
    group.executions.some((execution) => executionVisible(execution, filters).execOk)
  );

  if (visibleGroups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[14px] text-text-faint">
        当前 filter chips 下没有可见的执行证据。调整上方 filter chips(至少留一个 receipt 档 + 一个执行档)。
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      {visibleGroups.map((group) => (
        <TaskSection key={group.taskId} group={group} filters={filters} onToast={onToast} />
      ))}
    </div>
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
  onToast
}: {
  readonly group: TaskExecutionGroup;
  readonly filters: Record<FilterKey, boolean>;
  readonly onToast: (message: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // 整 task 段的"全部无 receipt"汇总(用于 header 元信息)。
  const totalOutputs = group.executions.reduce((sum, execution) => sum + execution.outputs.length, 0);
  const hasAnyPassing = group.executions.some((execution) => execution.hasAnyPassingReceipt);

  return (
    <section className={`ee-task-section ${collapsed ? "ee-task-section-collapsed" : ""}`}>
      <button
        onClick={() => setCollapsed((prev) => !prev)}
        title={collapsed ? "点击展开" : "点击折叠"}
        className="ee-task-section-head"
      >
        <CaretDown weight="bold" className="ee-chevron" />
        <div className="min-w-0 flex-1">
          <div className="ee-ts-title">{group.title}</div>
          <div className="ee-ts-meta">
            <span className="ee-ts-taskid">{group.taskId}</span>
            <span className="ee-ts-exec-count">{group.executions.length} 轮执行</span>
            <span className={`ee-ts-out-count ${hasAnyPassing ? "" : "text-stale"}`}>
              {totalOutputs} 输出 · {hasAnyPassing ? "部分有 receipt" : "全部无 receipt"}
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
  const visibleOutputs = execution.outputs.filter((output) => outputVisible(output, filters));
  return (
    <div className="ee-exec-block">
      <div className="ee-exec-header">
        {execution.archival ? (
          <span className="ee-archival-badge"><Package weight="bold" className="text-[10px]" />迁移归档</span>
        ) : (
          <span className="ee-real-badge"><Lightning weight="bold" className="text-[10px]" />真实执行</span>
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
          该轮暂无可见输出
          {(!filters.receiptNone || !filters.receiptPass) ? "(受 receipt 过滤影响)。" : "。"}
        </div>
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
    onToast("已复制证据上下文");
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
            展开全文 ↓
          </button>
        )}
        <div className="ee-out-footer">
          <span className="ee-evidence-id">{output.evidenceId}</span>
          {output.hasPassingReceipt ? (
            <span className="ee-receipt-badge ee-receipt-pass"><Check weight="bold" className="text-[10px]" />通过 receipt</span>
          ) : (
            <span className="ee-receipt-badge ee-receipt-none">⧗ 无 receipt</span>
          )}
          <span className="ee-substrate-tag">{output.substrate}</span>
          {archival && <span className="ee-archival-corner"><Package weight="bold" className="text-[10px]" />归档</span>}
        </div>
      </div>
      <div className="ee-out-actions">
        <button
          onClick={onCopy}
          title="复制 agent 可用的上下文包"
          className={`ee-copy-btn ${copied ? "ee-copy-btn-copied" : ""}`}
        >
          {copied ? <Check weight="bold" className="text-[12px]" /> : <Clipboard weight="bold" className="text-[12px]" />}
          <span>{copied ? "已复制" : "复制上下文"}</span>
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
    "# 执行证据 · 上下文包",
    "",
    `evidence_id: ${output.evidenceId}`,
    `substrate: ${output.substrate}`,
    `hasReceipt: ${output.hasReceiptRef}`,
    "",
    "## 交付证据原文",
    "",
    output.text,
    "",
    `--- 复制自 Harness GUI「执行证据」 · ${new Date().toISOString()}`
  ];
  return lines.join("\n");
}
