import { realpathSync } from "node:fs";
import path from "node:path";
import {
  createDaemonGenerationWitness,
  calculateDaemonArtifactIdentity,
  createGitCanonicalPublicationInspector,
  createRepoWriteChildHost,
  decodeRepoWriteChildLaunchConfig,
  DurableRepoWriteOutcomeStoreV1,
  loadAuthorityProductionManifest,
  ProductionRepoWriteOperationHost,
  ReceiptSettlementStore,
  RepoWriteAuthorityRecoveryGate,
  RepoWriteChildIpcTransport,
  type HarnessDaemonRuntime
} from "@harness-anything/daemon";
import {
  resolveHarnessLayout
} from "@harness-anything/kernel";
import { defaultCliAdapterProvider } from "./adapter-registry.ts";
import { cliDaemonCommandHostServices } from "./daemon-command-host-services.ts";
import { makeIncrementalConflictMarkerPreflight } from "./incremental-conflict-marker-preflight.ts";
import {
  boundedRecoveryError,
  createRepoWriteChildPostReadyRecovery
} from "./repo-write-child-post-ready-recovery.ts";
import { createRepoWriteChildDocSyncExecutor } from "./repo-write-child-doc-sync-executor.ts";
import {
  createCliProductionAuthorityLifecycle
} from "./production-authority-lifecycle.ts";
import { createRepoWriteRetryBudgetSignalForwarder } from "./repo-write-retry-budget-signal-forwarder.ts";
import { makeDaemonReservationReconciler } from "@harness-anything/daemon";

type RepoWriteStartupProgressPhase = Extract<
  Parameters<RepoWriteChildIpcTransport["send"]>[0],
  { readonly kind: "startup-progress" }
>["phase"];

