import path from "node:path";
import { daemonBuildStamp } from "../build-identity.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import { isDaemonUnreachable, readDaemonStoppedAt, runtimeDaemonStartRefusal } from "./daemon-autostart.ts";
import { installedDaemonServiceUnit } from "./daemon-service.ts";
import { readFleetEdgeConfig } from "./fleet-edge-config.ts";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  readRegisteredRepos,
  resolveLocalDaemonEndpoint,
  resolveLocalDaemonTarget,
} from "./local-daemon-target.ts";
import {
  asUpgradeError,
  captureAsync,
  commitsMatch,
  DEFAULT_HANDOFF_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RPC_CONNECT_TIMEOUT_MS,
  DEFAULT_RPC_RESPONSE_TIMEOUT_MS,
  DEFAULT_SYNC_TIMEOUT_MS,
  defaultEnsureDaemonRunning,
  defaultReadDiskBuildId,
  defaultRequestDaemonRpc,
  defaultRunGit,
  defaultRunSourceInstaller,
  delay,
  EDGE_UPGRADE_COMMAND,
  EDGE_UPGRADE_RECEIPT_SCHEMA,
  EDGE_UPGRADE_STATE_SCHEMA,
  EdgeUpgradeError,
  edgeUpgradeStatePath,
  extractDaemonBuildId,
  failureReceipt,
  isDaemonDrifted,
  isRecord,
  parseCenterBuildCommitFromText,
  readEdgeUpgradeState,
  resolveEdgeInstallRoot,
  SUPERVISED_RESPAWN_GRACE_MS,
  tailText,
  writeEdgeUpgradeState,
  type EdgeUpgradeInstallerInvocation,
  type EdgeUpgradeInstallerResult,
  type EdgeUpgradeOptions,
  type EdgeUpgradeReceipt,
  type EdgeUpgradeRepoSyncResult,
  type EdgeUpgradeStage,
  type EdgeUpgradeStatusReport,
} from "./edge-upgrade-support.ts";

export {
  commitsMatch,
  defaultRunSourceInstaller,
  EDGE_UPGRADE_COMMAND,
  EDGE_UPGRADE_RECEIPT_SCHEMA,
  EDGE_UPGRADE_STATE_SCHEMA,
  edgeUpgradeStatePath,
  isSourceInstallRoot,
  parseCenterBuildCommitFromText,
  readEdgeUpgradeState,
  resolveEdgeInstallRoot,
  writeEdgeUpgradeState,
  type EdgeUpgradeInstallerInvocation,
  type EdgeUpgradeInstallerResult,
  type EdgeUpgradeOptions,
  type EdgeUpgradeOutcome,
  type EdgeUpgradeProgress,
  type EdgeUpgradeReceipt,
  type EdgeUpgradeRepoSyncResult,
  type EdgeUpgradeStage,
  type EdgeUpgradeState,
  type EdgeUpgradeStatusReport,
} from "./edge-upgrade-support.ts";

interface ResolvedEdgeRepo {
  readonly repoId: string;
  readonly canonicalRoot: string;
}

export async function checkEdgeUpgradeStatus(
  options: Omit<EdgeUpgradeOptions, "toRef" | "offline" | "rollback"> = {},
): Promise<EdgeUpgradeStatusReport> {
  const env = options.env ?? process.env,
    userRoot = path.resolve(options.userRoot ?? daemonUserRoot(env)),
    daemonId = options.daemonId ?? daemonIdFromEnv(env),
    runGit = options.runGit ?? defaultRunGit,
    requestRpc = options.requestDaemonRpc ?? defaultRequestDaemonRpc,
    installRoot = resolveEdgeInstallRoot({ installRoot: options.installRoot, env }),
    state = readEdgeUpgradeState(userRoot),
    canRollback = state !== null && state.previousCommit.length > 0;
  let localCommit: string | null = null;
  if (installRoot) {
    const headResult = await captureAsync(() => runGit(installRoot, ["rev-parse", "HEAD"]));
    if (headResult.ok) localCommit = headResult.value.stdout.trim() || null;
  }
  const resolved = await resolveEdgeContext({
    userRoot,
    daemonId,
    env,
    rootDir: options.rootDir,
    repoId: options.repoId,
    socketPath: options.socketPath,
  });
  let daemonCommit: string | null = null;
  let daemonWarnings: readonly string[] = [];
  const statusResult = await captureAsync(() =>
    requestRpc(
      resolved.socketPath,
      "daemon.status",
      {},
      DEFAULT_RPC_CONNECT_TIMEOUT_MS,
      DEFAULT_RPC_RESPONSE_TIMEOUT_MS,
      true,
    ),
  );
  if (statusResult.ok) {
    daemonCommit = extractDaemonBuildId(statusResult.value);
    daemonWarnings = Array.isArray(statusResult.value.fleetVersionWarnings)
      ? statusResult.value.fleetVersionWarnings.filter((entry): entry is string => typeof entry === "string")
      : [];
  }
  const primaryRepo = resolved.repos[0] ?? null;
  const discovered = await discoverCenterBuildCommit({
    socketPath: resolved.socketPath,
    repoId: primaryRepo?.repoId ?? null,
    daemonWarnings,
    requestRpc,
  });
  const effectiveLocal = daemonCommit ?? localCommit ?? daemonBuildStamp().commit;
  const updateAvailable = Boolean(
    discovered.commit && effectiveLocal && !commitsMatch(effectiveLocal, discovered.commit),
  );
  return {
    ok: installRoot !== null,
    channel: "source",
    installRoot,
    repoId: primaryRepo?.repoId ?? null,
    localCommit,
    daemonCommit,
    centerCommit: discovered.commit,
    centerCommitSource: discovered.source,
    updateAvailable,
    canRollback,
    previousCommit: canRollback ? state.previousCommit : null,
    ...(installRoot === null
      ? { reason: "No source checkout with scripts/install-source.{sh,ps1} was found." }
      : discovered.commit === null && primaryRepo === null
        ? { reason: "No remote-edge repository is registered; specify --to <commit> to upgrade to a specific commit." }
        : {}),
  };
}

