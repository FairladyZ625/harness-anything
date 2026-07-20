import {
  calculateDaemonArtifactIdentity,
  requestLocalDaemonJsonRpcForTarget,
  type JsonObject,
  type LocalDaemonTarget
} from "@harness-anything/daemon";
import { makeLocalVersionControlSystem, readDaemonRegistry } from "@harness-anything/kernel";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readOption } from "../../cli/parse-options.ts";
import { requestLocalDaemonJsonRpc, resolveLocalDaemonTarget } from "../../daemon/client.ts";
import type { DaemonLaunchConfiguration } from "../../daemon/daemon-launch-spec.ts";
import {
  stopDaemonReplacement,
  type DaemonReplacementStopRuntime
} from "./replacement-cleanup.ts";
import {
  daemonControlFailure,
  incompleteReplacementReason,
  isCompleteReplacement,
  normalizeDaemonLifecycleStatus,
  replacementIdentityIsInvalid,
  type DaemonLifecycleStatus
} from "./control-convergence.ts";

export type DaemonControlKind = "restart" | "refresh";
type DaemonRefreshTrigger = "explicit" | "post-merge" | "dist-watcher";

export interface DaemonControlRequest {
  readonly method: "admin.daemon.restart" | "admin.daemon.refresh";
  readonly params: JsonObject;
}

export interface DaemonControlLifecycle {
  readonly target: LocalDaemonTarget;
  readonly probeStatus: (target: LocalDaemonTarget) => Promise<Record<string, unknown> | undefined>;
  readonly ownerIsAlive: (pid: number) => boolean;
  readonly prepareReplacement?: (target: LocalDaemonTarget) => Promise<DaemonLaunchConfiguration>;
  readonly startReplacement: (
    target: LocalDaemonTarget,
    timeoutMs: number,
    launchConfiguration: DaemonLaunchConfiguration
  ) => Promise<Record<string, unknown>>;
  readonly stopReplacement?: (target: LocalDaemonTarget, pid: number, timeoutMs: number) => Promise<void>;
  readonly wait: (ms: number) => Promise<void>;
}

export interface DaemonControlCommandInput {
  readonly rootDir: string;
  readonly layoutOverrides?: { readonly authoredRoot?: string };
  readonly args: ReadonlyArray<string>;
  readonly requestDaemonControl?: (request: DaemonControlRequest) => Promise<Record<string, unknown>>;
  readonly daemonControlLifecycle?: DaemonControlLifecycle;
  readonly daemonEntryPath: () => string;
  readonly calculateInstalledIdentity?: (entrypoint: string) => string;
}

type DaemonControlHandoff =
  | { readonly kind: "adopt"; readonly status: Record<string, unknown> }
  | { readonly kind: "reject"; readonly status: DaemonLifecycleStatus }
  | { readonly kind: "autostart" };

class DaemonRefreshWrongCheckoutError extends Error {
  constructor() {
    super("Refresh is limited to the canonical main checkout. Finish the feature-worktree build without replacing the user daemon, or run refresh from the canonical main checkout.");
    this.name = "DaemonRefreshWrongCheckoutError";
  }
}

