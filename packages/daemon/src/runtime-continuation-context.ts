import type { TaskProjection } from "@harness-anything/kernel";
import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { runProcessExitAsync } from "./process-port.ts";

/** The bounded context a later dispatch needs from a stopped provider session. */
export interface RuntimeContinuationContext {
  readonly previousDispatchId: string | null;
  readonly lastConclusion: string | null;
  readonly exitHead: string | null;
  readonly currentHead: string | null;
  readonly headStatus: OperationalStatus.IncidentHeadStatus;
}

export interface RuntimeContinuationSeed {
  readonly dispatchId: string;
  readonly lastConclusion: string | null;
  readonly exitHead: string | null;
}

const conclusionLimit = daemonRuntimePolicy.defaultValue.runtime.continuationConclusionLimit;

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

/** Read the latest archived conclusion for an execution without loading its terminal result.
 * `excludeDispatchId` answers the settlement-time question instead of the launch-time one: the
 * dispatch being settled already archived its own exit HEAD, so including it would compare the
 * current worktree with itself and report `unchanged` for every stop. Excluding it yields the
 * seed a *later* dispatch would inherit: the previous dispatch's exit HEAD. */
export function latestRuntimeContinuationSeed(
  projection: TaskProjection,
  taskId: string,
  executionIds: readonly string[],
  excludeDispatchId: string | null = null,
): RuntimeContinuationSeed | null {
  // Raw read: the seed only needs the package path; it never consumes presentation status.
  const read = projection.read(taskId, false, false),
    packagePath = read.packagePath;
  if (packagePath === null) return null;
  const rows = [...new Set(executionIds)]
    .flatMap((executionId) => projection.readRuntimeDispatchesByTaskExecution(taskId, executionId))
    .filter(({ event }) => event.payload.dispatchId !== excludeDispatchId)
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
      readonly classification?: unknown;
      readonly reason?: unknown;
    };
    if (archive.schema !== "runtime-dispatch/v1") continue;
    return {
      dispatchId: row.event.payload.dispatchId,
      lastConclusion:
        typeof archive.classification === "string"
          ? `${archive.classification}: ${typeof archive.reason === "string" ? compactProgressText(archive.reason, 768) : "none recorded"}`
          : typeof archive.lastConclusion === "string"
            ? compactProgressText(archive.lastConclusion, 768)
            : null,
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
    { timeoutMs: daemonRuntimePolicy.defaultValue.runtime.currentWorktreeHeadTimeoutMs },
  );
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

export function boundedRuntimeConclusion(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.slice(0, conclusionLimit) : null;
}

export interface RuntimeWorkspaceProgress {
  readonly head: string | null;
  readonly changedFiles: number | null;
  readonly unavailable: string | null;
}

/** D1: call only before the writer turn. No diff, filenames or raw runtime logs enter the prompt. */
export async function collectRuntimeWorkspaceProgress(cwd: string): Promise<RuntimeWorkspaceProgress> {
  const read = (args: readonly string[]) =>
    runProcessExitAsync("git", ["-C", cwd, ...args], undefined, undefined, undefined, undefined, {
      timeoutMs: daemonRuntimePolicy.defaultValue.runtime.currentWorktreeHeadTimeoutMs,
      timeoutSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
  const probes = await Promise.allSettled([
    read(["log", "-1", "--format=%h %s"]),
    read(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
  ]);
  for (const probe of probes) {
    if (probe.status === "fulfilled") continue;
    const error: unknown = probe.reason,
      code = typeof error === "object" && error !== null && "code" in error ? error.code : null,
      killed = typeof error === "object" && error !== null && "killed" in error && error.killed === true;
    // A terminated/output-limited probe has no Git verdict. Report it as unavailable;
    // programming errors keep their own failure instead of becoming a fabricated clean tree.
    if (!killed && !["ENOENT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(String(code))) throw error;
  }
  const head = probes[0]!.status === "fulfilled" ? probes[0]!.value : null,
    status = probes[1]!.status === "fulfilled" ? probes[1]!.value : null;
  return {
    head: head?.exitCode === 0 ? compactProgressText(head.stdout, 512) : null,
    changedFiles: status?.exitCode === 0 ? status.stdout.split("\0").length - 1 : null,
    unavailable:
      head?.exitCode === 0 && status?.exitCode === 0 ? null : "git probe unavailable (exit, timeout or output bound)",
  };
}

function compactProgressText(value: string, bytes: number): string {
  const text = String(scrubProviderValue(value)).replace(/\s+/gu, " ").trim();
  let result = "";
  for (const point of text) {
    if (Buffer.byteLength(result + point, "utf8") > bytes) break;
    result += point;
  }
  return result;
}

/** Every field has an explicit byte budget; the complete block is capped including its delimiters. */
export function runtimeProgressSnapshot(input: {
  readonly workspace?: RuntimeWorkspaceProgress;
  readonly node: string;
  readonly classification: string | null;
  readonly reason: string | null;
}): string {
  const workspace = input.workspace;
  return [
    "<runtime-progress>",
    `HEAD: ${compactProgressText(workspace?.head ?? "unavailable", 512)}`,
    `Changed files: ${workspace?.changedFiles ?? "unavailable"}`,
    `Task lifecycle node: ${compactProgressText(input.node, 128)}`,
    `Last attempt: ${compactProgressText(input.classification ?? "none recorded", 128)}`,
    `Reason: ${compactProgressText(input.reason ?? "none recorded", 768)}`,
    ...(workspace?.unavailable ? [`Workspace probe: ${compactProgressText(workspace.unavailable, 128)}`] : []),
    "</runtime-progress>",
  ].join("\n");
}
