import type { LocalDaemonTarget } from "@harness-anything/daemon";
import {
  daemonControlFailure,
  isCompleteReplacement,
  normalizeDaemonLifecycleStatus,
  replacementIdentityIsInvalid,
  type DaemonGenerationConvergenceExpectation,
  type DaemonLifecycleStatus
} from "./control-convergence.ts";

export type DaemonControlHandoff =
  | { readonly kind: "adopt"; readonly status: Record<string, unknown> }
  | { readonly kind: "reject"; readonly status: DaemonLifecycleStatus }
  | { readonly kind: "autostart" };

interface DaemonControlHandoffLifecycle {
  readonly target: LocalDaemonTarget;
  readonly probeStatus: (
    target: LocalDaemonTarget,
    capability?: { readonly includeGenerationAxes: true }
  ) => Promise<Record<string, unknown> | undefined>;
  readonly ownerIsAlive: (pid: number) => boolean;
  readonly wait: (ms: number) => Promise<void>;
}

export async function waitForDaemonControlHandoff(
  lifecycle: DaemonControlHandoffLifecycle,
  beforePid: number,
  operationId: string,
  timeoutMs: number,
  expectedIdentity: string | undefined,
  expectedGeneration: DaemonGenerationConvergenceExpectation | undefined
): Promise<DaemonControlHandoff> {
  const pollIntervalMs = 100;
  const attempts = Math.ceil(timeoutMs / pollIntervalMs) + 1;
  let pendingReplacement: DaemonLifecycleStatus | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await lifecycle.probeStatus(
      lifecycle.target,
      expectedGeneration ? { includeGenerationAxes: true } : undefined
    );
    const ownerAlive = lifecycle.ownerIsAlive(beforePid);
    const controlFailure = daemonControlFailure(status, operationId);
    if (controlFailure) throw new Error(controlFailure);

    // One service process owns each OS-user + userRoot pair. While the old
    // owner lives, neither a reachable endpoint nor autostart can prove a safe handoff.
    if (!ownerAlive) {
      // Once the owner is dead, an absent exact endpoint is the only state
      // that permits the existing autostart primitive to run.
      if (!status) return { kind: "autostart" };
      const observedLifecycle = normalizeDaemonLifecycleStatus(status);
      if (observedLifecycle && isCompleteReplacement(observedLifecycle, beforePid, operationId, expectedIdentity, expectedGeneration)) {
        return { kind: "adopt", status };
      }
      if (observedLifecycle && observedLifecycle.pid !== beforePid && replacementIdentityIsInvalid(observedLifecycle, expectedIdentity)) {
        return { kind: "reject", status: observedLifecycle };
      }
      if (observedLifecycle?.pid !== beforePid) pendingReplacement = observedLifecycle;
      // Reachable old-PID or malformed status is not replacement proof and
      // blocks autostart, avoiding an overlapping service-owner window.
    }

    if (attempt + 1 === attempts) {
      if (pendingReplacement) {
        if (pendingReplacement.activeOperationId && pendingReplacement.activeOperationId !== operationId) {
          throw new Error(
            `another daemon control operation remained active: ${pendingReplacement.activeOperationId}; `
            + "replacement was left running"
          );
        }
        return { kind: "reject", status: pendingReplacement };
      }
      if (status) {
        for (let finalAttempt = 0; finalAttempt < 5; finalAttempt += 1) {
          await lifecycle.wait(pollIntervalMs);
          const finalStatus = await lifecycle.probeStatus(
            lifecycle.target,
            expectedGeneration ? { includeGenerationAxes: true } : undefined
          );
          const finalControlFailure = daemonControlFailure(finalStatus, operationId);
          if (finalControlFailure) throw new Error(finalControlFailure);
        }
        throw new Error(`old daemon endpoint was not released before timeout (pid ${beforePid})`);
      }
      throw new Error(`old daemon owner did not exit after releasing its endpoint (pid ${beforePid})`);
    }
    await lifecycle.wait(pollIntervalMs);
  }
  throw new Error(`daemon control handoff exhausted without a safe decision (pid ${beforePid})`);
}
