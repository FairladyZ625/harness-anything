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
  normalizeDaemonLifecycleStatus,
} from "./control-convergence.ts";
import {
  completeDaemonReplacement,
  type DaemonControlLifecycle,
  type DaemonControlRecoveryGuidance
} from "./control-replacement.ts";
import {
  acceptedGenerationExpectation,
  generationExpectationFromCapabilityStatus
} from "./control-generation-capability.ts";
import { quoteDaemonRecoveryArgument } from "./snapshot-rollback.ts";

export type DaemonControlKind = "restart" | "refresh" | "upgrade";
type DaemonRefreshTrigger = "explicit" | "post-merge" | "dist-watcher";

export interface DaemonControlRequest {
  readonly method: "admin.daemon.restart" | "admin.daemon.refresh";
  readonly params: JsonObject;
}

export type { DaemonControlLifecycle } from "./control-replacement.ts";

export interface DaemonControlCommandInput {
  readonly rootDir: string;
  readonly layoutOverrides?: { readonly authoredRoot?: string };
  readonly args: ReadonlyArray<string>;
  readonly requestDaemonControl?: (request: DaemonControlRequest) => Promise<Record<string, unknown>>;
  readonly daemonControlLifecycle?: DaemonControlLifecycle;
  readonly daemonEntryPath: () => string;
  readonly calculateInstalledIdentity?: (entrypoint: string) => string;
  readonly platform?: NodeJS.Platform;
  readonly replacementEntrypoint?: string;
}

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
  const trigger = kind === "restart" ? undefined : daemonRefreshTrigger(input.args);
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
  const probedGeneration = lifecycle.probeGenerationStatus
    ? generationExpectationFromCapabilityStatus(
      await lifecycle.probeGenerationStatus(lifecycle.target),
      input.platform ?? process.platform
    )
    : undefined;
  const params = {
    payload: {
      reason: readOption(input.args, "--reason") ?? `${trigger ?? "explicit"} daemon ${kind} request`,
      drainTimeoutMs,
      ...(trigger ? { trigger } : {}),
      ...(kind === "upgrade" ? { kind: "upgrade" } : {}),
      ...(probedGeneration ? { daemonGeneration: probedGeneration.daemonGeneration } : {})
    }
  };
  const preparedRunningLaunchConfiguration = kind !== "restart"
    ? await lifecycle.prepareReplacement?.(lifecycle.target)
    : undefined;
  const preparedLaunchConfiguration = preparedRunningLaunchConfiguration && input.replacementEntrypoint
    ? { ...preparedRunningLaunchConfiguration, entrypoint: input.replacementEntrypoint }
    : preparedRunningLaunchConfiguration;
  const preparedExpectedIdentity = preparedLaunchConfiguration
    ? calculateInstalledIdentity(input, preparedLaunchConfiguration.entrypoint)
    : undefined;
  const rpcReceipt = await request({ method, params });
  const receipt = controlPayloadFromRpcReceipt(rpcReceipt, method);
  validateAcceptedControlReceipt(receipt, method, kind);
  const before = isDaemonControlRecord(receipt.before) ? receipt.before : {};
  const expectedGeneration = acceptedGenerationExpectation(receipt, before, probedGeneration);
  const launchConfiguration = preparedLaunchConfiguration
    ?? daemonReplacementLaunchConfiguration(before.launchConfiguration);
  const expectedIdentity = kind !== "restart"
    ? preparedExpectedIdentity ?? calculateInstalledIdentity(input, launchConfiguration.entrypoint)
    : undefined;
  const replacement = await completeDaemonReplacement({
    lifecycle,
    beforePid: before.pid,
    beforeLoadedIdentity: before.loadedIdentity,
    operationId: receipt.operationId,
    timeoutMs: drainTimeoutMs,
    kind,
    method,
    launchConfiguration,
    expectedIdentity,
    expectedGeneration,
    ...(input.replacementEntrypoint && preparedRunningLaunchConfiguration
      ? {
          rollbackLaunchConfiguration: preparedRunningLaunchConfiguration,
          upgradeRecovery: daemonControlRecoveryGuidance(input.args, lifecycle.target.userRoot)
        }
      : {})
  });
  const { schema: controlSchema, ...controlResult } = receipt;
  return {
    ...controlResult,
    kind,
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
    || (receipt.kind !== kind && !(kind === "upgrade" && receipt.kind === "refresh"))
    || typeof receipt.operationId !== "string"
    || receipt.operationId.length === 0) {
    throw new Error(`${method} did not return daemon-control-accepted/v1`);
  }
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
    probeGenerationStatus: (candidate) => probeExactDaemonStatus(candidate, { includeGenerationAxes: true }),
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
    startReplacement: (candidate, timeoutMs, launchConfiguration, capability) => startDaemonReplacement(
      candidate,
      input.layoutOverrides,
      timeoutMs,
      launchConfiguration,
      capability
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

async function probeExactDaemonStatus(
  target: LocalDaemonTarget,
  capability?: { readonly includeGenerationAxes: true }
): Promise<Record<string, unknown> | undefined> {
  try {
    const receipt = await requestLocalDaemonJsonRpc(target.canonicalRoot, "repo.daemon.status", {
      repo: { repoId: target.repoId },
      ...(capability ? { includeGenerationAxes: true } : {})
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
  launchConfiguration: DaemonLaunchConfiguration,
  capability?: { readonly includeGenerationAxes: true }
): Promise<Record<string, unknown>> {
  const receipt = await requestLocalDaemonJsonRpcForTarget(target, "repo.daemon.status", {
    repo: { repoId: target.repoId },
    ...(capability ? { includeGenerationAxes: true } : {})
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

function daemonControlRecoveryGuidance(
  args: ReadonlyArray<string>,
  userRoot: string
): DaemonControlRecoveryGuidance {
  const retryCommand = ["ha", ...args].map(quoteDaemonRecoveryArgument).join(" ");
  const customEndpoint = readOption(args, "--socket");
  if (customEndpoint) {
    return {
      retryCommand,
      occupiedEndpoint: `ha daemon stop does not target custom endpoint ${quoteDaemonRecoveryArgument(customEndpoint)}; `
        + `stop that endpoint owner explicitly, then retry exactly with: ${retryCommand}`
    };
  }
  const stop = ["ha", "daemon", "stop", "--user-root", userRoot]
    .map(quoteDaemonRecoveryArgument)
    .join(" ");
  return {
    retryCommand,
    occupiedEndpoint: `Stop the endpoint owner and retry exactly with: ${stop} && ${retryCommand}`
  };
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

function isDaemonControlRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
