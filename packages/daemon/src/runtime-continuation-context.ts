import type { TaskProjection } from "@harness-anything/kernel";
import { runProcessExitAsync } from "./process-port.ts";

/** The bounded context a later dispatch needs from a stopped provider session. */
export interface RuntimeContinuationContext {
  readonly previousDispatchId: string | null;
  readonly lastConclusion: string | null;
  readonly exitHead: string | null;
  readonly currentHead: string | null;
  readonly headStatus: "unchanged" | "changed" | "unavailable" | "no-previous-run";
}

export interface RuntimeContinuationSeed {
  readonly dispatchId: string;
  readonly lastConclusion: string | null;
  readonly exitHead: string | null;
}

const conclusionLimit = 8_192;

export function continuationContext(
  seed: RuntimeContinuationSeed | null,
  currentHead: string | null,
): RuntimeContinuationContext {
  if (seed === null)
    return {
      previousDispatchId: null,
      lastConclusion: null,
      exitHead: null,
      currentHead,
      headStatus: "no-previous-run",
    };
  const headStatus =
    seed.exitHead === null || currentHead === null
      ? "unavailable"
      : seed.exitHead === currentHead
        ? "unchanged"
        : "changed";
  return {
    previousDispatchId: seed.dispatchId,
    lastConclusion: seed.lastConclusion,
    exitHead: seed.exitHead,
    currentHead,
    headStatus,
  };
}

/** Read the latest archived conclusion for an execution without loading its terminal result. */
export function latestRuntimeContinuationSeed(
  projection: TaskProjection,
  taskId: string,
  executionIds: readonly string[],
): RuntimeContinuationSeed | null {
  const read = projection.read(taskId),
    packagePath = read.packagePath;
  if (packagePath === null) return null;
  const rows = [...new Set(executionIds)]
    .flatMap((executionId) => projection.readRuntimeDispatchesByTaskExecution(taskId, executionId))
    .sort((left, right) => left.event.occurredAt.localeCompare(right.event.occurredAt));
  for (const row of [...rows].reverse()) {
    const document = projection.readDocument(
      `${packagePath}/artifacts/dispatches/${row.event.payload.dispatchId}.json`,
    ).document;
    if (document === null) continue;
    const value: unknown = JSON.parse(document.body);
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const archive = value as {
      readonly schema?: unknown;
      readonly lastConclusion?: unknown;
      readonly exitHead?: unknown;
    };
    if (archive.schema !== "runtime-dispatch/v1") continue;
    return {
      dispatchId: row.event.payload.dispatchId,
      lastConclusion: typeof archive.lastConclusion === "string" ? archive.lastConclusion : null,
      exitHead: typeof archive.exitHead === "string" ? archive.exitHead : null,
    };
  }
  return null;
}

/** A task worktree can be absent on an edge or for a task package; that is a measured unavailable value. */
export async function currentWorktreeHead(cwd: string): Promise<string | null> {
  const result = await runProcessExitAsync(
    "git",
    ["-C", cwd, "rev-parse", "HEAD"],
    undefined,
    undefined,
    undefined,
    undefined,
    { timeoutMs: 5_000 },
  );
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

export function boundedRuntimeConclusion(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.slice(0, conclusionLimit) : null;
}

export function continuationContextPrompt(context: RuntimeContinuationContext): string | null {
  if (context.previousDispatchId === null) return null;
  return [
    "# Previous runtime continuation context",
    `Previous dispatch: ${context.previousDispatchId}`,
    `Last conclusion: ${context.lastConclusion ?? "(none recorded)"}`,
    `Exit worktree HEAD: ${context.exitHead ?? "(unavailable)"}`,
    `Current worktree HEAD: ${context.currentHead ?? "(unavailable)"}`,
    `HEAD comparison: ${context.headStatus}`,
  ].join("\n");
}
