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
  RepoWriteAuthorityRecoveryGate,
  RepoWriteChildIpcTransport,
  failureReceipt,
  makeDaemonQueuedWriteCoordinator,
  makeDocSyncService,
  materializeDocSyncWriterWorkingTree,
  successReceipt,
  type HarnessDaemonRuntime
} from "@harness-anything/daemon";
import type {
  DocSyncSubmitRequestV1,
  DocSyncSubmitResultV1
} from "@harness-anything/application";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { defaultCliAdapterProvider } from "./adapter-registry.ts";
import { cliDaemonCommandHostServices } from "./daemon-command-host-services.ts";
import { cliDaemonServiceHostServices } from "./daemon-service-host-services.ts";
import { daemonActorAttribution } from "./actor-attribution.ts";
import { makeIncrementalConflictMarkerPreflight } from "./incremental-conflict-marker-preflight.ts";
import {
  createCliProductionAuthorityLifecycle
} from "./production-authority-lifecycle.ts";
import { makeDaemonReservationReconciler } from "@harness-anything/daemon";

export async function runRepoWriteChildEntrypoint(
  encodedConfig: string | undefined
): Promise<void> {
  if (!encodedConfig) throw new Error("REPO_WRITE_CHILD_LAUNCH_CONFIG_REQUIRED");
  const config = decodeRepoWriteChildLaunchConfig(encodedConfig);
  const entrypointArtifactIdentity = calculateDaemonArtifactIdentity(
    process.argv[1] ?? ""
  ).identity;
  if (entrypointArtifactIdentity !== config.entrypointArtifactIdentity) {
    throw new Error("REPO_WRITE_CHILD_ENTRYPOINT_ARTIFACT_MISMATCH");
  }
  const manifest = loadAuthorityProductionManifest(config.authorityManifest);
  const authorityRepo = manifest.repos.find((repo) =>
    repo.repoId === config.repoId
      && canonicalExistingRoot(repo.canonicalRoot) === canonicalExistingRoot(config.canonicalRoot)
  );
  if (!authorityRepo) throw new Error("REPO_WRITE_CHILD_REPO_NOT_CONFIGURED");

  const layoutOverrides = config.authoredRoot
    ? { authoredRoot: config.authoredRoot }
    : undefined;
  const conflictMarkerPreflight = makeIncrementalConflictMarkerPreflight({
    rootDir: config.canonicalRoot,
    ...(layoutOverrides ? { layoutOverrides } : {})
  });
  // Establish the generation baseline before the child advertises readiness so
  // no request pays for a full authored-tree conflict-marker scan.
  conflictMarkerPreflight.read();
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
  await runtime.start();

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
  const publicationInspector = createGitCanonicalPublicationInspector(
    resolveHarnessLayout({
      rootDir: config.canonicalRoot,
      ...(layoutOverrides ? { layoutOverrides } : {})
    }).authoredRoot
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
    backgroundRecovery: true
  });
  const repo = {
    repoId: config.repoId,
    canonicalRoot: config.canonicalRoot
  };
  const started = await authorityLifecycle.startRepo(repo, lifecycleRuntime);
  if (!started.ok) {
    await runtime.stop();
    throw new Error(started.error);
  }
  historicalRecovery.recover = (outcome) => {
    if (!started.component.recoverCommittedReceipt) {
      throw new Error("AUTHORITY_COMMITTED_RECEIPT_RECOVERY_UNAVAILABLE");
    }
    return started.component.recoverCommittedReceipt(outcome.innerOpId);
  };
  const transport = new RepoWriteChildIpcTransport();
  for (const proceeding of outcomes.listHistoricalProceedings()) {
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
  }
  const operation = new ProductionRepoWriteOperationHost({
    repoId: config.repoId,
    workspaceId: authorityRepo.workspaceId,
    generation: config.generation,
    runtime,
    authorityComponent: started.component,
    hostServices: cliDaemonCommandHostServices,
    outcomeStore: outcomes,
    resolveHistoricalPublication,
    recoverHistoricalCommittedReceipt: historicalRecovery.recover,
    conflictMarkerPreflight: conflictMarkerPreflight.read,
    executeDocSyncSubmit: async ({ command, decoded }) => {
      const wireCommand = command.payload.command as {
        readonly request?: DocSyncSubmitRequestV1;
      };
      if (!wireCommand.request) {
        return failureReceipt(
          "repo.doc.sync.submit",
          "doc_sync_invalid_payload",
          "The writer child received no doc-sync request."
        );
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
        return failureReceipt(
          "repo.doc.sync.submit",
          result.code,
          result.reason,
          { data: result as unknown as import("@harness-anything/daemon").JsonObject }
        );
      }
      const attribution = daemonActorAttribution(decoded.actor, decoded.executor);
      const result = await makeDocSyncService({
        rootDir: config.canonicalRoot,
        ...(layoutOverrides ? { layoutOverrides } : {}),
        hostServices: cliDaemonServiceHostServices.docSync,
        coordinator: makeDaemonQueuedWriteCoordinator(
          runtime,
          `doc-sync-submit:${wireCommand.request.payload.intentId}`,
          {
            attribution: attribution.writeAttribution,
            commitAuthor: attribution.commitAuthor,
            ...(wireCommand.request.session?.sessionId
              ? { sessionId: wireCommand.request.session.sessionId }
              : {})
          }
        )
      }).submit(materialized.request);
      return result.ok
        ? successReceipt("repo.doc.sync.submit", "completed repo.doc.sync.submit", result as unknown as import("@harness-anything/daemon").JsonObject)
        : failureReceipt("repo.doc.sync.submit", result.code, result.reason, {
          data: result as unknown as import("@harness-anything/daemon").JsonObject
        });
    }
  });
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
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
    void childHost.start().catch(async (error: unknown) => {
      await cleanup().catch(() => undefined);
      reject(error);
    });
  });
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
