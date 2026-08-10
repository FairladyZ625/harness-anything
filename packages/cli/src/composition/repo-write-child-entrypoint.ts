import { realpathSync } from "node:fs";
import path from "node:path";
import {
  createDaemonGenerationWitness,
  calculateDaemonArtifactIdentity,
  createGitCanonicalPublicationInspector,
  createRepoWriteChildHost,
  decodeRepoWriteChildLaunchConfig,
  defaultProductionRecoveryAdmissionTimeoutMs,
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
  reconcileTerminalSettlements,
  createReceiptSettlementRecoveryLoop,
  recoverPendingSettlementMaterialization,
} from "./receipt-settlement-runtime.ts";
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

/**
 * Historical recovery keeps its existing admission budget, which is strictly
 * smaller than the parent's startup-stall window. The parent now renews that
 * window only when it sees a previously unseen startup phase/work-unit pair;
 * this budget remains an admission boundary, not the liveness signal.
 *
 * Reuses the authority admission deadline rather than restating it: both exist
 * to return before the same parent transport deadline so the supervisor leaves a
 * recovering child alive. One deadline, one constant.
 */
const startupReadyBudgetMs = defaultProductionRecoveryAdmissionTimeoutMs;

/** Time this child may still spend on historical recovery before announcing READY. */
function remainingStartupRecoveryBudgetMs(): number {
  return Math.max(0, startupReadyBudgetMs - Math.round(process.uptime() * 1000));
}

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
  const authorityLifecycle = createCliProductionAuthorityLifecycle({
    manifestPath: config.authorityManifest,
    ...(layoutOverrides ? { layoutOverrides } : {}),
    onPublicationRetryBudgetSignal,
    backgroundRecovery: true
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
  const recoverSettlements = async (budgetMs = 5_000) => {
    await recoverPendingSettlementMaterialization({
      settlements,
      outcomes,
      runtime,
      authoredRoot,
      deadlineAt: Date.now() + budgetMs,
      recoverCommittedReceipt: recoverAuthorityCommittedReceipt,
      recoverCanonicalPublication: (input) => canonicalPublicationRecovery.current
        ? canonicalPublicationRecovery.current(input)
        : Promise.resolve("blocked")
    });
    reconcileTerminalSettlements(settlements, outcomes);
  };
  await recoverSettlements(remainingStartupRecoveryBudgetMs());
  const startupRecoveryBudgetMs = remainingStartupRecoveryBudgetMs();
  const startupRecoveryDeadline = Date.now() + startupRecoveryBudgetMs;
  await reportStartupProgress("historical-recovery-scan");
  const historicalProceedings = outcomes.listHistoricalProceedings();
  startupPhase.mark("list-historical-proceedings", {
    proceedingCount: historicalProceedings.length
  });
  let proceedingsLeftByBudget = 0;
  let recoveredProceedings = 0;
  for (const proceeding of historicalProceedings) {
    if (Date.now() >= startupRecoveryDeadline) {
      proceedingsLeftByBudget += 1;
      continue;
    }
    await reportStartupProgress("historical-recovery", proceeding.outerOpId);
    const proceedingStartedAt = startupPhase.now();
    try {
      const recovery = await recoveryGate.recoverHistoricalProceeding(proceeding);
      if (recovery.disposition === "permanently-rejected") {
        await transport.send({
          protocol: "harness-repo-write-ipc/v1",
          repoId: config.repoId,
          generation: config.generation,
          kind: "recovery-rejected",
          outerOpId: proceeding.outerOpId,
          code: recovery.code,
          diagnostic:
            "Historical recovery evidence permanently conflicts with the canonical publication. "
            + "The outer operation remains outcome-unknown; no authority terminal proof was created.",
          next:
            "Run `ha daemon logs --errors --json`, then escalate this outer op for "
            + "operator-reviewed canonical Git and authority-state repair. "
            + "Do not delete WAL, outcome, or recovery files."
        });
      }
    } catch (error) {
      await transport.send({
        protocol: "harness-repo-write-ipc/v1",
        repoId: config.repoId,
        generation: config.generation,
        kind: "recovery-deferred",
        outerOpId: proceeding.outerOpId,
        code: recoveryErrorCode(error),
        diagnostic: boundedRecoveryError(error)
      });
    }
    recoveredProceedings += 1;
    startupPhase.observeProceeding(proceedingStartedAt);
  }
  startupPhase.mark("historical-recovery-loop", {
    proceedingCount: recoveredProceedings,
    slowestProceedingMs: startupPhase.slowestProceedingMs(),
    budgetMs: startupRecoveryBudgetMs,
    leftByBudget: proceedingsLeftByBudget
  });
  if (proceedingsLeftByBudget > 0) {
    process.stderr.write(
      `[repo-write-child] repo=${config.repoId} left ${proceedingsLeftByBudget} historical `
      + `proceeding(s) unrecovered after spending the ${startupRecoveryBudgetMs}ms still left `
      + `of the ${startupReadyBudgetMs}ms startup budget; they remain proceeding and are `
      + "retried on the next start\n"
    );
  }
  reconcileTerminalSettlements(settlements, outcomes);
  await reportStartupProgress("child-host-start");
  let settlementRecoveryLoop: ReturnType<typeof createReceiptSettlementRecoveryLoop> | undefined;
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
  canonicalPublicationRecovery.current = (input) =>
    operation.recoverCanonicalPublicationSettlement(input);
  await recoverSettlements(remainingStartupRecoveryBudgetMs());
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      settlementRecoveryLoop?.stop();
      await operation.settlementIdle();
      await authorityLifecycle.stopRepo(repo, "daemon-shutdown");
      await runtime!.stop();
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
      settlementRecoveryLoop = createReceiptSettlementRecoveryLoop({
        intervalMs: 1_000,
        recover: recoverSettlements,
        onError: (error) => process.stderr.write(
          `[repo-write-child] receipt settlement recovery deferred: ${boundedRecoveryError(error)}\n`
        )
      });
      startupPhase.mark("child-host-start-ready");
      startupPhase.reportTotal();
    }).catch(async (error: unknown) => {
      await cleanup().catch(() => undefined);
      reject(error);
    });
  });
}

