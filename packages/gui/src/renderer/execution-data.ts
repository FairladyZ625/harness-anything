import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ExecutionEvidenceCursor,
  ExecutionEvidencePagePayload,
  ExecutionProjectionRow,
  ProjectionJsonObject,
  ProjectionJsonValue,
  TaskProjectionRow
} from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";

/**
 * 执行证据兼容聚合与分页数据 hooks。
 *
 * 新页面使用一个 SQL-backed keyset page route；旧聚合函数保留给兼容消费者和纯函数测试。
 *
 * DTO 的 outputs/primaryActor 字段是 ProjectionJsonValue(不透明 JSON),
 * 在此文件用 narrow* helpers 现场解析为 ExecutionOutput / Actor。
 */

export const executionQueryKeys = {
  all: ["harness", "executions"] as const,
  evidencePage: (repoId: string | null | undefined, cursor?: ExecutionEvidenceCursor) =>
    ["harness", "execution-evidence", repoId ?? "default", cursor ?? "first"] as const
};

const executionEvidencePageSize = 25;

/** 迁移归档执行者的 executor.id(kernel 中写死的历史归档源)。 */
export const ARCHIVAL_EXECUTOR_ID = "fact-execution-migration";

export interface ExecutionRow {
  readonly executionId: string;
  readonly taskRef: string;
  readonly taskId: string;
  readonly state: string;
  readonly executorId: string;
  readonly executorKind: string;
  readonly responsibleHuman: string;
  readonly claimedAt: string;
  readonly submittedAt: string | null;
  readonly closedAt: string | null;
  readonly outputs: ReadonlyArray<ExecutionOutputRow>;
  readonly outputCount: number;
  readonly hasMoreOutputs: boolean;
  /** 是否任一输出带 passing checker receipt。 */
  readonly hasAnyPassingReceipt: boolean;
  readonly archival: boolean;
}

export interface ExecutionOutputRow {
  readonly evidenceId: string;
  readonly text: string;
  readonly substrate: string;
  /** 该输出是否带 passing checker receipt(substrate=checker_receipt + result=pass)。 */
  readonly hasPassingReceipt: boolean;
  /** 该输出是否引用了一个 checker receipt(无论 pass/fail)。 */
  readonly hasReceiptRef: boolean;
}

export interface TaskExecutionGroup {
  readonly taskId: string;
  readonly title: string;
  readonly executions: ReadonlyArray<ExecutionRow>;
}

export interface ExecutionAggregation {
  readonly groups: ReadonlyArray<TaskExecutionGroup>;
  readonly totalExecutions: number;
  readonly archivalExecutions: number;
  readonly realExecutions: number;
  readonly totalOutputs: number;
  readonly passingReceiptOutputs: number;
  readonly tasksWithExecutions: number;
}

