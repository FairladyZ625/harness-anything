import path from "node:path";
import { makeDaemonLogService } from "@harness-anything/application";
import { createHarnessRuntimeContext, resolveHarnessLayout } from "@harness-anything/kernel";
import {
  currentDaemonProtocolVersion,
  DaemonRepoRootResolutionError,
  makeDaemonLogFileStore,
  observeDaemonLifecycle
} from "@harness-anything/daemon";
import { readOption } from "../../cli/parse-options.ts";
import { resolveCliVersion } from "../core/version.ts";
import {
  requestLocalDaemonJsonRpc,
  resolveLocalDaemonTarget,
  type LocalDaemonTarget
} from "../../daemon/client.ts";
import type { DaemonCommandInput } from "./command-types.ts";
import { evaluateDaemonDeploymentCheck } from "./deployment-check.ts";
import { readDaemonStatusWithGenerationFallback } from "./status-compatibility.ts";
import {
  projectDaemonRepositoryService,
  readDaemonRepositoryLock
} from "./repository-service-status.ts";

export interface DaemonStatusCommandResult {
  readonly exitCode: number;
  readonly result: Record<string, unknown>;
}

export async function runDaemonDeploymentStatusCommand(input: DaemonCommandInput): Promise<DaemonStatusCommandResult> {
  const repoIdOverride = deploymentDaemonRepoIdOverride(input.args);
  const userRoot = readDeploymentDaemonUserRootOption(input.args);
  const target = resolveDaemonStatusTarget(input, repoIdOverride, userRoot);
  const layout = resolveHarnessLayout(createHarnessRuntimeContext(target.canonicalRoot, input.layoutOverrides));
  const lockStatus = readDaemonRepositoryLock(path.join(layout.locksRoot, "global.lock"));
  const rpcStatus = await readReachableDaemonDeploymentStatus(target, true, true);
  const cliRpcStatus = rpcStatus ? deploymentStatusForCli(rpcStatus) : undefined;
  const lifecycle = await observeDaemonLifecycle({
    userRoot: target.userRoot,
    repo: { repoId: target.repoId, canonicalRoot: target.canonicalRoot },
    reachable: Boolean(rpcStatus),
    logService: makeDaemonLogService({ store: makeDaemonLogFileStore({ userRoot: target.userRoot }) })
  });
  const deploymentCheck = input.args.includes("--check") ? evaluateDaemonDeploymentCheck(rpcStatus) : undefined;
  const result = {
    ...lockStatus,
    ...(cliRpcStatus ?? {
      version: resolveCliVersion(),
      protocolVersion: currentDaemonProtocolVersion,
      queueDepth: 0,
      queue: { interactive: 0, normal: 0, background: 0, maintenance: 0, running: false },
      connections: { active: 0, total: 0 }
    }),
    started: Boolean(rpcStatus),
    reachable: Boolean(rpcStatus),
    repositoryService: projectDaemonRepositoryService({
      requestedRepoId: target.repoId,
      canonicalRoot: target.canonicalRoot,
      connectedUserRoot: target.userRoot,
      connectedEndpoint: target.socketPath,
      ...(rpcStatus ? { reachableStatus: rpcStatus } : {}),
      lockStatus
    }),
    lifecycle,
    ...(deploymentCheck ? { deploymentCheck } : {})
  };
  return {
    exitCode: deploymentCheck && !deploymentCheck.passed ? 1 : 0,
    result
  };
}

function resolveDaemonStatusTarget(
  input: DaemonCommandInput,
  repoIdOverride: string | undefined,
  userRoot: string | undefined
): LocalDaemonTarget {
  try {
    return resolveLocalDaemonTarget({
      rootDir: input.rootDir,
      repoIdOverride,
      userRoot,
      layoutOverrides: input.layoutOverrides,
      autoRegisterSingleRepo: false
    });
  } catch (error) {
    if (!(error instanceof DaemonRepoRootResolutionError)) throw error;
    return resolveLocalDaemonTarget({
      rootDir: input.rootDir,
      repoIdOverride: repoIdOverride ?? "canonical",
      userRoot,
      layoutOverrides: input.layoutOverrides,
      autoRegisterSingleRepo: false
    });
  }
}

async function readReachableDaemonDeploymentStatus(
  target: LocalDaemonTarget,
  includeGenerationAxes = false,
  includeDeploymentIdentity = false
): Promise<Record<string, unknown> | undefined> {
  return readDaemonStatusWithGenerationFallback(includeGenerationAxes, (includeAxes, includeDeployment) =>
    requestLocalDaemonJsonRpc(target.canonicalRoot, "repo.daemon.status", {
      repo: { repoId: target.repoId },
      ...(includeAxes ? { includeGenerationAxes: true } : {}),
      ...(includeDeployment ? { includeDeploymentIdentity: true } : {})
    }, 1_000, {
      userRoot: target.userRoot,
      daemonId: target.daemonId,
      socketPath: target.socketPath,
      allowLegacySocket: true
    }), includeDeploymentIdentity
  );
}

function deploymentStatusForCli(status: Record<string, unknown>): Record<string, unknown> {
  if (status.schema !== "daemon-status/v2") return status;
  const service = isDeploymentStatusRecord(status.service) ? status.service : {};
  const requestedRepo = isDeploymentStatusRecord(status.requestedRepo) ? status.requestedRepo : {};
  const lock = isDeploymentStatusRecord(requestedRepo.lock) ? requestedRepo.lock : {};
  const queue = isDeploymentStatusRecord(service.queue) ? service.queue : {};
  const build = isDeploymentStatusRecord(service.build) ? service.build : {};
  const repos = Array.isArray(status.repos)
    ? status.repos.map((entry) => {
        if (!isDeploymentStatusRecord(entry)) return entry;
        const repoLock = isDeploymentStatusRecord(entry.lock) ? entry.lock : {};
        return { ...entry, lockPath: repoLock.path ?? null, lockOwnerToken: repoLock.ownerToken ?? null };
      })
    : [];
  return {
    ...status,
    ...service,
    version: build.version ?? resolveCliVersion(),
    protocolVersion: currentDaemonProtocolVersion,
    rootDir: requestedRepo.canonicalRoot,
    repoId: requestedRepo.repoId,
    lock,
    lockPath: lock.path ?? null,
    lockOwnerToken: lock.ownerToken ?? null,
    queueDepth: queue.depth ?? 0,
    repos
  };
}

function deploymentDaemonRepoIdOverride(args: ReadonlyArray<string>): string | undefined {
  return readOption(args, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID;
}

function readDeploymentDaemonUserRootOption(args: ReadonlyArray<string>): string | undefined {
  return readOption(args, "--user-root") ?? process.env.HARNESS_DAEMON_USER_ROOT;
}

function isDeploymentStatusRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