export async function runDaemonControl(
  input: DaemonControlCommandInput,
  kind: DaemonControlKind
): Promise<Record<string, unknown>> {
  if (kind === "refresh") assertCanonicalRefreshCheckout(input.rootDir);
  const drainTimeoutMs = daemonControlTimeoutMs(input.args);
  const trigger = kind === "refresh" ? daemonRefreshTrigger(input.args) : undefined;
  const params = {
    payload: {
      reason: readOption(input.args, "--reason") ?? `${trigger ?? "explicit"} daemon ${kind} request`,
      drainTimeoutMs,
      ...(trigger ? { trigger } : {})
    }
  };
  const method: DaemonControlRequest["method"] = kind === "restart"
    ? "admin.daemon.restart"
    : "admin.daemon.refresh";
  const lifecycle = input.daemonControlLifecycle ?? defaultDaemonControlLifecycle(input);
  const request = input.requestDaemonControl ?? ((control: DaemonControlRequest) => requestLocalDaemonJsonRpc(
    input.rootDir,
    control.method,
    control.params,
    5_000,
    {
      userRoot: lifecycle.target.userRoot,
      socketPath: readOption(input.args, "--socket"),
      allowLegacySocket: false
    }
  ));
  const preparedLaunchConfiguration = kind === "refresh"
    ? await lifecycle.prepareReplacement?.(lifecycle.target)
    : undefined;
  const preparedExpectedIdentity = preparedLaunchConfiguration
    ? calculateInstalledIdentity(input, preparedLaunchConfiguration.entrypoint)
    : undefined;
  const rpcReceipt = await request({ method, params });
  const receipt = controlPayloadFromRpcReceipt(rpcReceipt, method);
  validateAcceptedControlReceipt(receipt, method, kind);
  const before = isDaemonControlRecord(receipt.before) ? receipt.before : {};
  const launchConfiguration = preparedLaunchConfiguration
    ?? daemonReplacementLaunchConfiguration(before.launchConfiguration);
  const expectedIdentity = kind === "refresh"
    ? preparedExpectedIdentity ?? calculateInstalledIdentity(input, launchConfiguration.entrypoint)
    : undefined;
  const replacement = await completeDaemonReplacement(
    lifecycle,
    before.pid,
    before.loadedIdentity,
    receipt.operationId,
    drainTimeoutMs,
    kind,
    method,
    launchConfiguration,
    expectedIdentity
  );
  const { schema: controlSchema, ...controlResult } = receipt;
  return {
    ...controlResult,
    controlSchema,
    replacement: {
      ...replacement,
      userRoot: lifecycle.target.userRoot,
      endpoint: lifecycle.target.socketPath
    }
  };
}

function controlPayloadFromRpcReceipt(
  receipt: Record<string, unknown>,
  method: DaemonControlRequest["method"]
): Record<string, unknown> {
  if (receipt.ok === false) {
    const error = isDaemonControlRecord(receipt.error) ? receipt.error : {};
    const hint = typeof error.hint === "string" ? error.hint : `${method} was rejected by the daemon`;
    throw new Error(hint);
  }
  const details = isDaemonControlRecord(receipt.details) ? receipt.details : {};
  const data = isDaemonControlRecord(details.data) ? details.data : undefined;
  return data ?? receipt;
}

function assertCanonicalRefreshCheckout(rootDir: string): void {
  try {
    const topLevel = makeLocalVersionControlSystem().topLevel(rootDir);
    if (!topLevel) return;
    const gitPointer = readFileSync(path.join(topLevel, ".git"), "utf8").trim();
    const gitDir = /^gitdir:\s*(.+)$/iu.exec(gitPointer)?.[1];
    if (gitDir && path.resolve(topLevel, gitDir).split(path.sep).includes("worktrees")) {
      throw new DaemonRefreshWrongCheckoutError();
    }
  } catch (error) {
    if (error instanceof DaemonRefreshWrongCheckoutError) throw error;
    // Non-Git installs are valid daemon entrypoints and have no feature-worktree ambiguity.
  }
}

function validateAcceptedControlReceipt(
  receipt: Record<string, unknown>,
  method: DaemonControlRequest["method"],
  kind: DaemonControlKind
): void {
  if (receipt.schema !== "daemon-control-accepted/v1"
    || receipt.accepted !== true
    || receipt.kind !== kind
    || typeof receipt.operationId !== "string"
    || receipt.operationId.length === 0) {
    throw new Error(`${method} did not return daemon-control-accepted/v1`);
  }
}