export function useExecutionEvidenceAggregation(repoId?: string | null): {
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly data: ExecutionAggregation;
  readonly pageNumber: number;
  readonly hasPreviousPage: boolean;
  readonly hasNextPage: boolean;
  readonly previousPage: () => void;
  readonly nextPage: () => void;
  readonly restartPagination: () => void;
} {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<ExecutionEvidenceCursor | undefined>();
  const [history, setHistory] = useState<ReadonlyArray<ExecutionEvidenceCursor | undefined>>([]);
  const payload = evidencePagePayload(cursor, repoId);
  const query = useQuery({
    queryKey: executionQueryKeys.evidencePage(repoId, cursor),
    queryFn: () => harnessClient.getExecutionEvidencePage(payload),
    staleTime: 10_000
  });
  const nextCursor = query.data?.nextCursor ?? null;

  useEffect(() => {
    if (!nextCursor) return;
    const prefetch = () => queryClient.prefetchQuery({
      queryKey: executionQueryKeys.evidencePage(repoId, nextCursor),
      queryFn: () => harnessClient.getExecutionEvidencePage(evidencePagePayload(nextCursor, repoId)),
      staleTime: 10_000
    });
    const idleId = window.requestIdleCallback(() => void prefetch(), { timeout: 750 });
    return () => window.cancelIdleCallback(idleId);
  }, [nextCursor, queryClient, repoId]);

  // Reset pagination when the active repo changes so pages don't mix generations.
  useEffect(() => {
    setCursor(undefined);
    setHistory([]);
  }, [repoId]);

  const previousPage = useCallback(() => {
    setHistory((previous) => {
      if (previous.length === 0) return previous;
      setCursor(previous.at(-1));
      return previous.slice(0, -1);
    });
  }, []);
  const nextPage = useCallback(() => {
    if (!nextCursor) return;
    setHistory((previous) => [...previous, cursor]);
    setCursor(nextCursor);
  }, [cursor, nextCursor]);
  const restartPagination = useCallback(() => {
    setCursor(undefined);
    setHistory([]);
    void queryClient.invalidateQueries({ queryKey: ["harness", "execution-evidence"] });
  }, [queryClient]);
  const data = useMemo<ExecutionAggregation>(() => ({
    groups: query.data?.groups ?? [],
    totalExecutions: query.data?.stats.totalExecutions ?? 0,
    archivalExecutions: query.data?.stats.archivalExecutions ?? 0,
    realExecutions: query.data?.stats.realExecutions ?? 0,
    totalOutputs: query.data?.stats.totalOutputs ?? 0,
    passingReceiptOutputs: query.data?.stats.passingReceiptOutputs ?? 0,
    tasksWithExecutions: query.data?.stats.tasksWithExecutions ?? 0
  }), [query.data]);

  return {
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error ?? null,
    data,
    pageNumber: history.length + 1,
    hasPreviousPage: history.length > 0,
    hasNextPage: nextCursor !== null,
    previousPage,
    nextPage,
    restartPagination
  };
}

/**
 * 把 per-task 的执行投影行聚合成渲染分组,并同步算出统计量。
 * 纯函数:不读 window/DOM,可在测试里直接喂 DTO fixture 跑。
 */
export function aggregateExecutions(
  tasks: ReadonlyArray<TaskProjectionRow>,
  executions: ReadonlyArray<ExecutionProjectionRow>
): ExecutionAggregation {
  const titleByTaskId = new Map<string, string>();
  for (const task of tasks) titleByTaskId.set(task.taskId, task.title);

  const groups: TaskExecutionGroup[] = [];
  let totalExecutions = 0;
  let archivalExecutions = 0;
  let realExecutions = 0;
  let totalOutputs = 0;
  let passingReceiptOutputs = 0;
  let tasksWithExecutions = 0;

  const executionsByTask = new Map<string, ExecutionProjectionRow[]>();
  for (const execution of executions) {
    const rows = executionsByTask.get(execution.taskId) ?? [];
    rows.push(execution);
    executionsByTask.set(execution.taskId, rows);
  }

  for (const [taskId, taskExecutions] of executionsByTask) {
    tasksWithExecutions += 1;
    const adaptedRows: ExecutionRow[] = taskExecutions.map(adaptExecutionRow);
    for (const row of adaptedRows) {
      totalExecutions += 1;
      if (row.archival) archivalExecutions += 1;
      else realExecutions += 1;
      totalOutputs += row.outputs.length;
      for (const output of row.outputs) {
        if (output.hasPassingReceipt) passingReceiptOutputs += 1;
      }
    }
    groups.push({
      taskId,
      title: titleByTaskId.get(taskId) ?? taskId,
      executions: adaptedRows
    });
  }

  // task 分组按最新 submitted/claimed 时间倒序排。
  groups.sort((a, b) => latestSubmittedAt(b.executions).localeCompare(latestSubmittedAt(a.executions)));

  return {
    groups,
    totalExecutions,
    archivalExecutions,
    realExecutions,
    totalOutputs,
    passingReceiptOutputs,
    tasksWithExecutions
  };
}

function latestSubmittedAt(executions: ReadonlyArray<ExecutionRow>): string {
  let latest = "";
  for (const execution of executions) {
    const stamp = execution.submittedAt ?? execution.claimedAt ?? "";
    if (stamp > latest) latest = stamp;
  }
  return latest;
}

