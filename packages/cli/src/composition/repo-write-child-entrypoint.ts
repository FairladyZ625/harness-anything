import { realpathSync } from "node:fs";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { Effect } from "effect";
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
  failureReceipt,
  makeDaemonQueuedWriteCoordinator,
  makeDocSyncService,
  materializeDocSyncWriterWorkingTree,
  type HarnessDaemonRuntime
} from "@harness-anything/daemon";
import type {
  DocSyncSubmitRequestV1,
  DocSyncSubmitResultV1
} from "@harness-anything/application";
import {
  resolveHarnessLayout,
  type FlushReport,
  type RetryBudgetSignal,
  type WriteCoordinator
} from "@harness-anything/kernel";
import { defaultCliAdapterProvider } from "./adapter-registry.ts";
import { cliDaemonCommandHostServices } from "./daemon-command-host-services.ts";
import { cliDaemonServiceHostServices } from "./daemon-service-host-services.ts";
import { daemonActorAttribution } from "./actor-attribution.ts";
import { makeIncrementalConflictMarkerPreflight } from "./incremental-conflict-marker-preflight.ts";
import {
  reconcileTerminalSettlements,
  canonicalCommitContaining,
  createReceiptSettlementRecoveryLoop,
  recoverPendingSettlementMaterialization,
} from "./receipt-settlement-runtime.ts";
import { buildDocSyncCommandReceipt } from "./doc-sync-command-receipt.ts";
import {
  createCliProductionAuthorityLifecycle
} from "./production-authority-lifecycle.ts";
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
  const onPublicationRetryBudgetSignal = (signal: RetryBudgetSignal): void => {
    const deliveryFailure = (error: unknown): void => {
      process.emitWarning(
        `Repo-write child could not forward publication retry-budget visibility to the parent daemon: ${boundedRecoveryError(error)}`,
        { code: "REPO_WRITE_RETRY_BUDGET_SIGNAL_DELIVERY_FAILED" }
      );
    };
    try {
      void transport.send({
        protocol: "harness-repo-write-ipc/v1",
        repoId: config.repoId,
        generation: config.generation,
        kind: "retry-budget-signal",
        phase: signal.phase,
        operation: signal.event.operation,
        cause: boundedRecoveryError(signal.event.cause),
        failures: signal.event.failures,
        retriesUsed: signal.event.retriesUsed,
        elapsedMs: signal.event.elapsedMs,
        ...(signal.event.remainingMs === undefined ? {} : {
          remainingMs: signal.event.remainingMs
        })
      }).catch(deliveryFailure);
    } catch (error) {
      deliveryFailure(error);
    }
  };
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
  const recoverSettlements = async (budgetMs = 5_000) => {
    await recoverPendingSettlementMaterialization({
      settlements,
      outcomes,
      runtime,
      authoredRoot,
      deadlineAt: Date.now() + budgetMs,
      recoverCommittedReceipt: recoverAuthorityCommittedReceipt
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
    executeDocSyncSubmit: async ({ command, decoded }) => {
      const wireCommand = command.payload.command as {
        readonly request?: DocSyncSubmitRequestV1;
      };
      if (!wireCommand.request) {
        return { receipt: failureReceipt(
          "repo.doc.sync.submit",
          "doc_sync_invalid_payload",
          "The writer child received no doc-sync request."
        ) };
      }
      const materialized = materializeDocSyncWriterWorkingTree(
        {
          rootDir: config.canonicalRoot,
          ...(layoutOverrides ? { layoutOverrides } : {})
        },
        wireCommand.request
      );
      if (!materialized.ok) {
        const result: DocSyncSubmitResultV1 = {
          ok: false,
          _tag: "WriteRejected",
          schema: "daemon.doc-sync-submit-result/v1",
          status: "rejected",
          intentId: wireCommand.request.payload.intentId,
          code: "doc_sync_invalid_payload",
          reason: `The writer child rejected a working-tree reference: ${materialized.reason}`,
          retryable: false
        };
        return { receipt: failureReceipt(
          "repo.doc.sync.submit",
          result.code,
          result.reason,
          { data: result as unknown as import("@harness-anything/daemon").JsonObject }
        ) };
      }
      const attribution = daemonActorAttribution(decoded.actor, decoded.executor);
      const queued = makeDaemonQueuedWriteCoordinator(
        runtime,
        `doc-sync-submit:${wireCommand.request.payload.intentId}`,
        {
          attribution: attribution.writeAttribution,
          commitAuthor: attribution.commitAuthor,
          ...(wireCommand.request.session?.sessionId
            ? { sessionId: wireCommand.request.session.sessionId }
            : {})
        }
      );
      let durableFlush: FlushReport | undefined;
      const coordinator: WriteCoordinator = {
        enqueue: queued.enqueue,
        flush: (reason) => Effect.tap(queued.flush(reason), (flush) => Effect.sync(() => {
          durableFlush = flush;
        })),
        recover: queued.recover
      };
      const result = await makeDocSyncService({
        rootDir: config.canonicalRoot,
        ...(layoutOverrides ? { layoutOverrides } : {}),
        hostServices: cliDaemonServiceHostServices.docSync,
        coordinator
      }).submit(materialized.request);
      if (result.ok) {
        const receipt = buildDocSyncCommandReceipt({
          result,
          sessionId: decoded.currentSession.sessionId,
          acceptedAt: new Date().toISOString(),
          includeSettlement: false
        });
        if (result.appliedChanges.length === 0) {
          return { receipt, terminalCommitSha: result.appliedLedgerSha };
        }
        if (!durableFlush?.committed || !durableFlush.watermark) {
          throw new Error("DOC_SYNC_DURABLE_FLUSH_PROOF_MISSING");
        }
        const authoredRoot = resolveHarnessLayout({
          rootDir: config.canonicalRoot,
          ...(layoutOverrides ? { layoutOverrides } : {})
        }).authoredRoot;
        return {
          receipt,
          durable: {
            sessionId: decoded.currentSession.sessionId,
            acceptedCommitSha: result.appliedLedgerSha,
            flush: { ...durableFlush, committed: true, watermark: durableFlush.watermark },
            settle: async () => {
              await nextEventLoopTurn();
              await runtime.enqueueMaterializerBatch({ sessionId: decoded.currentSession.sessionId });
              return canonicalCommitContaining(authoredRoot, result.appliedLedgerSha);
            }
          }
        };
      }
      return { receipt: failureReceipt("repo.doc.sync.submit", result.code, result.reason, {
          data: result as unknown as import("@harness-anything/daemon").JsonObject
        }) };
    }
  });
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