export async function runEdgeUpgrade(options: EdgeUpgradeOptions = {}): Promise<EdgeUpgradeReceipt> {
  const env = options.env ?? process.env,
    userRoot = path.resolve(options.userRoot ?? daemonUserRoot(env)),
    daemonId = options.daemonId ?? daemonIdFromEnv(env),
    runGit = options.runGit ?? defaultRunGit,
    runInstaller = options.runInstaller ?? defaultRunSourceInstaller,
    requestRpc = options.requestDaemonRpc ?? defaultRequestDaemonRpc,
    readDiskBuildId = options.readDiskBuildId ?? defaultReadDiskBuildId,
    handoffTimeoutMs = options.handoffTimeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS,
    pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS,
    supervisedRespawnGraceMs = options.supervisedRespawnGraceMs ?? SUPERVISED_RESPAWN_GRACE_MS,
    progress = (stage: EdgeUpgradeStage, message: string, fromCommit?: string | null, targetCommit?: string | null) =>
      options.onProgress?.({ stage, message, fromCommit, targetCommit });

  const runtimeRefusal = runtimeDaemonStartRefusal(env);
  if (runtimeRefusal) {
    return failureReceipt({
      code: runtimeRefusal.code,
      hint: runtimeRefusal.hint,
      installRoot: null,
      repoId: options.repoId ?? null,
    });
  }
  if (options.rollback && options.toRef) {
    return failureReceipt({
      code: "invalid_field",
      hint: "Cannot combine --rollback with --to <ref>; choose one.",
      installRoot: null,
      repoId: options.repoId ?? null,
    });
  }

  progress("preflight", "Checking edge install checkout, daemon status, and target version.");
  const savedState = readEdgeUpgradeState(userRoot),
    installRoot = resolveEdgeInstallRoot({
      installRoot: options.installRoot ?? (options.rollback ? savedState?.installRoot : undefined),
      env,
    });
  if (!installRoot) {
    return failureReceipt({
      code: "edge_install_root_missing",
      hint:
        "No source checkout containing scripts/install-source.{sh,ps1} was found. " +
        "Pass --install-root <path> or set HARNESS_INSTALL_ROOT.",
      installRoot: null,
      repoId: options.repoId ?? null,
    });
  }

  const resolved = await resolveEdgeContext({
    userRoot,
    daemonId,
    env,
    rootDir: options.rootDir,
    repoId: options.repoId,
    socketPath: options.socketPath,
  });
  const primaryRepoId = resolved.repos[0]?.repoId ?? null;

  const preflightCheckout = await captureAsync(async () => {
    const head = (await runGit(installRoot, ["rev-parse", "HEAD"])).stdout.trim();
    if (!head) throw new EdgeUpgradeError("edge_checkout_invalid", `Could not read HEAD commit at ${installRoot}.`);
    const branch = await readSymbolicBranch(runGit, installRoot);
    const dirty = (await runGit(installRoot, ["status", "--porcelain"])).stdout.trim();
    return { head, branch, dirty };
  });
  if (!preflightCheckout.ok) {
    const coded = asUpgradeError(preflightCheckout.error, "edge_checkout_invalid");
    return failureReceipt({ code: coded.code, hint: coded.message, installRoot, repoId: primaryRepoId });
  }
  const previousCommit = preflightCheckout.value.head;
  const previousBranch = preflightCheckout.value.branch;
  if (preflightCheckout.value.dirty.length > 0) {
    return failureReceipt({
      code: "edge_checkout_dirty",
      hint: `Source checkout at ${installRoot} has local changes. Commit or remove them before running ${EDGE_UPGRADE_COMMAND}.`,
      installRoot,
      repoId: primaryRepoId,
      fromCommit: previousCommit,
    });
  }

  const preStatus = await readDaemonStatusQuietly(requestRpc, resolved.socketPath),
    previousPid = preStatus && typeof preStatus.pid === "number" ? preStatus.pid : null,
    previousDaemonBuildId = preStatus ? extractDaemonBuildId(preStatus) : null,
    previousDiskBuildId = readDiskBuildId(installRoot),
    daemonWarnings =
      preStatus && Array.isArray(preStatus.fleetVersionWarnings)
        ? preStatus.fleetVersionWarnings.filter((entry): entry is string => typeof entry === "string")
        : [];

  let targetRef: string;
  if (options.rollback) {
    if (!savedState || !savedState.previousCommit) {
      return failureReceipt({
        code: "edge_upgrade_rollback_unavailable",
        hint: `No previous upgrade state recorded at ${edgeUpgradeStatePath(userRoot)}. Pass --to <commit> to install a specific commit.`,
        installRoot,
        repoId: primaryRepoId,
        fromCommit: previousCommit,
      });
    }
    targetRef = savedState.previousCommit;
  } else if (options.toRef?.trim()) {
    targetRef = options.toRef.trim();
  } else {
    const discovered = await discoverCenterBuildCommit({
      socketPath: resolved.socketPath,
      repoId: primaryRepoId,
      daemonWarnings,
      requestRpc,
    });
    if (!discovered.commit) {
      return failureReceipt({
        code: primaryRepoId ? "edge_center_version_unavailable" : "edge_repo_not_found",
        hint: primaryRepoId
          ? `Could not determine the center build commit for ${primaryRepoId}. Ensure the daemon can reach the center or pass --to <commit>.`
          : `No remote-edge repository is registered in ${userRoot}. Join a center with \`ha edge join <invite-link>\` or pass --to <commit>.`,
        installRoot,
        repoId: primaryRepoId,
        fromCommit: previousCommit,
      });
    }
    targetRef = discovered.commit;
  }

  const resolvedLocalTarget = await resolveLocalGitCommit(runGit, installRoot, targetRef),
    effectiveTarget = resolvedLocalTarget ?? targetRef,
    alreadyOnDiskAndDaemon =
      !options.rollback &&
      commitsMatch(previousCommit, effectiveTarget) &&
      previousDaemonBuildId !== null &&
      commitsMatch(previousDaemonBuildId, previousDiskBuildId ?? previousCommit) &&
      !isDaemonDrifted(preStatus);

  if (alreadyOnDiskAndDaemon) {
    const syncResult = await captureAsync(() =>
      confirmFirstSyncForRepos({
        repos: resolved.repos,
        userRoot,
        socketPath: resolved.socketPath,
        syncTimeoutMs,
        requestRpc,
      }),
    );
    if (!syncResult.ok) {
      const coded = asUpgradeError(syncResult.error, "edge_upgrade_sync_failed");
      progress(
        "failed",
        `Already at ${previousCommit.slice(0, 12)}, but first sync failed: ${coded.message}`,
        previousCommit,
        previousCommit,
      );
      return failureReceipt({
        code: coded.code,
        hint: coded.message,
        installRoot,
        repoId: primaryRepoId,
        fromCommit: previousCommit,
        targetCommit: effectiveTarget,
      });
    }
    const syncedRepos = syncResult.value;
    progress("completed", `Edge is already at ${previousCommit.slice(0, 12)}.`, previousCommit, previousCommit);
    return {
      schema: EDGE_UPGRADE_RECEIPT_SCHEMA,
      ok: true,
      command: "edge-upgrade",
      outcome: "already_current",
      installRoot,
      repoId: primaryRepoId,
      fromCommit: previousCommit,
      toCommit: previousCommit,
      targetCommit: effectiveTarget,
      daemonPid: previousPid,
      daemonBuildId: previousDaemonBuildId,
      daemonRestarted: false,
      syncedRepos,
      ...(resolved.repos.length === 0 ? { syncSkippedReason: "no_remote_edge_repo" } : {}),
      rolledBack: false,
      guiRestartRequired: false,
    };
  }

  const ensureDaemon = options.ensureDaemonRunning ?? ((launchInput) => defaultEnsureDaemonRunning(launchInput, env)),
    invokingRoot = resolved.repos[0]?.canonicalRoot ?? installRoot;
  if (!options.rollback) {
    writeEdgeUpgradeState(userRoot, {
      schema: EDGE_UPGRADE_STATE_SCHEMA,
      installRoot,
      previousCommit,
      previousBranch,
      targetCommit: effectiveTarget,
      repoId: primaryRepoId,
      updatedAt: new Date().toISOString(),
      outcome: "in_progress",
    });
  }

  const useOfflineInstall = options.offline === true || options.rollback === true;
  const upgradeRun = await captureAsync<EdgeUpgradeReceipt>(async () => {
    progress(
      "installing",
      `${options.rollback ? "Rolling back" : "Upgrading"} checkout at ${installRoot} to ${effectiveTarget.slice(0, 12)} via scripts/install-source.`,
      previousCommit,
      effectiveTarget,
    );
    const installedCommit = await checkoutAndInstall({
      installRoot,
      targetRef: effectiveTarget,
      offline: useOfflineInstall,
      env,
      runGit,
      runInstaller,
    });
    const expectedBuildId = readDiskBuildId(installRoot) ?? installedCommit;

    progress(
      "handing_off",
      `Waiting for daemon build_superseded handoff to ${expectedBuildId.slice(0, 12)}.`,
      previousCommit,
      installedCommit,
    );
    const handoff = await waitForDaemonBuildHandoff({
      socketPath: resolved.socketPath,
      userRoot,
      daemonId,
      installRoot,
      invokingRoot,
      previousPid,
      expectedBuildId,
      handoffTimeoutMs,
      pollIntervalMs,
      supervisedRespawnGraceMs,
      requestRpc,
      ensureDaemon,
    });

    progress(
      "syncing",
      resolved.repos.length > 0
        ? `Confirming first sync for ${resolved.repos.map((repo) => repo.repoId).join(", ")}.`
        : "No remote-edge repositories registered; skipping first sync.",
      previousCommit,
      installedCommit,
    );
    const syncedRepos = await confirmFirstSyncForRepos({
      repos: resolved.repos,
      userRoot,
      socketPath: resolved.socketPath,
      syncTimeoutMs,
      requestRpc,
    });

    writeEdgeUpgradeState(userRoot, {
      schema: EDGE_UPGRADE_STATE_SCHEMA,
      installRoot,
      previousCommit,
      previousBranch,
      targetCommit: installedCommit,
      repoId: primaryRepoId,
      updatedAt: new Date().toISOString(),
      outcome: options.rollback ? "rolled_back" : "upgraded",
    });

    progress(
      options.rollback ? "rolled_back" : "completed",
      `${options.rollback ? "Rolled back" : "Upgraded"} edge from ${previousCommit.slice(0, 12)} to ${installedCommit.slice(0, 12)}.`,
      previousCommit,
      installedCommit,
    );
    return {
      schema: EDGE_UPGRADE_RECEIPT_SCHEMA,
      ok: true,
      command: "edge-upgrade",
      outcome: options.rollback ? "rolled_back" : "upgraded",
      installRoot,
      repoId: primaryRepoId,
      fromCommit: previousCommit,
      toCommit: installedCommit,
      targetCommit: installedCommit,
      daemonPid: handoff.pid,
      daemonBuildId: handoff.loadedBuildId,
      daemonRestarted: handoff.restarted,
      syncedRepos,
      ...(resolved.repos.length === 0 ? { syncSkippedReason: "no_remote_edge_repo" } : {}),
      rolledBack: options.rollback === true,
      guiRestartRequired: true,
    };
  });
  if (upgradeRun.ok) return upgradeRun.value;

  const original = asUpgradeError(upgradeRun.error, "edge_upgrade_failed");
  if (options.rollback) {
    progress("failed", `Rollback failed: ${original.message}`, previousCommit, effectiveTarget);
    return failureReceipt({
      code: original.code,
      hint: original.message,
      installRoot,
      repoId: primaryRepoId,
      fromCommit: previousCommit,
      targetCommit: effectiveTarget,
    });
  }
  progress(
    "rolling_back",
    `Upgrade failed (${original.code}); automatically rolling back to ${previousCommit.slice(0, 12)}.`,
    previousCommit,
    effectiveTarget,
  );
  const rollback = await attemptAutomaticRollback({
    installRoot,
    previousCommit,
    previousBranch,
    previousBuildId: previousDiskBuildId ?? previousDaemonBuildId ?? previousCommit,
    socketPath: resolved.socketPath,
    userRoot,
    daemonId,
    invokingRoot,
    repos: resolved.repos,
    env,
    handoffTimeoutMs,
    pollIntervalMs,
    syncTimeoutMs,
    supervisedRespawnGraceMs,
    runGit,
    runInstaller,
    requestRpc,
    ensureDaemon,
    readDiskBuildId,
  });
  writeEdgeUpgradeState(userRoot, {
    schema: EDGE_UPGRADE_STATE_SCHEMA,
    installRoot,
    previousCommit,
    previousBranch,
    targetCommit: effectiveTarget,
    repoId: primaryRepoId,
    updatedAt: new Date().toISOString(),
    outcome: rollback.ok ? "rolled_back" : "failed",
  });
  progress(
    rollback.ok ? "rolled_back" : "failed",
    rollback.ok
      ? `Rolled back to ${previousCommit.slice(0, 12)} after ${original.code}.`
      : `Upgrade failed (${original.code}) and rollback also failed: ${rollback.error ?? "unknown"}.`,
    previousCommit,
    effectiveTarget,
  );
  return {
    schema: EDGE_UPGRADE_RECEIPT_SCHEMA,
    ok: false,
    command: "edge-upgrade",
    outcome: rollback.ok ? "rolled_back" : "rollback_failed",
    code: original.code,
    installRoot,
    repoId: primaryRepoId,
    fromCommit: previousCommit,
    toCommit: rollback.ok ? previousCommit : null,
    targetCommit: effectiveTarget,
    daemonPid: rollback.daemonPid,
    daemonBuildId: rollback.daemonBuildId,
    daemonRestarted: rollback.daemonRestarted,
    syncedRepos: rollback.syncedRepos,
    rolledBack: rollback.ok,
    ...(rollback.ok ? { rollbackSyncOk: rollback.syncOk } : { rollbackError: rollback.error }),
    guiRestartRequired: false,
    error: { code: original.code, hint: original.message },
    nextAction: rollback.ok
      ? `Edge was restored to ${previousCommit.slice(0, 12)}. Fix the reported error (${original.code}) and retry ${EDGE_UPGRADE_COMMAND}.`
      : `Manual recovery required at ${installRoot}: checkout ${previousCommit.slice(0, 12)} and rerun scripts/install-source --offline --ref ${previousCommit}.`,
  };
}