export async function runRepoWriteChildEntrypoint(
  encodedConfig: string | undefined
): Promise<void> {
  // The parent kills this child only when it sees no new semantic startup work
  // inside readyTimeoutMs. The independent stderr timings keep each phase's
  // actual cost diagnosable from the launch log.
  const startupPhase = makeRepoWriteChildStartupPhaseReporter();
  if (!encodedConfig) throw new Error("REPO_WRITE_CHILD_LAUNCH_CONFIG_REQUIRED");
  const config = decodeRepoWriteChildLaunchConfig(encodedConfig);
  const transport = new RepoWriteChildIpcTransport();
  const onPublicationRetryBudgetSignal = createRepoWriteRetryBudgetSignalForwarder({
    transport,
    repoId: config.repoId,
    generation: config.generation,
    formatError: boundedRecoveryError
  });
  const reportStartupProgress = async (
    phase: RepoWriteStartupProgressPhase,
    workUnit = config.repoId
  ): Promise<void> => {
    await transport.send({
      protocol: "harness-repo-write-ipc/v1",
      repoId: config.repoId,
      generation: config.generation,
      kind: "startup-progress",
      phase,
      workUnit
    });
  };
  startupPhase.mark("decode-launch-config");
  await reportStartupProgress("artifact-identity");
  const entrypointArtifactIdentity = calculateDaemonArtifactIdentity(
    process.argv[1] ?? ""
  ).identity;
  startupPhase.mark("artifact-identity");
  if (entrypointArtifactIdentity !== config.entrypointArtifactIdentity) {
    throw new Error("REPO_WRITE_CHILD_ENTRYPOINT_ARTIFACT_MISMATCH");
  }
  await reportStartupProgress("authority-manifest");
  const manifest = loadAuthorityProductionManifest(config.authorityManifest);
  const authorityRepo = manifest.repos.find((repo) =>
    repo.repoId === config.repoId
      && canonicalExistingRoot(repo.canonicalRoot) === canonicalExistingRoot(config.canonicalRoot)
  );
  if (!authorityRepo) throw new Error("REPO_WRITE_CHILD_REPO_NOT_CONFIGURED");
  startupPhase.mark("load-authority-manifest");

  const layoutOverrides = config.authoredRoot
    ? { authoredRoot: config.authoredRoot }
    : undefined;
  const conflictMarkerPreflight = makeIncrementalConflictMarkerPreflight({
    rootDir: config.canonicalRoot,
    ...(layoutOverrides ? { layoutOverrides } : {})
  });
  // Establish the generation baseline before the child advertises readiness so
  // no request pays for a full authored-tree conflict-marker scan.
  await reportStartupProgress("conflict-marker-preflight");
  conflictMarkerPreflight.read();
  startupPhase.mark("conflict-marker-preflight");
  await reportStartupProgress("runtime-create");
  const witness = createDaemonGenerationWitness({
    userRoot: config.userRoot,
    endpointIdentity: config.endpointIdentity,
    machineId: config.machineId,
    daemonGeneration: config.generation
  });
  const runtimeBox: { current?: HarnessDaemonRuntime } = {};
  const runtime = defaultCliAdapterProvider().createDaemonRuntime({
    rootDir: config.canonicalRoot,
    ...(layoutOverrides ? { layoutOverrides } : {}),
    writeOwnership: "writer",
    lockProvenance: {
      repoId: config.repoId,
      canonicalRoot: config.canonicalRoot,
      userRoot: config.userRoot,
      endpoint: config.endpointIdentity
    },
    lockTtlMs: config.runtimePolicy.write.lockTtlMs,
    interactiveMicroBatchMs:
      config.runtimePolicy.write.interactiveMicroBatchMs,
    maxInteractiveOpsPerCommit:
      config.runtimePolicy.write.maxInteractiveOpsPerCommit,
    materializerPollMs: config.runtimePolicy.materializer.pollMs,
    materializerMaxBranchesPerBatch:
      config.runtimePolicy.materializer.maxBranchesPerBatch,
    projectionReconcileIntervalMs:
      config.runtimePolicy.projection.reconcileIntervalMs,
    ...(config.admissionMaxBytes === undefined ? {} : {
      admissionMaxBytes: config.admissionMaxBytes
    }),
    generationAxes: {
      machineId: config.machineId,
      daemonGeneration: config.generation
    },
    generationWitness: witness,
    reservationReconciler: (rootInput) => {
      if (!runtimeBox.current) {
        throw new Error("REPO_WRITE_CHILD_RUNTIME_NOT_READY");
      }
      return makeDaemonReservationReconciler(rootInput, runtimeBox.current)();
    }
  });
  runtimeBox.current = runtime;
  startupPhase.mark("create-daemon-runtime");
  await reportStartupProgress("runtime-start");
  await runtime.start();
  startupPhase.mark("runtime-start");

  await reportStartupProgress("authority-lifecycle-compose");
  const outcomes = new DurableRepoWriteOutcomeStoreV1({
    directory: path.join(
      manifest.serviceStateRoot,
      "repo-write-outcomes",
      Buffer.from(config.repoId, "utf8").toString("base64url")
    ),
    repoId: config.repoId,
    workspaceId: authorityRepo.workspaceId,
    generation: config.generation
  });
  const settlements = new ReceiptSettlementStore({
    directory: path.join(
      manifest.serviceStateRoot,
      "receipt-settlements",
      Buffer.from(config.repoId, "utf8").toString("base64url")
    ),
    repoId: config.repoId,
    workspaceId: authorityRepo.workspaceId,
    generation: config.generation
  });
  const publicationInspector = createGitCanonicalPublicationInspector(
    resolveHarnessLayout({
      rootDir: config.canonicalRoot,
      ...(layoutOverrides ? { layoutOverrides } : {})
    }).authoredRoot,
    { onRetryBudgetSignal: onPublicationRetryBudgetSignal }
  );
  const resolveHistoricalPublication = (
    outcome: import("@harness-anything/daemon").RepoWriteProceedingOutcomeV1
  ) => publicationInspector.findHistoricalPublicationForOperation(outcome.innerOpId);
  const historicalRecovery: {
    recover?: import("@harness-anything/daemon").RepoWriteAuthorityRecoveryGateOptions["recoverHistoricalCommittedReceipt"];
  } = {};
  const recoveryGate = new RepoWriteAuthorityRecoveryGate({
    repoId: config.repoId,
    workspaceId: authorityRepo.workspaceId,
    generation: config.generation,
    store: outcomes,
    assertCurrentWriterFence: runtime.assertWriteFenceHeld,
    resolveHistoricalPublication,
    recoverHistoricalCommittedReceipt: (outcome) => {
      if (!historicalRecovery.recover) {
        throw new Error("AUTHORITY_COMMITTED_RECEIPT_RECOVERY_UNAVAILABLE");
      }
      return historicalRecovery.recover(outcome);
    }
  });
  const lifecycleRuntime = {
    ...runtime,
    runAuthorizedRepoWriteRecoveryPlan:
      recoveryGate.runPlannedRecovery.bind(recoveryGate),
    runAuthorizedRepoWriteRecoveryAttempt:
      recoveryGate.runAttemptRecovery.bind(recoveryGate)
  };
  const recoveryStartGate = createPostReadyRecoveryStartGate();
  const authorityLifecycle = createCliProductionAuthorityLifecycle({
    manifestPath: config.authorityManifest,
    ...(layoutOverrides ? { layoutOverrides } : {}),
    onPublicationRetryBudgetSignal,
    onServiceStateReplayProgress: (progressRepo, progress) => {
      void reportStartupProgress(
        "authority-start-repo",
        [
          progressRepo.repoId,
          "authority-state",
          progress.fileName,
          String(progress.replayedRows)
        ].join(":")
      ).catch((error) => {
        process.stderr.write(
          `[repo-write-child] authority state replay progress deferred: ${boundedRecoveryError(error)}\n`
        );
      });
    },
    onRecoveryProgress: (repoId, progress) => {
      try {
        process.stderr.write(`${JSON.stringify({
          schema: "repo-write-child-authority-recovery/v1",
          pid: process.pid,
          repoId,
          generation: config.generation,
          phase: "first-parent-scan",
          workUnit: progress.commitSha,
          scannedCommitCount: progress.scannedCommitCount,
          deadlineAt: progress.deadlineAt
        })}\n`);
      } catch {
        // Recovery diagnostics must never alter durable recovery semantics.
      }
    },
    backgroundRecovery: true,
    waitForBackgroundRecoveryStart: recoveryStartGate.wait
  });
  const repo = {
    repoId: config.repoId,
    canonicalRoot: config.canonicalRoot
  };
  startupPhase.mark("compose-authority-lifecycle");
  await reportStartupProgress("authority-start-repo");
  const started = await authorityLifecycle.startRepo(repo, lifecycleRuntime);
  startupPhase.mark("authority-start-repo");
  if (!started.ok) {
    await runtime.stop();
    throw new Error(started.error);
  }
  const recoverAuthorityCommittedReceipt = (opId: string) => {
    if (!started.component.recoverCommittedReceipt) {
      throw new Error("AUTHORITY_COMMITTED_RECEIPT_RECOVERY_UNAVAILABLE");
    }
    return started.component.recoverCommittedReceipt(opId);
  };
  historicalRecovery.recover = (outcome) =>
    recoverAuthorityCommittedReceipt(outcome.innerOpId);
  const authoredRoot = resolveHarnessLayout({
    rootDir: config.canonicalRoot,
    ...(layoutOverrides ? { layoutOverrides } : {})
  }).authoredRoot;
  const canonicalPublicationRecovery: {
    current?: (input: {
      readonly outerOpId: string;
      readonly canonicalCommitSha: string;
    }) => Promise<"live-owner" | "recovered" | "terminal" | "blocked">;
  } = {};
  const postReadyRecovery = createRepoWriteChildPostReadyRecovery({
    repoId: config.repoId,
    generation: config.generation,
    transport,
    settlements,
    outcomes,
    runtime,
    authoredRoot,
    recoveryGate,
    recoverCommittedReceipt: recoverAuthorityCommittedReceipt,
    recoverCanonicalPublication: (recovery) => canonicalPublicationRecovery.current
      ? canonicalPublicationRecovery.current(recovery)
      : Promise.resolve("blocked")
  });
  const recoverSettlements = postReadyRecovery.recoverSettlements;
  await reportStartupProgress("child-host-start");
  const operation = new ProductionRepoWriteOperationHost({
    repoId: config.repoId,
    workspaceId: authorityRepo.workspaceId,
    generation: config.generation,
    runtime,
    authorityComponent: started.component,
    hostServices: cliDaemonCommandHostServices,
    outcomeStore: outcomes,
    settlementStore: settlements,
    resolveHistoricalPublication,
    recoverHistoricalCommittedReceipt: historicalRecovery.recover,
    conflictMarkerPreflight: conflictMarkerPreflight.read,
    recoverSettlements,
    executeDocSyncSubmit: createRepoWriteChildDocSyncExecutor({
      canonicalRoot: config.canonicalRoot,
      ...(layoutOverrides ? { layoutOverrides } : {}),
      runtime
    })
  });
  canonicalPublicationRecovery.current = (recovery) =>
    operation.recoverCanonicalPublicationSettlement(recovery);
  let initialRecovery: Promise<void> | undefined;
  const startInitialRecovery = (): void => {
    initialRecovery ??= recoveryStartGate.wait().then(
      () => postReadyRecovery.runInitialSweep()
    ).catch(async (error) => {
      const diagnostic = boundedRecoveryError(error);
      process.stderr.write(
        `[repo-write-child] post-READY recovery deferred: ${diagnostic}\n`
      );
      await transport.send({
        protocol: "harness-repo-write-ipc/v1",
        repoId: config.repoId,
        generation: config.generation,
        kind: "recovery-deferred",
        outerOpId: `post-ready-recovery:${config.repoId}`,
        code: "POST_READY_RECOVERY_DEFERRED",
        diagnostic
      }).catch(() => undefined);
    });
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      await initialRecovery;
      await operation.settlementIdle();
      await authorityLifecycle.stopRepo(repo, "daemon-shutdown");
      await runtime.stop();
    })();
    return cleanupPromise;
  };
  const childHost = createRepoWriteChildHost({
    repoId: config.repoId,
    workspaceId: authorityRepo.workspaceId,
    generation: config.generation,
    artifactIdentity: entrypointArtifactIdentity,
    transport,
    hooks: {
      prepare: (input) => operation.prepare(input),
      direct: (input) => operation.direct(input),
      lookup: (input) => operation.lookup(input),
      shutdown: cleanup
    }
  });

  await new Promise<void>((resolve, reject) => {
    transport.onMessage((message) => {
      void childHost.receive(message).catch(async (error: unknown) => {
        await cleanup().catch(() => undefined);
        reject(error);
      });
    });
    transport.onDisconnect(() => {
      void cleanup().then(resolve, reject);
    });
    void childHost.start().then(() => {
      startupPhase.mark("child-host-start-ready");
      startupPhase.reportTotal();
      recoveryStartGate.ready();
      startInitialRecovery();
    }).catch(async (error: unknown) => {
      await cleanup().catch(() => undefined);
      reject(error);
    });
  });
}

