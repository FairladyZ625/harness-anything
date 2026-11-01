import type { RuntimeKind } from "@harness-anything/kernel";
import { childProcessErrorCode } from "../runtime-process-signals.ts";

/** The only terminal proof accepted for a detached runtime lease. */
export type ProviderGroupSweepVerdict = "running" | "proven_stopped" | "unknown_unreachable";

export interface ProcessGroupIdentity {
  readonly pid?: number;
  /** Reference implementation calls the group id `pgid`; both names identify -pid. */
  readonly pgid?: number;
  readonly startedAt?: string;
  readonly runtime?: RuntimeKind | string;
}

export interface ProcessGroupReconcilerDeps {
  readonly signalGroup?: (target: number, signal: NodeJS.Signals | 0) => void;
  readonly platform?: NodeJS.Platform;
  readonly site?: string;
  readonly supervised?: boolean;
  readonly readProcessRow?: (pid: number) => unknown | Promise<unknown>;
  readonly [key: string]: unknown;
}

const defaultSignalGroup = (target: number, signal: NodeJS.Signals | 0): void => {
  process.kill(-target, signal);
};

function groupPid(input: number | ProcessGroupIdentity): number {
  return typeof input === "number" ? input : (input.pid ?? input.pgid ?? Number.NaN);
}

function validGroupPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1;
}

function errorCode(error: unknown): string {
  return childProcessErrorCode(error);
}

/** Probe an OS process group. EPERM is deliberately not treated as stopped. */
export function probeProcessGroup(
  input: number | ProcessGroupIdentity,
  deps: ProcessGroupReconcilerDeps = {},
): ProviderGroupSweepVerdict {
  const pid = groupPid(input);
  if (!validGroupPid(pid) || (deps.platform ?? process.platform) === "win32") return "unknown_unreachable";
  try {
    (deps.signalGroup ?? defaultSignalGroup)(pid, 0);
    return "running";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "proven_stopped";
    // Permission and probe errors are evidence gaps, never evidence of a stopped group.
    return "unknown_unreachable";
  }
}

/**
 * Stop an orphaned group and prove the stop with a second kill(-pid, 0) probe.
 * A successful SIGKILL request is not itself proof: the group may still contain writers.
 */
export function sweepOrphanedProcessGroup(
  input: number | ProcessGroupIdentity,
  deps: ProcessGroupReconcilerDeps = {},
): ProviderGroupSweepVerdict {
  const pid = groupPid(input);
  if (!validGroupPid(pid) || (deps.platform ?? process.platform) === "win32") return "unknown_unreachable";
  const signalGroup = deps.signalGroup ?? defaultSignalGroup;
  const before = probeProcessGroup(pid, deps);
  if (before !== "running") return before;
  try {
    signalGroup(pid, "SIGKILL");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "proven_stopped";
    // A failed kill request leaves the lease unresolved; the caller must retry or inspect it.
    return "unknown_unreachable";
  }
  return probeProcessGroup(pid, deps);
}

/** Reconcile is the lease-facing name for one orphan group sweep. */
export function reconcileProcessGroup(
  input: number | ProcessGroupIdentity,
  deps: ProcessGroupReconcilerDeps = {},
): ProviderGroupSweepVerdict {
  return sweepOrphanedProcessGroup(input, deps);
}