interface RepoWriteChildStartupPhaseReporter {
  readonly now: () => number;
  readonly mark: (phase: string, detail?: Record<string, number>) => void;
  readonly observeProceeding: (startedAt: number) => void;
  readonly slowestProceedingMs: () => number;
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
  let slowestProceedingMs = 0;
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
    now: () => performance.now(),
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
    observeProceeding: (proceedingStartedAt) => {
      slowestProceedingMs = Math.max(
        slowestProceedingMs,
        Math.round(performance.now() - proceedingStartedAt)
      );
    },
    slowestProceedingMs: () => slowestProceedingMs,
    reportTotal: () => emit({
      phase: "ready",
      sinceEntrypointMs: Math.round(performance.now() - startedAt)
    })
  };
}

function canonicalExistingRoot(rootDir: string): string {
  return realpathSync.native(path.resolve(rootDir));
}

function recoveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error
    && typeof error.code === "string" && error.code.trim()) {
    return error.code;
  }
  const message = recoveryErrorMessage(error);
  const match = /^([A-Z][A-Z0-9_]+)(?::|$)/u.exec(message);
  return match?.[1] ?? "HISTORICAL_RECOVERY_DEFERRED";
}

function boundedRecoveryError(error: unknown): string {
  const value = `${error instanceof Error ? `${error.name}: ` : ""}${recoveryErrorMessage(error)}`
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim();
  const bytes = Buffer.from(value || "Historical recovery deferred.", "utf8");
  if (bytes.length <= 2_048) return bytes.toString("utf8");
  return bytes.subarray(0, 2_048).toString("utf8").replace(/\uFFFD$/u, "");
}