interface PostReadyRecoveryStartGate {
  readonly ready: () => void;
  readonly wait: () => Promise<void>;
}

const postReadyRecoveryDelayMs = 10_000;

function createPostReadyRecoveryStartGate(): PostReadyRecoveryStartGate {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const start = ready.then(() => new Promise<void>((resolve) => {
    setTimeout(resolve, postReadyRecoveryDelayMs);
  }));
  return {
    ready: markReady,
    wait: () => start
  };
}

interface RepoWriteChildStartupPhaseReporter {
  readonly mark: (phase: string, detail?: Record<string, number>) => void;
  readonly reportTotal: () => void;
}

/**
 * Emits one NDJSON frame per pre-READY phase on stderr. The daemon launcher
 * already persists child stderr beside the READY-timeout stack, so a timeout
 * carries its own phase breakdown instead of requiring a live reproduction.
 */
function makeRepoWriteChildStartupPhaseReporter(): RepoWriteChildStartupPhaseReporter {
  const startedAt = performance.now();
  let previous = startedAt;
  const emit = (frame: Record<string, unknown>) => {
    try {
      process.stderr.write(`${JSON.stringify({
        schema: "repo-write-child-startup-phase/v1",
        pid: process.pid,
        ...frame
      })}\n`);
    } catch {
      // Startup diagnostics must never take the writer child down.
    }
  };
  return {
    mark: (phase, detail) => {
      const at = performance.now();
      emit({
        phase,
        phaseMs: Math.round(at - previous),
        sinceEntrypointMs: Math.round(at - startedAt),
        ...(detail ?? {})
      });
      previous = at;
    },
    reportTotal: () => emit({
      phase: "ready",
      sinceEntrypointMs: Math.round(performance.now() - startedAt)
    })
  };
}

function canonicalExistingRoot(rootDir: string): string {
  return realpathSync.native(path.resolve(rootDir));
}
