import path from "node:path";
import {
  createDaemonGenerationWitness,
  createRepoWriteChildHost,
  decodeRepoWriteChildLaunchConfig,
  DurableRepoWriteOutcomeStoreV1,
  loadAuthorityProductionManifest,
  ProductionProgressAppendOperationHost,
  RepoWriteAuthorityRecoveryGate,
  RepoWriteChildIpcTransport,
  type HarnessDaemonRuntime
} from "@harness-anything/daemon";
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
  const recoveryGate = new RepoWriteAuthorityRecoveryGate({
    repoId: config.repoId,
    workspaceId: authorityRepo.workspaceId,
    generation: config.generation,
    store: outcomes,
    assertCurrentWriterFence: runtime.assertWriteFenceHeld
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
  const operation = new ProductionProgressAppendOperationHost({
    repoId: config.repoId,
    workspaceId: authorityRepo.workspaceId,
    generation: config.generation,
    runtime,
    authorityComponent: started.component,
    hostServices: cliDaemonCommandHostServices,
    outcomeStore: outcomes
  });
  const transport = new RepoWriteChildIpcTransport();
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
    transport,
    hooks: {
      prepare: (input) => operation.prepare(input),
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