async function checkoutAndInstall(input: {
  readonly installRoot: string;
  readonly targetRef: string;
  readonly offline: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly runGit: NonNullable<EdgeUpgradeOptions["runGit"]>;
  readonly runInstaller: (invocation: EdgeUpgradeInstallerInvocation) => Promise<EdgeUpgradeInstallerResult>;
}): Promise<string> {
  let effectiveRef = input.targetRef;
  if (input.offline) {
    const localSha = await resolveLocalGitCommit(input.runGit, input.installRoot, input.targetRef);
    if (!localSha) {
      throw new EdgeUpgradeError(
        "edge_upgrade_ref_not_found",
        `Offline upgrade cannot find commit ${input.targetRef} in local git history at ${input.installRoot}.`,
      );
    }
    const currentHead = (await input.runGit(input.installRoot, ["rev-parse", "HEAD"])).stdout.trim();
    if (currentHead !== localSha) await input.runGit(input.installRoot, ["checkout", "--detach", localSha]);
    effectiveRef = localSha;
  }
  const installerResult = await input.runInstaller({
    installRoot: input.installRoot,
    ref: effectiveRef,
    offline: input.offline,
    env: input.env,
  });
  if (installerResult.exitCode !== 0) {
    const detail = tailText(installerResult.stderr || installerResult.stdout, 1_200);
    throw new EdgeUpgradeError(
      "edge_upgrade_install_failed",
      `Source installer exited with code ${installerResult.exitCode}${detail ? `: ${detail}` : "."}`,
    );
  }
  const installedHead = (await input.runGit(input.installRoot, ["rev-parse", "HEAD"])).stdout.trim();
  if (!installedHead) {
    throw new EdgeUpgradeError("edge_upgrade_install_failed", `Could not read HEAD after installing ${effectiveRef}.`);
  }
  return installedHead;
}