function adaptExecutionRow(row: ExecutionProjectionRow): ExecutionRow {
  const actor = narrowObject(row.primaryActor);
  const executorObj = narrowFieldObject(actor, "executor");
  const executorId = typeof executorObj?.id === "string" ? executorObj.id : "";
  const executorKind = typeof executorObj?.kind === "string" ? executorObj.kind : "";
  const responsibleHuman = typeof actor?.responsibleHuman === "string" ? actor.responsibleHuman : "";
  const archival = executorId === ARCHIVAL_EXECUTOR_ID;

  const outputs = adaptOutputRows(row.outputs ?? []);

  const hasAnyPassingReceipt = outputs.some((output) => output.hasPassingReceipt);

  return {
    executionId: row.executionId,
    taskRef: row.taskRef,
    taskId: row.taskId,
    state: row.state,
    executorId,
    executorKind,
    responsibleHuman,
    claimedAt: row.claimedAt,
    submittedAt: row.submittedAt,
    closedAt: row.closedAt,
    outputs,
    outputCount: outputs.length,
    hasMoreOutputs: false,
    hasAnyPassingReceipt,
    archival
  };
}

export async function loadExecutionEvidenceOutputs(executionId: string): Promise<ReadonlyArray<ExecutionOutputRow>> {
  const detail = await harnessClient.getExecutionDetail({ executionId });
  return adaptOutputRows(detail.execution.outputs ?? []);
}

function adaptOutputRows(values: ReadonlyArray<ProjectionJsonValue>): ReadonlyArray<ExecutionOutputRow> {
  return values
    .map(adaptOutputRow)
    .filter((output): output is ExecutionOutputRow => output !== null)
    .sort((a, b) => (a.hasPassingReceipt === b.hasPassingReceipt ? 0 : a.hasPassingReceipt ? 1 : -1));
}

function adaptOutputRow(value: ProjectionJsonValue): ExecutionOutputRow | null {
  const record = narrowObject(value);
  if (!record) return null;
  const evidenceId = typeof record.evidence_id === "string" ? record.evidence_id : "";
  const locator = narrowFieldObject(record, "locator");
  const substrate = typeof locator?.substrate === "string" ? locator.substrate : "inline";
  const text = substrate === "inline" && typeof locator?.text === "string"
    ? locator.text
    : summarizeLocator(locator);
  const hasReceiptRef = typeof record.checker_receipt_ref === "string" && record.checker_receipt_ref.length > 0;
  // Passing receipt 保守判定:substrate=checker_receipt 且 receipt.result=pass。
  // 真实账本当前几乎全是迁移归档无 receipt,这里只把确实有 receipt 的输出标 pass。
  const receiptResult = narrowFieldObject(locator, "receipt")?.result;
  const hasPassingReceipt = substrate === "checker_receipt" && receiptResult === "pass";
  return {
    evidenceId: evidenceId || "(no-evidence-id)",
    text,
    substrate,
    hasPassingReceipt,
    hasReceiptRef: hasReceiptRef || hasPassingReceipt
  };
}

function summarizeLocator(locator: ProjectionJsonObject | null): string {
  if (!locator) return "(empty locator)";
  const substrate = typeof locator.substrate === "string" ? locator.substrate : "unknown";
  const detail =
    substrate === "file" && typeof locator.path === "string" ? locator.path :
    substrate === "url" && typeof locator.url === "string" ? locator.url :
    substrate === "entity" && typeof locator.entity_ref === "string" ? locator.entity_ref :
    substrate === "object" && typeof locator.ref === "string" ? locator.ref :
    "";
  return detail ? `[${substrate}] ${detail}` : `[${substrate}]`;
}

function narrowFieldObject(parent: ProjectionJsonObject | null, field: string): ProjectionJsonObject | null {
  if (!parent) return null;
  return narrowObject(readField(parent, field));
}

function readField(parent: ProjectionJsonObject, field: string): ProjectionJsonValue {
  // ProjectionJsonObject is `{ readonly [key: string]: ProjectionJsonValue }`,
  // 但 TS 在 union 上对 typeof+Array.isArray 的窄化有限,这里显式 cast 保持透明。
  return (parent as unknown as Record<string, ProjectionJsonValue>)[field];
}

function narrowObject(value: ProjectionJsonValue): ProjectionJsonObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ProjectionJsonObject;
}

function evidencePagePayload(
  cursor?: ExecutionEvidenceCursor,
  repoId?: string | null
): ExecutionEvidencePagePayload & { readonly repoId?: string } {
  return {
    limit: executionEvidencePageSize,
    ...(cursor ? { cursor } : {}),
    ...(repoId ? { repoId } : {})
  };
}