async function completeDaemonReplacement(
  lifecycle: DaemonControlLifecycle,
  beforePid: unknown,
  beforeLoadedIdentity: unknown,
  operationId: unknown,
  timeoutMs: number,
  kind: DaemonControlKind,
  method: DaemonControlRequest["method"],
  launchConfiguration: DaemonLaunchConfiguration,
  expectedIdentity: string | undefined
): Promise<Record<string, unknown>> {
  if (!isPositivePid(beforePid)) {
    throw new Error(`${method} accepted receipt did not identify the running daemon PID`);
  }
  if (typeof beforeLoadedIdentity !== "string" || typeof operationId !== "string") {
    throw new Error(`${method} accepted receipt did not identify the loaded build and operation`);
  }
  const handoff = await waitForDaemonControlHandoff(lifecycle, beforePid, operationId, timeoutMs, expectedIdentity);
  if (handoff.kind === "adopt") return handoff.status;
  if (handoff.kind === "reject") {
    await rejectIncompleteReplacement(lifecycle, handoff.status, beforePid, operationId, timeoutMs, kind, expectedIdentity);
  }
  let replacement: Record<string, unknown>;
  try {
    replacement = await lifecycle.startReplacement(lifecycle.target, timeoutMs, launchConfiguration);
  } catch (error) {
    throw new Error(
      `DAEMON_${kind.toUpperCase()}_REPLACEMENT_FAILED_AFTER_HANDOFF: ${error instanceof Error ? error.message : String(error)}. `
      + `Restore the daemon with: ${daemonRecoveryCommand(launchConfiguration)}`
    );
  }
  const replacementLifecycle = normalizeDaemonLifecycleStatus(replacement);
  if (!replacementLifecycle) {
    throw new Error(`daemon ${kind} replacement did not return a reachable started daemon status`);
  }
  if (replacementLifecycle.pid === beforePid) {
    throw new Error(`daemon ${kind} replacement PID did not change: ${String(replacementLifecycle.pid)}; replacement was not signaled`);
  }
  return await waitForStartedReplacement(
    lifecycle,
    replacement,
    replacementLifecycle,
    beforePid,
    operationId,
    timeoutMs,
    kind,
    expectedIdentity
  );
}

async function waitForStartedReplacement(
  lifecycle: DaemonControlLifecycle,
  initialStatus: Record<string, unknown>,
  initialLifecycle: DaemonLifecycleStatus,
  beforePid: number,
  operationId: string,
  timeoutMs: number,
  kind: DaemonControlKind,
  expectedIdentity: string | undefined
): Promise<Record<string, unknown>> {
  let status = initialStatus;
  let replacement = initialLifecycle;
  const pollIntervalMs = 100;
  const attempts = Math.ceil(timeoutMs / pollIntervalMs) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (replacement.pid === beforePid) {
      throw new Error(`daemon ${kind} replacement PID did not change: ${String(replacement.pid)}; replacement was not signaled`);
    }
    if (replacementIdentityIsInvalid(replacement, expectedIdentity)) {
      await rejectIncompleteReplacement(lifecycle, replacement, beforePid, operationId, timeoutMs, kind, expectedIdentity);
    }
    if (isCompleteReplacement(replacement, beforePid, operationId, expectedIdentity)) return status;
    if (attempt + 1 < attempts) {
      await lifecycle.wait(pollIntervalMs);
      const observed = await lifecycle.probeStatus(lifecycle.target);
      const observedLifecycle = observed ? normalizeDaemonLifecycleStatus(observed) : undefined;
      if (observed && observedLifecycle) {
        status = observed;
        replacement = observedLifecycle;
      }
      continue;
    }
  }
  if (replacement.activeOperationId && replacement.activeOperationId !== operationId) {
    throw new Error(
      `daemon ${kind} replacement remained healthy but another daemon control operation remained active: `
      + `${replacement.activeOperationId}; replacement was left running`
    );
  }
  return await rejectIncompleteReplacement(lifecycle, replacement, beforePid, operationId, timeoutMs, kind, expectedIdentity);
}