async function waitForDaemonBuildHandoff(input: {
  readonly socketPath: string;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly installRoot: string;
  readonly invokingRoot: string;
  readonly previousPid: number | null;
  readonly expectedBuildId: string;
  readonly handoffTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly supervisedRespawnGraceMs: number;
  readonly requestRpc: NonNullable<EdgeUpgradeOptions["requestDaemonRpc"]>;
  readonly ensureDaemon: NonNullable<EdgeUpgradeOptions["ensureDaemonRunning"]>;
}): Promise<{ readonly pid: number | null; readonly loadedBuildId: string; readonly restarted: boolean }> {
  const deadline = Date.now() + input.handoffTimeoutMs,
    hasServiceUnit = installedDaemonServiceUnit({ userRoot: input.userRoot, daemonId: input.daemonId }) !== null;
  let firstUnreachableAt: number | null = null,
    autostartTriggered = false,
    lastObservedBuildId: string | null = null;
  for (;;) {
    const statusResult = await captureAsync(() =>
      input.requestRpc(
        input.socketPath,
        "daemon.status",
        {},
        DEFAULT_RPC_CONNECT_TIMEOUT_MS,
        DEFAULT_RPC_RESPONSE_TIMEOUT_MS,
        true,
      ),
    );
    if (statusResult.ok) {
      const status = statusResult.value;
      firstUnreachableAt = null;
      const loadedBuildId = extractDaemonBuildId(status);
      lastObservedBuildId = loadedBuildId;
      const pid = typeof status.pid === "number" ? status.pid : null;
      if (loadedBuildId !== null && commitsMatch(loadedBuildId, input.expectedBuildId) && !isDaemonDrifted(status)) {
        return { pid, loadedBuildId, restarted: input.previousPid === null || pid !== input.previousPid };
      }
    } else if (isDaemonUnreachable(statusResult.error)) {
      firstUnreachableAt ??= Date.now();
      const graceElapsed = !hasServiceUnit || Date.now() - firstUnreachableAt >= input.supervisedRespawnGraceMs;
      if (graceElapsed && !autostartTriggered) {
        const stoppedAt = readDaemonStoppedAt(input.userRoot, input.daemonId);
        if (stoppedAt) {
          throw new EdgeUpgradeError(
            "daemon_stopped_by_operator",
            `Daemon was stopped by operator at ${stoppedAt}; start it with \`ha daemon start --service\`.`,
          );
        }
        autostartTriggered = true;
        const started = await input.ensureDaemon({
          socketPath: input.socketPath,
          invokingRoot: input.invokingRoot,
          userRoot: input.userRoot,
          daemonId: input.daemonId,
          installRoot: input.installRoot,
        });
        if (!started.ok) {
          throw new EdgeUpgradeError(
            started.code ?? "edge_upgrade_handoff_failed",
            `Replacement daemon failed to start: ${started.hint}`,
          );
        }
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new EdgeUpgradeError(
        "edge_upgrade_handoff_timeout",
        `Timed out after ${input.handoffTimeoutMs}ms waiting for daemon handoff to ${input.expectedBuildId.slice(0, 12)}` +
          `${lastObservedBuildId ? ` (still running ${lastObservedBuildId.slice(0, 12)})` : " (daemon unreachable)"}.`,
      );
    }
    await delay(input.pollIntervalMs);
  }
}

async function confirmFirstSyncForRepos(input: {
  readonly repos: readonly ResolvedEdgeRepo[];
  readonly userRoot: string;
  readonly socketPath: string;
  readonly syncTimeoutMs: number;
  readonly requestRpc: NonNullable<EdgeUpgradeOptions["requestDaemonRpc"]>;
}): Promise<readonly EdgeUpgradeRepoSyncResult[]> {
  const results: EdgeUpgradeRepoSyncResult[] = [];
  for (const repo of input.repos) {
    const edgeConfig = readFleetEdgeConfig(input.userRoot, repo.repoId, repo.canonicalRoot);
    if (!edgeConfig) {
      throw new EdgeUpgradeError(
        "fleet_edge_config_missing",
        `Missing fleet-edge.json for remote-edge repository ${repo.repoId}.`,
      );
    }
    const payload: JsonObject = {
      host: edgeConfig.host,
      port: edgeConfig.port,
      caPath: path.resolve(edgeConfig.caPath),
      ...(edgeConfig.spkiSha256 ? { spkiSha256: edgeConfig.spkiSha256 } : {}),
      ...(edgeConfig.trustAnchors ? { trustAnchors: edgeConfig.trustAnchors as JsonObject } : {}),
      nodeId: edgeConfig.nodeId,
      credential: edgeConfig.credential,
      repoId: repo.repoId,
      viewRoot: path.resolve(edgeConfig.viewRoot),
      quotaBytes: edgeConfig.quotaBytes,
      workspaceRoot: repo.canonicalRoot,
      ...(edgeConfig.servername ? { servername: edgeConfig.servername } : {}),
      timeoutMs: input.syncTimeoutMs,
    };
    const reply = await input.requestRpc(
      input.socketPath,
      "daemon.fleet.edge.sync",
      { payload },
      DEFAULT_RPC_CONNECT_TIMEOUT_MS,
      input.syncTimeoutMs + 10_000,
      false,
    );
    if (reply.ok !== true) {
      const replyCode =
        typeof reply.code === "string"
          ? reply.code
          : isRecord(reply.error) && typeof reply.error.code === "string"
            ? reply.error.code
            : "edge_upgrade_sync_failed";
      const hint =
        (isRecord(reply.error) && typeof reply.error.hint === "string" ? reply.error.hint : null) ??
        (typeof reply.nextAction === "string" ? reply.nextAction : null) ??
        `First sync failed for ${repo.repoId} (${replyCode}).`;
      throw new EdgeUpgradeError(replyCode === "edge_upgrade_required" ? replyCode : "edge_upgrade_sync_failed", hint);
    }
    const knownHead = isRecord(reply.knownHead) ? reply.knownHead : null;
    const revision =
      typeof reply.ackCut === "number"
        ? reply.ackCut
        : knownHead && typeof knownHead.revision === "number"
          ? knownHead.revision
          : null;
    results.push({
      repoId: repo.repoId,
      revision,
      lagRevisions: typeof reply.lagRevisions === "number" ? reply.lagRevisions : null,
      mirrorOutcome: typeof reply.mirrorOutcome === "string" ? reply.mirrorOutcome : null,
    });
  }
  return results;
}

async function attemptAutomaticRollback(input: {
  readonly installRoot: string;
  readonly previousCommit: string;
  readonly previousBranch: string | null;
  readonly previousBuildId: string;
  readonly socketPath: string;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly invokingRoot: string;
  readonly repos: readonly ResolvedEdgeRepo[];
  readonly env: NodeJS.ProcessEnv;
  readonly handoffTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly syncTimeoutMs: number;
  readonly supervisedRespawnGraceMs: number;
  readonly runGit: NonNullable<EdgeUpgradeOptions["runGit"]>;
  readonly runInstaller: NonNullable<EdgeUpgradeOptions["runInstaller"]>;
  readonly requestRpc: NonNullable<EdgeUpgradeOptions["requestDaemonRpc"]>;
  readonly ensureDaemon: NonNullable<EdgeUpgradeOptions["ensureDaemonRunning"]>;
  readonly readDiskBuildId: NonNullable<EdgeUpgradeOptions["readDiskBuildId"]>;
}): Promise<{
  readonly ok: boolean;
  readonly daemonPid: number | null;
  readonly daemonBuildId: string | null;
  readonly daemonRestarted: boolean;
  readonly syncedRepos: readonly EdgeUpgradeRepoSyncResult[];
  readonly syncOk: boolean;
  readonly error?: string;
}> {
  const rollbackRun = await captureAsync(async () => {
    await checkoutAndInstall({
      installRoot: input.installRoot,
      targetRef: input.previousCommit,
      offline: true,
      env: input.env,
      runGit: input.runGit,
      runInstaller: input.runInstaller,
    });
    if (input.previousBranch) {
      const branchCommit = await resolveLocalGitCommit(input.runGit, input.installRoot, input.previousBranch);
      if (branchCommit === input.previousCommit) {
        await captureAsync(() => input.runGit(input.installRoot, ["checkout", input.previousBranch!]));
      }
    }
    const handoff = await waitForDaemonBuildHandoff({
      socketPath: input.socketPath,
      userRoot: input.userRoot,
      daemonId: input.daemonId,
      installRoot: input.installRoot,
      invokingRoot: input.invokingRoot,
      previousPid: null,
      expectedBuildId: input.readDiskBuildId(input.installRoot) ?? input.previousBuildId,
      handoffTimeoutMs: input.handoffTimeoutMs,
      pollIntervalMs: input.pollIntervalMs,
      supervisedRespawnGraceMs: input.supervisedRespawnGraceMs,
      requestRpc: input.requestRpc,
      ensureDaemon: input.ensureDaemon,
    });
    let syncedRepos: readonly EdgeUpgradeRepoSyncResult[] = [];
    let syncOk = true;
    if (input.repos.length > 0) {
      const syncResult = await captureAsync(() =>
        confirmFirstSyncForRepos({
          repos: input.repos,
          userRoot: input.userRoot,
          socketPath: input.socketPath,
          syncTimeoutMs: input.syncTimeoutMs,
          requestRpc: input.requestRpc,
        }),
      );
      if (syncResult.ok) syncedRepos = syncResult.value;
      else syncOk = false;
    }
    return {
      ok: true,
      daemonPid: handoff.pid,
      daemonBuildId: handoff.loadedBuildId,
      daemonRestarted: handoff.restarted,
      syncedRepos,
      syncOk,
    };
  });
  if (rollbackRun.ok) return rollbackRun.value;
  return {
    ok: false,
    daemonPid: null,
    daemonBuildId: null,
    daemonRestarted: false,
    syncedRepos: [],
    syncOk: false,
    error: rollbackRun.error instanceof Error ? rollbackRun.error.message : String(rollbackRun.error),
  };
}

async function discoverCenterBuildCommit(input: {
  readonly socketPath: string;
  readonly repoId: string | null;
  readonly daemonWarnings: readonly string[];
  readonly requestRpc: NonNullable<EdgeUpgradeOptions["requestDaemonRpc"]>;
}): Promise<{ readonly commit: string | null; readonly source: string | null }> {
  if (input.repoId) {
    const overviewResult = await captureAsync(() =>
      input.requestRpc(
        input.socketPath,
        "repo.fleet.overview.read",
        { repo: { repoId: input.repoId } },
        DEFAULT_RPC_CONNECT_TIMEOUT_MS,
        DEFAULT_RPC_RESPONSE_TIMEOUT_MS,
        false,
      ),
    );
    if (overviewResult.ok) {
      const overview = overviewResult.value;
      if (isRecord(overview.versionWarning) && typeof overview.versionWarning.centerBuildCommit === "string")
        return { commit: overview.versionWarning.centerBuildCommit, source: "fleet_overview_warning" };
      if (isRecord(overview.center) && typeof overview.center.commitSha === "string" && overview.center.commitSha)
        return { commit: overview.center.commitSha, source: "fleet_overview_center" };
      if (Array.isArray(overview.nodes)) {
        for (const node of overview.nodes) {
          if (isRecord(node) && isRecord(node.lastFailure) && typeof node.lastFailure.text === "string") {
            const parsed = parseCenterBuildCommitFromText(node.lastFailure.text);
            if (parsed) return { commit: parsed, source: "fleet_overview_failure" };
          }
        }
      }
      const rejection =
        typeof overview.rejectionExplanation === "string"
          ? overview.rejectionExplanation
          : isRecord(overview.error) && typeof overview.error.hint === "string"
            ? overview.error.hint
            : null;
      if (rejection) {
        const parsed = parseCenterBuildCommitFromText(rejection);
        if (parsed) return { commit: parsed, source: "fleet_overview_error" };
      }
    } else {
      const parsed = parseCenterBuildCommitFromText(
        overviewResult.error instanceof Error ? overviewResult.error.message : String(overviewResult.error),
      );
      if (parsed) return { commit: parsed, source: "fleet_overview_exception" };
    }
  }
  for (const warning of input.daemonWarnings) {
    const parsed = parseCenterBuildCommitFromText(warning);
    if (parsed) return { commit: parsed, source: "daemon_status_warning" };
  }
  return { commit: null, source: null };
}

async function resolveEdgeContext(input: {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly rootDir?: string;
  readonly repoId?: string;
  readonly socketPath?: string;
}): Promise<{ readonly socketPath: string; readonly repos: readonly ResolvedEdgeRepo[] }> {
  const fallbackSocket =
    input.socketPath ??
    resolveLocalDaemonEndpoint({ userRoot: input.userRoot, daemonId: input.daemonId, env: input.env });
  if (input.repoId || input.rootDir) {
    const targetResult = await captureAsync(() =>
      resolveLocalDaemonTarget({
        rootDir: path.resolve(input.rootDir ?? process.cwd()),
        repoIdOverride: input.repoId,
        registrationMode: "remote-edge",
        userRoot: input.userRoot,
        daemonId: input.daemonId,
        env: input.env,
      }),
    );
    if (targetResult.ok && targetResult.value.remoteEdge) {
      return {
        socketPath: input.socketPath ?? targetResult.value.socketPath,
        repos: [{ repoId: targetResult.value.repoId, canonicalRoot: targetResult.value.canonicalRoot }],
      };
    }
  }
  const registeredResult = await captureAsync(() => readRegisteredRepos(input.userRoot));
  const registered = registeredResult.ok ? registeredResult.value : [];
  const edgeRepos = registered
    .filter((repo) => repo.state === "enabled" && repo.mode === "remote-edge")
    .filter((repo) => !input.repoId || repo.repoId === input.repoId)
    .map((repo) => ({ repoId: repo.repoId, canonicalRoot: repo.canonicalRoot }));
  return { socketPath: fallbackSocket, repos: edgeRepos };
}

async function readDaemonStatusQuietly(
  requestRpc: NonNullable<EdgeUpgradeOptions["requestDaemonRpc"]>,
  socketPath: string,
): Promise<JsonObject | null> {
  const result = await captureAsync(() =>
    requestRpc(socketPath, "daemon.status", {}, DEFAULT_RPC_CONNECT_TIMEOUT_MS, DEFAULT_RPC_RESPONSE_TIMEOUT_MS, true),
  );
  return result.ok ? result.value : null;
}

async function readSymbolicBranch(
  runGit: NonNullable<EdgeUpgradeOptions["runGit"]>,
  installRoot: string,
): Promise<string | null> {
  const result = await captureAsync(() => runGit(installRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  return result.ok ? result.value.stdout.trim() || null : null;
}

async function resolveLocalGitCommit(
  runGit: NonNullable<EdgeUpgradeOptions["runGit"]>,
  installRoot: string,
  ref: string,
): Promise<string | null> {
  const result = await captureAsync(() =>
    runGit(installRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]),
  );
  return result.ok ? result.value.stdout.trim() || null : null;
}
