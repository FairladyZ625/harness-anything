import path from "node:path";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { readDirIfPresent, readTextFileIfPresent } from "./toctou-safe-fs.ts";
import type { ProjectionSourceCacheSnapshot } from "./sqlite-projection-source-cache.ts";
import type { TaskProjectionRow } from "./types.ts";

// v1 deliberately uses one fixed window. Configuring it would cross the production
// wire-parity baseline; only pay that governance cost after this view proves useful.
const TASK_LIVENESS_WINDOW_MS = 72 * 60 * 60 * 1_000;

const crockford = new Map([..."0123456789ABCDEFGHJKMNPQRSTVWXYZ"].map((character, index) => [character, index]));

export function taskCreatedAtFromId(taskId: string): string | null {
  const match = /^task_([0-9A-HJKMNP-TV-Z]{10})[0-9A-HJKMNP-TV-Z]{16}$/iu.exec(taskId);
  if (!match) return null;
  let timestamp = 0;
  for (const character of match[1]!.toUpperCase()) {
    const value = crockford.get(character);
    if (value === undefined) return null;
    timestamp = timestamp * 32 + value;
  }
  if (!Number.isSafeInteger(timestamp) || timestamp > 0xffff_ffff_ffff) return null;
  return new Date(timestamp).toISOString();
}

export function deriveTaskProjectionRows(
  rows: ReadonlyArray<TaskProjectionRow>,
  options: {
    readonly universe?: ReadonlyArray<TaskProjectionRow>;
    readonly inFlightTaskIds?: ReadonlySet<string>;
  } = {}
): ReadonlyArray<TaskProjectionRow> {
  const universe = options.universe ?? rows;
  const treeRoots = taskTreeRoots(universe);
  const inFlightTaskIds = options.inFlightTaskIds ?? new Set(universe
    .filter((row) => row.liveness === "in_flight")
    .map((row) => row.taskId));
  return rows.map((row) => ({
    ...row,
    createdAt: taskCreatedAtFromId(row.taskId),
    treeRoot: treeRoots.get(row.taskId) ?? row.taskId,
    liveness: row.coordinationStatus === "terminal"
      ? null
      : inFlightTaskIds.has(row.taskId) ? "in_flight" : "stale"
  }));
}

export function deriveTaskProjectionRowsFromSourceCache(
  rootInput: HarnessLayoutInput,
  rows: ReadonlyArray<TaskProjectionRow>,
  sourceCache: ProjectionSourceCacheSnapshot,
  options: {
    readonly now?: Date;
    readonly includeActiveLeases?: boolean;
  } = {}
): ReadonlyArray<TaskProjectionRow> {
  const now = options.now ?? new Date();
  const inFlightTaskIds = recentTaskSourceIds(rows, sourceCache, now);
  if (options.includeActiveLeases) {
    for (const taskId of activeLeaseTaskIds(rootInput, rows, now)) inFlightTaskIds.add(taskId);
  }
  return deriveTaskProjectionRows(rows, { inFlightTaskIds });
}

export function deriveTaskProjectionRowsWithActiveLeases(
  rootInput: HarnessLayoutInput,
  rows: ReadonlyArray<TaskProjectionRow>,
  now = new Date()
): ReadonlyArray<TaskProjectionRow> {
  const inFlightTaskIds = new Set(rows
    .filter((row) => row.liveness === "in_flight")
    .map((row) => row.taskId));
  for (const taskId of activeLeaseTaskIds(rootInput, rows, now)) inFlightTaskIds.add(taskId);
  return deriveTaskProjectionRows(rows, { inFlightTaskIds });
}

export function taskTreeRoots(rows: ReadonlyArray<Pick<TaskProjectionRow, "taskId" | "parentTaskId">>): ReadonlyMap<string, string> {
  const parents = new Map(rows.map((row) => [row.taskId, row.parentTaskId]));
  const roots = new Map<string, string>();
  for (const taskId of parents.keys()) roots.set(taskId, traceRoot(taskId, parents));
  return roots;
}

function traceRoot(taskId: string, parents: ReadonlyMap<string, string | undefined>): string {
  const pathIds: string[] = [];
  const positions = new Map<string, number>();
  let current = taskId;
  while (true) {
    const cycleStart = positions.get(current);
    if (cycleStart !== undefined) return [...pathIds.slice(cycleStart), current].sort()[0]!;
    positions.set(current, pathIds.length);
    pathIds.push(current);
    const parent = parents.get(current);
    if (!parent || !parents.has(parent)) return current;
    current = parent;
  }
}

function recentTaskSourceIds(
  rows: ReadonlyArray<TaskProjectionRow>,
  sourceCache: ProjectionSourceCacheSnapshot,
  now: Date
): Set<string> {
  const records = sourceCache.files.filter((record) => record.cacheKind === "task");
  const taskIdByPackagePath = new Map(rows.map((row) => [
    path.posix.dirname(row.sourcePath.split(path.sep).join("/")),
    row.taskId
  ]));
  const recentCutoffNs = BigInt(now.getTime() - TASK_LIVENESS_WINDOW_MS) * 1_000_000n;
  const recent = new Set<string>();
  for (const record of records) {
    const modifiedAtNs = statSignatureMtimeNs(record.statSignature);
    if (modifiedAtNs === null || modifiedAtNs < recentCutoffNs) continue;
    const taskId = owningTaskId(record.sourcePath, taskIdByPackagePath);
    if (taskId) recent.add(taskId);
  }
  return recent;
}

function statSignatureMtimeNs(signature: string): bigint | null {
  const value = signature.split(":")[4];
  if (!value || !/^\d+$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function owningTaskId(sourcePath: string, taskIdByPackagePath: ReadonlyMap<string, string>): string | undefined {
  let current = path.posix.dirname(sourcePath);
  while (current !== ".") {
    const taskId = taskIdByPackagePath.get(current);
    if (taskId) return taskId;
    const parent = path.posix.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function activeLeaseTaskIds(
  rootInput: HarnessLayoutInput,
  rows: ReadonlyArray<TaskProjectionRow>,
  now: Date
): ReadonlySet<string> {
  const relevantTaskIds = new Set(rows
    .filter((row) => row.coordinationStatus !== "terminal")
    .map((row) => row.taskId));
  const holderRoot = path.join(resolveHarnessLayout(rootInput).localRoot, "task-holders");
  const entries = readDirIfPresent(holderRoot) ?? [];
  const active = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const taskId = entry.name.slice(0, -".json".length);
    if (!relevantTaskIds.has(taskId)) continue;
    const body = readTextFileIfPresent(path.join(holderRoot, entry.name));
    if (body === null) continue;
    try {
      const holder = JSON.parse(body) as Record<string, unknown>;
      if ((holder.schema === "task-holder/v1" || holder.schema === "task-holder/v2") &&
          holder.taskId === taskId && holder.releasedAt === null && typeof holder.leaseExpiresAt === "string" &&
          Date.parse(holder.leaseExpiresAt) > now.getTime()) active.add(taskId);
    } catch {
      // Invalid runtime-state files do not make authored task state unreadable.
    }
  }
  return active;
}
