import {
  requestLocalDaemonJsonRpcForTarget,
  type JsonObject,
  type LocalDaemonTarget
} from "../../../../daemon/src/index.ts";
import { readOption } from "../../cli/parse-options.ts";
import { requestLocalDaemonJsonRpc, resolveLocalDaemonTarget } from "../../daemon/client.ts";

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
  readonly startReplacement: (target: LocalDaemonTarget, timeoutMs: number) => Promise<Record<string, unknown>>;
  readonly wait: (ms: number) => Promise<void>;
}

export interface DaemonControlCommandInput {
  readonly rootDir: string;
  readonly layoutOverrides?: { readonly authoredRoot?: string };
  readonly args: ReadonlyArray<string>;
  readonly requestDaemonControl?: (request: DaemonControlRequest) => Promise<Record<string, unknown>>;
  readonly daemonControlLifecycle?: DaemonControlLifecycle;
  readonly daemonEntryPath: () => string;
}

type DaemonControlHandoff =
  | { readonly kind: "adopt"; readonly status: Record<string, unknown> }
  | { readonly kind: "autostart" };

export async function runDaemonControl(
  input: DaemonControlCommandInput,
  kind: DaemonControlKind
): Promise<Record<string, unknown>> {
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
      userRoot: daemonUserRootOption(input.args),
      socketPath: readOption(input.args, "--socket"),
      allowLegacySocket: false
    }
  ));
  const receipt = await request({ method, params });
  validateAcceptedControlReceipt(receipt, method, kind);
  const before = isDaemonControlRecord(receipt.before) ? receipt.before : {};
  const replacement = await completeDaemonReplacement(lifecycle, before.pid, drainTimeoutMs, kind, method);
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
  timeoutMs: number,
  kind: DaemonControlKind,
  method: DaemonControlRequest["method"]
): Promise<Record<string, unknown>> {
  if (!isPositivePid(beforePid)) {
    throw new Error(`${method} accepted receipt did not identify the running daemon PID`);
  }
  const handoff = await waitForDaemonControlHandoff(lifecycle, beforePid, timeoutMs);
  if (handoff.kind === "adopt") return handoff.status;
  let replacement: Record<string, unknown>;
  try {
    replacement = await lifecycle.startReplacement(lifecycle.target, timeoutMs);
  } catch (error) {
    throw new Error(`daemon ${kind} replacement did not become reachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const replacementLifecycle = normalizeDaemonLifecycleStatus(replacement);
  if (!replacementLifecycle) {
    throw new Error(`daemon ${kind} replacement did not return a reachable started daemon status`);
  }
  if (replacementLifecycle.pid === beforePid) {
    throw new Error(`daemon ${kind} replacement PID did not change: ${String(replacementLifecycle.pid)}`);
  }
  return replacement;
}

function defaultDaemonControlLifecycle(input: DaemonControlCommandInput): DaemonControlLifecycle {
  const entryPath = input.daemonEntryPath();
  const resolvedTarget = resolveLocalDaemonTarget({
    rootDir: input.rootDir,
    repoIdOverride: readOption(input.args, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID,
    userRoot: daemonUserRootOption(input.args),
    autoRegisterSingleRepo: false
  });
  const socketPath = readOption(input.args, "--socket");
  const target = socketPath ? { ...resolvedTarget, socketPath } : resolvedTarget;
  return {
    target,
    probeStatus: probeExactDaemonStatus,
    ownerIsAlive: daemonProcessIsAlive,
    startReplacement: (candidate, timeoutMs) => startDaemonReplacement(
      candidate,
      input.layoutOverrides,
      entryPath,
      timeoutMs
    ),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}

async function waitForDaemonControlHandoff(
  lifecycle: DaemonControlLifecycle,
  beforePid: number,
  timeoutMs: number
): Promise<DaemonControlHandoff> {
  const pollIntervalMs = 100;
  const attempts = Math.ceil(timeoutMs / pollIntervalMs) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await lifecycle.probeStatus(lifecycle.target);
    const ownerAlive = lifecycle.ownerIsAlive(beforePid);

    // One service process owns each OS-user + userRoot pair. While the old
    // owner lives, neither a reachable endpoint nor autostart can prove a safe handoff.
    if (!ownerAlive) {
      // Once the owner is dead, an absent exact endpoint is the only state
      // that permits the existing autostart primitive to run.
      if (!status) return { kind: "autostart" };
      const observedLifecycle = normalizeDaemonLifecycleStatus(status);
      if (observedLifecycle && observedLifecycle.pid !== beforePid) {
        return { kind: "adopt", status };
      }
      // Reachable old-PID or malformed status is not replacement proof and
      // blocks autostart, avoiding an overlapping service-owner window.
    }

    if (attempt + 1 === attempts) {
      if (status) {
        throw new Error(`old daemon endpoint was not released before timeout (pid ${beforePid})`);
      }
      throw new Error(`old daemon owner did not exit after releasing its endpoint (pid ${beforePid})`);
    }
    await lifecycle.wait(pollIntervalMs);
  }
  throw new Error(`daemon control handoff exhausted without a safe decision (pid ${beforePid})`);
}

function normalizeDaemonLifecycleStatus(
  status: Record<string, unknown>
): { readonly started: true; readonly pid: number } | undefined {
  const lifecycle = status.schema === "daemon-status/v2"
    ? (isDaemonControlRecord(status.service) ? status.service : undefined)
    : status.schema === "daemon-status/v1"
      ? status
      : undefined;
  if (lifecycle?.started !== true || !isPositivePid(lifecycle.pid)) return undefined;
  return { started: true, pid: lifecycle.pid };
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
  entryPath: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const receipt = await requestLocalDaemonJsonRpcForTarget(target, "repo.daemon.status", {
    repo: { repoId: target.repoId }
  }, 1_000, {
    entryPath,
    idleExitMs: 0,
    timeoutMs,
    layoutOverrides
  });
  const status = statusFromReceipt(receipt);
  if (!status) throw new Error("replacement status RPC did not return daemon status data");
  return status;
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
