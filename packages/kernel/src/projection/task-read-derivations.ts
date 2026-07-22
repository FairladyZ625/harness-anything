import path from "node:path";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { readDirIfPresent, readTextFileIfPresent, statPathIfPresent } from "./toctou-safe-fs.ts";
import type { TaskLiveness, TaskProjectionRow } from "./types.ts";

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
  rootInput: HarnessLayoutInput,
  rows: ReadonlyArray<TaskProjectionRow>,
  options: {
    readonly universe?: ReadonlyArray<TaskProjectionRow>;
    readonly now?: Date;
  } = {}
): ReadonlyArray<TaskProjectionRow> {
  const universe = options.universe ?? rows;
  const treeRoots = taskTreeRoots(universe);
  const at = options.now ?? new Date();
  return rows.map((row) => ({
    ...row,
    createdAt: taskCreatedAtFromId(row.taskId),
    treeRoot: treeRoots.get(row.taskId) ?? row.taskId,
    liveness: taskLiveness(rootInput, row, at)
  }));
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

function taskLiveness(
  rootInput: HarnessLayoutInput,
  row: TaskProjectionRow,
  now: Date
): TaskLiveness | null {
  if (row.coordinationStatus === "terminal") return null;
  if (hasActiveLease(rootInput, row.taskId, now)) return "in_flight";
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const packagePath = path.join(rootDir, path.dirname(row.sourcePath));
  const progressPath = path.join(packagePath, "progress.md");
  const progressMtime = statPathIfPresent(progressPath)?.mtime.getTime();
  const recentCutoff = now.getTime() - TASK_LIVENESS_WINDOW_MS;
  if (progressMtime !== undefined && progressMtime >= recentCutoff) return "in_flight";

  // This is deliberately a weak activity signal: it means some file in the task
  // package was written recently, not that a person actively advanced the task.
  // Bulk materialization can therefore create false in_flight readings. We still
  // use it in v1 because authored progress entries currently provide no coverage.
  const packageMtime = latestFileMtime(packagePath);
  return packageMtime !== null && packageMtime >= recentCutoff ? "in_flight" : "stale";
}

function latestFileMtime(directoryPath: string): number | null {
  const entries = readDirIfPresent(directoryPath);
  if (entries === null) return null;
  let latest: number | null = null;
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nested = latestFileMtime(entryPath);
      if (nested !== null && (latest === null || nested > latest)) latest = nested;
    } else if (entry.isFile()) {
      const mtime = statPathIfPresent(entryPath)?.mtime.getTime();
      if (mtime !== undefined && (latest === null || mtime > latest)) latest = mtime;
    }
  }
  return latest;
}

function hasActiveLease(rootInput: HarnessLayoutInput, taskId: string, now: Date): boolean {
  const holderPath = path.join(resolveHarnessLayout(rootInput).localRoot, "task-holders", `${taskId}.json`);
  const body = readTextFileIfPresent(holderPath);
  if (body === null) return false;
  try {
    const holder = JSON.parse(body) as Record<string, unknown>;
    return (holder.schema === "task-holder/v1" || holder.schema === "task-holder/v2") &&
      holder.taskId === taskId && holder.releasedAt === null && typeof holder.leaseExpiresAt === "string" &&
      Date.parse(holder.leaseExpiresAt) > now.getTime();
  } catch {
    return false;
  }
}
