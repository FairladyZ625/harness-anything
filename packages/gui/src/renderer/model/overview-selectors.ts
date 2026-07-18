import type {
  DecisionRow,
  FactRef,
  RelationEdge,
  SnapshotStatus,
  TaskRow,
} from "./types.ts";
import { BOARD_COLUMNS } from "./types.ts";
import { sortDecisionQueue } from "./triadic.ts";

/** Fixed upper bound for Overview root/module drill-down rows rendered on first screen. */
export const OVERVIEW_DIMENSION_PAGE_SIZE = 40;

export type DrillDimension = "root" | "module";

export interface OverviewStatusCounts {
  readonly active: number;
  readonly blocked: number;
  readonly in_review: number;
  readonly planned: number;
  readonly done: number;
  readonly cancelled: number;
  readonly unknown: number;
}

export interface OverviewDimensionRow {
  readonly key: string;
  readonly label: string;
  readonly counts: Readonly<Record<SnapshotStatus, number>>;
}

export interface OverviewIndex {
  readonly statusCounts: OverviewStatusCounts;
  readonly blocked: ReadonlyArray<TaskRow>;
  readonly inReview: ReadonlyArray<TaskRow>;
  readonly staleCount: number;
  readonly unavailableCount: number;
  readonly invalidatedFactCount: number;
  readonly danglingRelationCount: number;
  readonly proposedTop: ReadonlyArray<DecisionRow>;
  readonly blockers: ReadonlyArray<TaskRow>;
  readonly dimensionRows: ReadonlyArray<OverviewDimensionRow>;
}

const EMPTY_STATUS_COUNTS: OverviewStatusCounts = {
  active: 0,
  blocked: 0,
  in_review: 0,
  planned: 0,
  done: 0,
  cancelled: 0,
  unknown: 0,
};

/**
 * Build Overview derived state in a single O(N) pass.
 * Replaces repeated filter/find scans that scale as O(rows × roots).
 */
export function buildOverviewIndex(input: {
  readonly tasks: ReadonlyArray<TaskRow>;
  readonly decisions: ReadonlyArray<DecisionRow>;
  readonly facts: ReadonlyArray<FactRef>;
  readonly relations: ReadonlyArray<RelationEdge>;
  readonly dimension: DrillDimension;
  readonly proposedLimit?: number;
  readonly blockerLimit?: number;
}): OverviewIndex {
  const proposedLimit = input.proposedLimit ?? 5;
  const blockerLimit = input.blockerLimit ?? 8;
  const statusCounts: Record<keyof OverviewStatusCounts, number> = { ...EMPTY_STATUS_COUNTS };
  const blocked: TaskRow[] = [];
  const inReview: TaskRow[] = [];
  const readyInReview: TaskRow[] = [];
  let staleCount = 0;
  let unavailableCount = 0;
  const taskIds = new Set<string>();
  const labelByKey = new Map<string, string>();
  const countsByKey = new Map<string, Record<SnapshotStatus, number>>();

  for (const task of input.tasks) {
    taskIds.add(task.taskId);
    const status = normalizeStatus(task.coordinationStatus);
    statusCounts[status] += 1;
    if (status === "blocked") blocked.push(task);
    if (status === "in_review") {
      inReview.push(task);
      if (task.closeoutReadiness === "ready") readyInReview.push(task);
    }
    if (task.freshness === "stale-but-usable") staleCount += 1;
    if (task.freshness === "unavailable-no-cache") unavailableCount += 1;

    const key = dimensionKey(task, input.dimension);
    if (!labelByKey.has(key)) {
      labelByKey.set(key, dimensionLabel(task, input.dimension, key));
    }
    let counts = countsByKey.get(key);
    if (!counts) {
      counts = emptyStatusRecord();
      countsByKey.set(key, counts);
    }
    counts[status] += 1;
  }

  const decisionIds = new Set(input.decisions.map((decision) => decision.decisionId));
  const factAnchors = new Set(input.facts.map((fact) => fact.anchor));
  let invalidatedFactCount = 0;
  for (const fact of input.facts) {
    if (fact.invalidated) invalidatedFactCount += 1;
  }

  let danglingRelationCount = 0;
  for (const relation of input.relations) {
    if (!endpointKnown(relation.from, taskIds, decisionIds, factAnchors)
      || !endpointKnown(relation.to, taskIds, decisionIds, factAnchors)) {
      danglingRelationCount += 1;
    }
  }

  const proposed = input.decisions.filter((decision) => decision.state === "proposed");
  const proposedTop = sortDecisionQueue(proposed).slice(0, proposedLimit);
  const blockers = [...blocked, ...readyInReview]
    .sort((a, b) => a.lastKnownAt.localeCompare(b.lastKnownAt))
    .slice(0, blockerLimit);

  const dimensionRows: OverviewDimensionRow[] = [];
  for (const [key, counts] of countsByKey) {
    dimensionRows.push({
      key,
      label: labelByKey.get(key) ?? key,
      counts,
    });
  }
  dimensionRows.sort((a, b) => a.label.localeCompare(b.label));

  return {
    statusCounts,
    blocked,
    inReview,
    staleCount,
    unavailableCount,
    invalidatedFactCount,
    danglingRelationCount,
    proposedTop,
    blockers,
    dimensionRows,
  };
}

/** Window dimension rows without silent truncation — caller must expose paging controls. */
export function windowDimensionRows(
  rows: ReadonlyArray<OverviewDimensionRow>,
  page: number,
  pageSize: number = OVERVIEW_DIMENSION_PAGE_SIZE,
): {
  readonly visible: ReadonlyArray<OverviewDimensionRow>;
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
} {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const start = safePage * pageSize;
  return {
    visible: rows.slice(start, start + pageSize),
    page: safePage,
    pageCount,
    total,
  };
}

export function countStatus(index: OverviewIndex, status: SnapshotStatus): number {
  const normalized = normalizeStatus(status);
  return index.statusCounts[normalized];
}

export function dimensionKey(task: TaskRow, dimension: DrillDimension): string {
  if (dimension === "root") return task.rootTaskId ?? task.taskId;
  return task.module;
}

function dimensionLabel(task: TaskRow, dimension: DrillDimension, key: string): string {
  if (dimension === "root") return task.rootTitle ?? task.title ?? key;
  return key;
}

function endpointKnown(
  endpoint: string,
  taskIds: ReadonlySet<string>,
  decisionIds: ReadonlySet<string>,
  factAnchors: ReadonlySet<string>,
): boolean {
  if (endpoint.startsWith("task/")) return taskIds.has(endpoint.slice(5).split("/")[0] ?? "");
  if (endpoint.startsWith("decision/")) return decisionIds.has(endpoint.split("/")[1] ?? "");
  if (endpoint.startsWith("fact/")) return factAnchors.has(endpoint.replace(/^fact\//, ""));
  return taskIds.has(endpoint);
}

function normalizeStatus(status: SnapshotStatus): keyof OverviewStatusCounts {
  if (status in EMPTY_STATUS_COUNTS) return status as keyof OverviewStatusCounts;
  return "unknown";
}

function emptyStatusRecord(): Record<SnapshotStatus, number> {
  const record = {} as Record<SnapshotStatus, number>;
  for (const status of BOARD_COLUMNS) record[status] = 0;
  record.unknown = 0;
  return record;
}
