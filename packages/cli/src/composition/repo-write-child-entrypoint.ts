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
  type HarnessDaemonRuntime
} from "@harness-anything/daemon";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { defaultCliAdapterProvider } from "./adapter-registry.ts";
import { cliDaemonCommandHostServices } from "./daemon-command-host-services.ts";
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
      && path.resolve(repo.canonicalRoot) === path.resolve(config.canonicalRoot)
  );
  if (!authorityRepo) throw new Error("REPO_WRITE_CHILD_REPO_NOT_CONFIGURED");

  const layoutOverrides = config.authoredRoot
    ? { authoredRoot: config.authoredRoot }
    : undefined;
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
      await recoveryGate.recoverHistoricalProceeding(proceeding);
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
    recoverHistoricalCommittedReceipt: historicalRecovery.recover
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