async function rejectIncompleteReplacement(
  lifecycle: DaemonControlLifecycle,
  replacement: DaemonLifecycleStatus,
  beforePid: number,
  operationId: string,
  timeoutMs: number,
  kind: DaemonControlKind,
  expectedIdentity: string | undefined
): Promise<never> {
  const failure = incompleteReplacementReason(replacement, beforePid, operationId, expectedIdentity);
  if (replacement.pid === beforePid) {
    throw new Error(`daemon ${kind} replacement ${failure}; replacement was not signaled`);
  }
  if (!lifecycle.stopReplacement) {
    throw new Error(`daemon ${kind} replacement ${failure}; cleanup unavailable; replacement may still be serving`);
  }
  try {
    await lifecycle.stopReplacement(lifecycle.target, replacement.pid, timeoutMs);
  } catch (error) {
    throw new Error(
      `daemon ${kind} replacement ${failure}; cleanup failed and replacement may still be serving: `
      + `${error instanceof Error ? error.message : String(error)}`
    );
  }
  throw new Error(`daemon ${kind} replacement ${failure}; rejected replacement was stopped and endpoint remained unowned`);
}

function defaultDaemonControlLifecycle(input: DaemonControlCommandInput): DaemonControlLifecycle {
  const resolvedTarget = resolveLocalDaemonTarget({
    rootDir: input.rootDir,
    repoIdOverride: readOption(input.args, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID,
    userRoot: daemonUserRootOption(input.args),
    layoutOverrides: input.layoutOverrides,
    autoRegisterSingleRepo: false
  });
  const socketPath = readOption(input.args, "--socket");
  const target = socketPath ? { ...resolvedTarget, socketPath } : resolvedTarget;
  return {
    target,
    probeStatus: probeExactDaemonStatus,
    ownerIsAlive: daemonProcessIsAlive,
    prepareReplacement: async (candidate) => {
      let receipt: Record<string, unknown>;
      try {
        receipt = await requestLocalDaemonJsonRpcForTarget(candidate, "admin.daemon.launch-spec", {}, 1_000);
      } catch {
        throw daemonLaunchSpecUpgradeError(candidate);
      }
      return daemonReplacementLaunchConfiguration(statusFromReceipt(receipt));
    },
    startReplacement: (candidate, timeoutMs, launchConfiguration) => startDaemonReplacement(
      candidate,
      input.layoutOverrides,
      timeoutMs,
      launchConfiguration
    ),
    stopReplacement: (candidate, pid, timeoutMs) => stopDaemonReplacement(
      candidate,
      pid,
      timeoutMs,
      defaultDaemonReplacementStopRuntime()
    ),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}

function calculateInstalledIdentity(input: DaemonControlCommandInput, entrypoint: string): string {
  return input.calculateInstalledIdentity?.(entrypoint)
    ?? calculateDaemonArtifactIdentity(entrypoint).identity;
}

function daemonLaunchSpecUpgradeError(target: LocalDaemonTarget): Error {
  let pointers: ReadonlyArray<string> = [];
  try {
    pointers = [...new Set(readDaemonRegistry({ userRoot: target.userRoot }).repos.flatMap(
      (repo) => repo.authorityManifestPath ? [repo.authorityManifestPath] : []
    ))];
  } catch {
    // The upgrade guidance remains actionable with an explicit manifest placeholder.
  }
  const manifest = pointers.length === 1 ? quoteDaemonRecoveryArgument(pointers[0]!) : "<path>";
  return new Error(
    "DAEMON_REFRESH_LAUNCH_SPEC_UNAVAILABLE: the running daemon predates the launch-spec protocol, so its replacement startup configuration cannot be derived safely. "
    + `Leave this daemon running. To enable automatic refresh, manually restart it once using the same daemon user root: ha daemon stop --user-root ${quoteDaemonRecoveryArgument(target.userRoot)} && ha daemon start --service --authority-manifest ${manifest}`
  );
}

async function waitForDaemonControlHandoff(
  lifecycle: DaemonControlLifecycle,
  beforePid: number,
  operationId: string,
  timeoutMs: number,
  expectedIdentity: string | undefined
): Promise<DaemonControlHandoff> {
  const pollIntervalMs = 100;
  const attempts = Math.ceil(timeoutMs / pollIntervalMs) + 1;
  let pendingReplacement: DaemonLifecycleStatus | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await lifecycle.probeStatus(lifecycle.target);
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
      if (observedLifecycle && isCompleteReplacement(observedLifecycle, beforePid, operationId, expectedIdentity)) {
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
          const finalStatus = await lifecycle.probeStatus(lifecycle.target);
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

async function probeExactDaemonStatus(target: LocalDaemonTarget): Promise<Record<string, unknown> | undefined> {
  try {
    const receipt = await requestLocalDaemonJsonRpc(target.canonicalRoot, "repo.daemon.status", {
      repo: { repoId: target.repoId }
    }, 100, {
      userRoot: target.userRoot,
      daemonId: target.daemonId,
      socketPath: target.socketPath,
      allowLegacySocket: false
    });
    return statusFromReceipt(receipt) ?? { rpcError: receipt };
  } catch {
    return undefined;
  }
}

async function startDaemonReplacement(
  target: LocalDaemonTarget,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  timeoutMs: number,
  launchConfiguration: DaemonLaunchConfiguration
): Promise<Record<string, unknown>> {
  const receipt = await requestLocalDaemonJsonRpcForTarget(target, "repo.daemon.status", {
    repo: { repoId: target.repoId }
  }, 1_000, {
    entryPath: launchConfiguration.entrypoint,
    idleExitMs: 0,
    timeoutMs,
    layoutOverrides,
    launchConfiguration
  });
  const status = statusFromReceipt(receipt);
  if (!status) throw new Error("replacement status RPC did not return daemon status data");
  return status;
}

function defaultDaemonReplacementStopRuntime(): DaemonReplacementStopRuntime {
  return {
    probeStatus: probeExactDaemonStatus,
    statusPid: (status) => normalizeDaemonLifecycleStatus(status)?.pid,
    processIsAlive: daemonProcessIsAlive,
    signal: (pid, signal) => process.kill(pid, signal),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    endpointStabilityMs: 10_500
  };
}

function daemonReplacementLaunchConfiguration(value: unknown): DaemonLaunchConfiguration {
  if (!isDaemonControlRecord(value)
    || typeof value.execPath !== "string"
    || typeof value.entrypoint !== "string"
    || !Array.isArray(value.execArgv)
    || !value.execArgv.every((arg) => typeof arg === "string")
    || !Array.isArray(value.args)
    || !value.args.every((arg) => typeof arg === "string")) {
    throw new Error("daemon control accepted receipt did not include the running daemon launch configuration");
  }
  return {
    execPath: value.execPath,
    execArgv: value.execArgv,
    entrypoint: value.entrypoint,
    args: value.args
  };
}

function daemonRecoveryCommand(configuration: DaemonLaunchConfiguration): string {
  return [configuration.execPath, ...configuration.execArgv, configuration.entrypoint, ...configuration.args]
    .map(quoteDaemonRecoveryArgument)
    .join(" ");
}

function quoteDaemonRecoveryArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function statusFromReceipt(receipt: Record<string, unknown>): Record<string, unknown> | undefined {
  const details = isDaemonControlRecord(receipt.details) ? receipt.details : {};
  const data = isDaemonControlRecord(details.data) ? details.data : undefined;
  return receipt.ok === true && data ? data : undefined;
}

function daemonControlTimeoutMs(args: ReadonlyArray<string>): number {
  const raw = readOption(args, "--timeout-ms") ?? "5000";
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error("Use --timeout-ms with an integer from 100 through 120000.");
  }
  return timeoutMs;
}

function daemonRefreshTrigger(args: ReadonlyArray<string>): DaemonRefreshTrigger {
  const trigger = readOption(args, "--trigger") ?? "explicit";
  if (trigger === "explicit" || trigger === "post-merge" || trigger === "dist-watcher") return trigger;
  throw new Error("Use --trigger explicit|post-merge|dist-watcher.");
}

function daemonUserRootOption(args: ReadonlyArray<string>): string | undefined {
  return readOption(args, "--user-root") ?? process.env.HARNESS_DAEMON_USER_ROOT;
}

function daemonProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isDaemonControlRecord(error) && error.code === "ESRCH");
  }
}

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isDaemonControlRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
