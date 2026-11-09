import type { RuntimeKind } from "@harness-anything/kernel";
import { childProcessErrorCode, terminateRuntimePid } from "../runtime-process-signals.ts";
import { appendRuntimeWorkerRecord, readDispatchStreamSummary } from "../dispatch-stream.ts";
import {
  establishWindowsProcessGroup,
  observeWindowsProcessGroup,
  type WindowsGroupObservation,
} from "./windows-process-group-port.ts";

/** The only terminal proof accepted for a detached runtime lease. */
export type ProviderGroupSweepVerdict = "running" | "proven_stopped" | "unknown_unreachable";

export interface ProcessGroupIdentity {
  readonly pid?: number;
  /** Reference implementation calls the group id `pgid`; both names identify -pid. */
  readonly pgid?: number;
  readonly startedAt?: string;
  readonly runtime?: RuntimeKind | string;
  /** Local dispatch witness, never a remote node's process table. */
  readonly dispatch?: { readonly rootDir: string; readonly dispatchId: string };
  readonly containmentId?: string;
  readonly recoveryUptimeMs?: number;
}

export interface ProcessGroupReconcilerDeps {
  readonly signalGroup?: (target: number, signal: NodeJS.Signals | 0) => void;
  readonly platform?: NodeJS.Platform;
  readonly site?: string;
  readonly supervised?: boolean;
  readonly readProcessRow?: (pid: number) => unknown | Promise<unknown>;
  readonly observeWindowsGroup?: (containmentId: string | undefined, terminate: boolean) => WindowsGroupObservation;
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

/** Establish containment before the host creates any provider process. */
export async function establishRuntimeProcessGroup(): Promise<string | undefined> {
  return process.platform === "win32" ? establishWindowsProcessGroup() : undefined;
}

export function processGroupRecoveryHint(): string {
  return process.platform === "win32"
    ? " Retry recovery once to record system uptime, choose Windows Restart, then retry recovery promptly. " +
        "A lower OS uptime proves that every process from the observed execution stopped; " +
        "if it is not lower, the lease stays fenced. Do not edit ledger or lock files."
    : "";
}

/** A stop request is not a stop proof. Windows must target the witnessed job, never a reused PID. */
export function requestProcessGroupStop(input: ProcessGroupIdentity, deps: ProcessGroupReconcilerDeps = {}): void {
  if ((deps.platform ?? process.platform) !== "win32") {
    terminateRuntimePid(groupPid(input));
    return;
  }
  if (reconcileProcessGroup(input, deps) === "unknown_unreachable")
    throw Object.assign(new Error(`Runtime process containment could not be reached.${processGroupRecoveryHint()}`), {
      code: "runtime_process_group_unproven",
    });
}

function windowsVerdict(
  input: number | ProcessGroupIdentity,
  deps: ProcessGroupReconcilerDeps,
  terminate: boolean,
): ProviderGroupSweepVerdict {
  const identity = typeof input === "number" ? { pid: input } : input,
    dispatch = identity.dispatch,
    records = dispatch ? readDispatchStreamSummary(dispatch.rootDir, dispatch.dispatchId)?.records : undefined,
    witness = records?.find((record) => record.kind === "process_containment" && record.pid === groupPid(input)),
    containmentId =
      identity.containmentId ?? (typeof witness?.containmentId === "string" ? witness.containmentId : undefined),
    recoveryUptimeMs =
      records?.reduce<number | undefined>(
        (uptime, record) =>
          record.kind === "process_stop_unproven" &&
          record.pid === groupPid(input) &&
          typeof record.uptimeMs === "number"
            ? Math.max(uptime ?? 0, record.uptimeMs)
            : uptime,
        identity.recoveryUptimeMs,
      ) ?? identity.recoveryUptimeMs;
  if (!containmentId && !records && recoveryUptimeMs === undefined) return "unknown_unreachable";
  let observation: WindowsGroupObservation;
  try {
    observation = (deps.observeWindowsGroup ?? observeWindowsProcessGroup)(containmentId, terminate);
  } catch {
    // Inaccessible jobs and failed accounting remain evidence gaps, just like POSIX EPERM.
    return "unknown_unreachable";
  }
  if (containmentId && observation.activeProcesses !== null)
    return observation.activeProcesses === 0 ? "proven_stopped" : "running";
  // GetTickCount64 is monotonic within one boot, including suspend, and independent of wall-clock
  // changes. A reset since an earlier failed recovery is a stop proof for legacy, uncontained runs.
  // A later boot with greater uptime remains unknown, deliberately losing availability, not safety.
  if (recoveryUptimeMs !== undefined && observation.uptimeMs < recoveryUptimeMs) return "proven_stopped";
  if (dispatch && records && recoveryUptimeMs === undefined)
    appendRuntimeWorkerRecord(dispatch.rootDir, dispatch.dispatchId, {
      kind: "process_stop_unproven",
      pid: groupPid(input),
      uptimeMs: observation.uptimeMs,
      occurredAt: new Date().toISOString(),
    });
  return "unknown_unreachable";
}

/** Probe an OS process group. EPERM is deliberately not treated as stopped. */
export function probeProcessGroup(
  input: number | ProcessGroupIdentity,
  deps: ProcessGroupReconcilerDeps = {},
): ProviderGroupSweepVerdict {
  const pid = groupPid(input);
  if (!validGroupPid(pid)) return "unknown_unreachable";
  if ((deps.platform ?? process.platform) === "win32") return windowsVerdict(input, deps, false);
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
  if (!validGroupPid(pid)) return "unknown_unreachable";
  if ((deps.platform ?? process.platform) === "win32") return windowsVerdict(input, deps, true);
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

export async function sweepUntilProvenStopped(
  input: number | ProcessGroupIdentity,
  deps: ProcessGroupReconcilerDeps = {},
): Promise<ProviderGroupSweepVerdict> {
  let stop = probeProcessGroup(input, deps);
  for (let attempt = 0; stop === "running" && attempt < 80; attempt++) {
    if (attempt === 40) {
      stop = sweepOrphanedProcessGroup(input, deps);
      continue;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    stop = probeProcessGroup(input, deps);
  }
  return stop;
}
