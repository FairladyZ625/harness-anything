// @slice-activation PLT-Boundary W2 exports the daemon-owned production authority lifecycle to CLI host composition.
import {
  createAuthorityCutoverEntityRegistryQualification,
  createAuthorityCutoverControlService,
  createDurableAuthorityCommittedEventPublisherV2,
  type AuthorityPublicationExecutionContext,
  type AuthoritySubmissionV2Options,
  type AuthoritySubmissionService,
  type DaemonLogService,
  type ProductionAuthorityHostServices,
  type ReplicaChangeLog,
} from "@harness-anything/application";
import { createAuthoritySubmissionService } from "@harness-anything/application/authority/service";
import type { PersonRegistry } from "../../identity/types.ts";
import {
  createProductionCompoundReceiptComposition,
  createProductionCompoundReceiptGenerationFence
} from "../../lifecycle/compound-receipt-composition.ts";
import {
  createRuntimeDaemonGenerationAuthorityFence,
  createRuntimeDaemonGenerationWitnessFence,
  daemonGenerationAxes
} from "../../fence/daemon-generation-fence.ts";
import type { AuthorityConnectionContext } from "../../protocol/connection-context.ts";
import {
  createDaemonAuthorityCommandSubmissionV2,
  gateAuthoritySubmissionForRecovery
} from "../authority-command-submission.ts";
import {
  createAuthorityRepoLifecycleController,
  type AuthorityRepoComponent,
  type AuthorityRepoConnectionBinding,
  type AuthorityRepoLifecycleController,
  type AuthorityRepoLifecycleHooks
} from "../authority-lifecycle.ts";
import { serveAuthorityForcedCommand } from "../forced-command-session.ts";
import { createAuthorityReadDownService } from "../read-down-service.ts";
import {
  type AuthorityReplicationContentStore
} from "../replication-content-store.ts";
import { createPrewarmedAuthorityReplication } from "../replication-content-prewarm.ts";
import { gateCutoverAdmission } from "./cutover-admission.ts";
import { createDurableSuccessorPublicationObserver } from "./durable-successor-publication-observer.ts";
import {
  assertPublicationMatchesMutationSet,
  createGitAuthorityAttributionEvidenceCommitterV2,
  createGitCanonicalPublicationInspector
} from "./publication-evidence.ts";
import { createAuthorityProductionScanner } from "./production-scanner.ts";
import {
  recoverPendingProductionEvents,
  recoveryErrorCode,
  recoveryErrorSummary
} from "./recovery.ts";
import {
  entityRegistry,
  entityRegistryKinds,
  makeLocalAuthorityAttributionEventV2Log,
  resolveHarnessLayout,
  type EntityRegistration
} from "@harness-anything/kernel";
import {
  createDurableAuthorityBindingRuntimeV2,
  createDurableOperationNamespaceVerifierV2,
  loadAuthorityProductionManifest,
  openAuthorityProductionKeyMaterial,
  type AuthorityProductionRepoConfigV1,
  type DurableAuthorityBindingRuntimeV2
} from "./authority-production-state.ts";
import { reportCurrentRepoWriteTelemetry } from "../../runtime/repo-write-telemetry-context.ts";
import { withProductionRecoveryV2 } from "./authority-attribution-event-v2-production-recovery.ts";
import { createProductionProgressAppendConnectionBinding } from "./production-progress-append-submission.ts";
import { createProductionAuthoritySemanticCompiler } from "./production-authority-semantic-compiler.ts";
import { connectionBoundRuntime } from "./connection-bound-runtime.ts";
import { waitForProductionRecovery } from "./production-recovery-admission.ts";
import { attestSubmissionService } from "./transport-attested-submission-service.ts";
import { recoverProductionCommittedReceipt } from "./production-committed-receipt-recovery.ts";
import type { RetryBudgetSignal } from "../../observability/visible-retry-budget.ts";
import { settleProductionRecovery, type ProductionRecoveryState } from "./production-recovery-state.ts";
import { productionPublicationRetryOptions } from "./production-publication-retry-options.ts";
import { createSerialPublicationExecutor } from "./serial-publication-executor.ts";
import {
  authorityManifestSourceDigest,
  canonicalProductionAuthorityRoot
} from "./production-authority-manifest-identity.ts";
export { createSerialPublicationExecutor } from "./serial-publication-executor.ts";
export { recoverPendingProductionEvents } from "./recovery.ts";

interface RepoProductionMaterial {
  readonly config: AuthorityProductionRepoConfigV1;
  readonly keyStore: ReturnType<typeof openAuthorityProductionKeyMaterial>["keyStore"];
  readonly keyRegistry: ReturnType<typeof openAuthorityProductionKeyMaterial>["registry"];
  readonly bindingRuntime: DurableAuthorityBindingRuntimeV2;
  readonly authoredRoot: string;
  readonly configurationDigest: string;
  readonly serviceStateRoot: string;
  readonly replicationState: Parameters<typeof createPrewarmedAuthorityReplication>[0]["state"];
  readonly replicationContent: AuthorityReplicationContentStore;
  readonly replicaChangeLog: ReplicaChangeLog;
  readonly daemonLogService?: DaemonLogService;
  readonly onPublicationRetryBudgetSignal?: (signal: RetryBudgetSignal) => void;
  readonly recovery: ProductionRecoveryState;
}

const productionAuthorityV2EntityKinds = [
  "task", "decision", "module", "fact", "relation", "session", "execution", "review", "consent"
] as const;

interface ProductionAuthorityIdentity {
  readonly personRegistry?: PersonRegistry;
}

export function createProductionAuthorityLifecycle(input: {
  readonly manifestPath: string;
  readonly userRoot?: string;
  readonly layoutOverrides?: { readonly authoredRoot?: string };
  readonly daemonLogService?: DaemonLogService;
  readonly onPublicationRetryBudgetSignal?: (signal: RetryBudgetSignal) => void;
  readonly onServiceStateReplayProgress?: Parameters<
    typeof createAuthorityRepoLifecycleController
  >[0]["onServiceStateReplayProgress"];
  readonly backgroundRecovery?: true;
  readonly hostServices: ProductionAuthorityHostServices<ProductionAuthorityIdentity>;
}): AuthorityRepoLifecycleController {
  const manifest = loadAuthorityProductionManifest(input.manifestPath);
  const materials = new Map<string, RepoProductionMaterial>();
  const publicationObservers = new Map<string, Parameters<AuthorityRepoLifecycleHooks["start"]>[0]["inspectPublication"]>();
  const hooks = createProductionAuthorityRepoLifecycleHooks({ materials });
  const controller = createAuthorityRepoLifecycleController({
    hooks,
    serviceStateRoot: manifest.serviceStateRoot,
    ...(input.onServiceStateReplayProgress ? {
      onServiceStateReplayProgress: input.onServiceStateReplayProgress
    } : {}),
    resolvePublicationInspectorOptions: (repo) => {
      const config = manifest.repos.find((candidate) => candidate.repoId === repo.repoId);
      return config ? productionPublicationRetryOptions(input, config) : {};
    },
    resolveCompositionData: async (repo, state, runtime) => {
      const config = manifest.repos.find((candidate) => candidate.repoId === repo.repoId);
      if (!config
        || canonicalProductionAuthorityRoot(config.canonicalRoot)
          !== canonicalProductionAuthorityRoot(repo.canonicalRoot)) {
        throw new Error("AUTHORITY_PRODUCTION_REPO_NOT_CONFIGURED");
      }
      const identity = input.hostServices.loadDaemonIdentity(
        repo.canonicalRoot,
        input.layoutOverrides,
        undefined,
        input.userRoot
      );
      if (!identity.personRegistry) throw new Error("AUTHORITY_PRODUCTION_PERSON_REGISTRY_REQUIRED");
      const keyMaterial = openAuthorityProductionKeyMaterial({ config, serviceStateRoot: manifest.serviceStateRoot });
      const proofKeys = {
        resolve: (header: Parameters<ReturnType<typeof keyMaterial.keyStore.proofKeyResolver>["resolve"]>[0]) =>
          keyMaterial.keyStore.proofKeyResolver(keyMaterial.registry, Date.now()).resolve(header)
      };
      const bindingRuntime = createDurableAuthorityBindingRuntimeV2({
        config,
        table: state.bindingState,
        proofKeys
      });
      const namespaceVerifier = createDurableOperationNamespaceVerifierV2({
        config,
        table: state.namespaceState,
        proofKeys
      });
      const eventLog = makeLocalAuthorityAttributionEventV2Log({
          rootDir: repo.canonicalRoot,
          ...(input.layoutOverrides ? { layoutOverrides: input.layoutOverrides } : {})
        });
      const authoredRoot = resolveHarnessLayout({
        rootDir: repo.canonicalRoot,
        ...(input.layoutOverrides ? { layoutOverrides: input.layoutOverrides } : {})
      }).authoredRoot;
      const replication = await createPrewarmedAuthorityReplication({
        gitRoot: authoredRoot,
        state: state.replicationState,
        workspaceId: config.workspaceId,
        epoch: String(config.authorityGeneration),
        changeLog: state.replicaChangeLog
      });
      const replicationContent = replication.content;
      const replicaChangeLog = replication.changeLog;
      const publicationInspector = createGitCanonicalPublicationInspector(
        authoredRoot,
        productionPublicationRetryOptions(input, config)
      );
      const recoveryGenerationFence = createRuntimeDaemonGenerationWitnessFence({
        runtime,
        workspaceId: config.workspaceId,
        repo: { repoId: config.repoId, canonicalRoot: config.canonicalRoot }
      });
      const evidenceCommitter = createGitAuthorityAttributionEvidenceCommitterV2({
        rootDir: repo.canonicalRoot,
        ...(input.layoutOverrides ? { layoutOverrides: input.layoutOverrides } : {})
      });
      const commitEvidence = async (canonicalCommitSha: string): Promise<void> => {
        reportCurrentRepoWriteTelemetry("authority-evidence-commit");
        reportCurrentRepoWriteTelemetry("fsync");
        await evidenceCommitter.commitPending(canonicalCommitSha);
        reportCurrentRepoWriteTelemetry("authority-evidence-publish-returned");
      };
      const basePublisher = createDurableAuthorityCommittedEventPublisherV2({
        eventLog,
        commitEvidence,
        observation: {
          observe: async (request) => {
            let expectedOpIds = request.observation?.opIds ?? request.opIds;
            if (!request.observation) {
              reportCurrentRepoWriteTelemetry("authority-replica-change-read");
              const change = await replicaChangeLog.getByCommit?.(request.workspaceId, request.commitSha);
              if (!change) {
                throw new Error(`AUTHORITY_PRODUCTION_PUBLICATION_CHANGE_MISSING:commitSha=${request.commitSha}`);
              }
              expectedOpIds = change.operations.map((operation) => operation.opId);
            }
            if (request.opIds.some((opId) => !expectedOpIds.includes(opId))) {
              throw new Error(`AUTHORITY_PRODUCTION_PUBLICATION_OPERATION_MISSING:opIds=${request.opIds.join(",")};commitSha=${request.commitSha}`);
            }
            const evidence = request.observation ?? await (async () => {
              reportCurrentRepoWriteTelemetry("git");
              const inspect = publicationObservers.get(repo.repoId);
              if (!inspect) throw new Error("AUTHORITY_PRODUCTION_PUBLICATION_OBSERVER_UNAVAILABLE");
              reportCurrentRepoWriteTelemetry("authority-publication-proof");
              return inspect(request.previousCommit, expectedOpIds, request.commitSha);
            })();
            if (evidence.commitSha !== request.commitSha || evidence.previousCommit !== request.previousCommit) {
              throw new Error("AUTHORITY_PRODUCTION_PUBLICATION_OBSERVATION_MISMATCH");
            }
            reportCurrentRepoWriteTelemetry("authority-operation-integrity");
            const mutationSets = await Promise.all(expectedOpIds.map(async (opId) => {
              const record = await state.operationRegistry.get(request.workspaceId, opId);
              if (!record?.authorityIntegrity) {
                throw new Error(`AUTHORITY_PRODUCTION_PUBLICATION_INTEGRITY_MISSING:opId=${opId}`);
              }
              return record.authorityIntegrity.canonicalMutationSet;
            }));
            assertPublicationMatchesMutationSet(evidence, {
              registryVersion: 1,
              mutations: mutationSets.flatMap((mutationSet) => mutationSet.mutations)
            });
            return { ...evidence, opIds: expectedOpIds };
          }
        }
      });
      const committedEventPublisher = withProductionRecoveryV2({
        publisher: basePublisher,
        replicaChangeLog,
        operationRegistry: state.operationRegistry,
        bindingRuntime,
        eventLog,
        publicationInspector,
        commitEvidence
      });
      const recovery = {} as ProductionRecoveryState;
      const material: RepoProductionMaterial = {
        config,
        keyStore: keyMaterial.keyStore,
        keyRegistry: keyMaterial.registry,
        bindingRuntime,
        authoredRoot,
        configurationDigest: authorityManifestSourceDigest(input.manifestPath),
        serviceStateRoot: manifest.serviceStateRoot,
        replicationState: state.replicationState,
        replicationContent,
        replicaChangeLog,
        ...(input.daemonLogService ? { daemonLogService: input.daemonLogService } : {}),
        ...(input.onPublicationRetryBudgetSignal ? {
          onPublicationRetryBudgetSignal: input.onPublicationRetryBudgetSignal
        } : {}),
        recovery
      };
      materials.set(repo.repoId, material);
      publicationObservers.set(
        repo.repoId,
        createDurableSuccessorPublicationObserver(publicationInspector)
      );
      const runRecovery = async () => recoverPendingProductionEvents({
        workspaceId: config.workspaceId,
        operationRegistry: state.operationRegistry,
        replicaChangeLog,
        eventLog,
        publicationInspector,
        recover: committedEventPublisher.recoverCommittedReceipt,
        ...(recoveryGenerationFence ? { generationFence: recoveryGenerationFence } : {}),
        watermarkPath: `${state.stateDirectory}/recovery-watermark.json`,
        ...(input.daemonLogService ? {
          onDeferred: (record: import("@harness-anything/application").AuthorityStoredOperationRecord, error: unknown) =>
            input.daemonLogService!.append({
              level: "error",
              source: "daemon",
              component: "authority-recovery",
              event: "authority.recovery.deferred",
              message: `Deferred production authority recovery for opId=${record.opId}: ${recoveryErrorSummary(error)}`,
              errorCode: recoveryErrorCode(error),
              requestId: record.opId
            }, { repo: { repoId: config.repoId, canonicalRoot: config.canonicalRoot } }).then(() => undefined)
        } : {})
      });
      recovery.status = "recovering";
      recovery.promise = input.backgroundRecovery
        ? new Promise<void>((resolve) => {
          setImmediate(() => {
            void settleProductionRecovery(recovery, runRecovery).finally(resolve);
          });
        })
        : settleProductionRecovery(recovery, runRecovery);
      if (!input.backgroundRecovery) await recovery.promise;
      return {
        authenticatedPersonRegistry: identity.personRegistry,
        deriveExecutorFromParsedPreset: (presetId) => `preset:${presetId}`,
        workspaceId: config.workspaceId,
        repoId: config.repoId,
        canonicalRoot: config.canonicalRoot,
        deviceId: config.deviceId,
        viewId: config.viewId,
        sessionId: config.sessionId,
        schemaTuple: config.schemaTuple,
        authorityGeneration: config.authorityGeneration,
        revocationEpochs: Object.fromEntries(Object.entries(config.revocationEpochs).map(([key, value]) => [key, Number(value)])),
        admissionTokenRef: config.admissionTokenRef,
        operationNamespace: config.operationNamespace.namespaceId,
        bindingRuntime,
        namespaceVerifier,
        committedEventPublisher
      };
    }
  });
  return {
    ...controller,
    hasActiveWork: () => [...materials.values()].some((material) => material.recovery.status === "recovering")
  };

  function createProductionAuthorityRepoLifecycleHooks(options: {
    readonly materials: ReadonlyMap<string, RepoProductionMaterial>;
  }): AuthorityRepoLifecycleHooks {
    return {
      start: async (startInput) => {
        const material = options.materials.get(startInput.repo.repoId);
        if (!material) throw new Error("AUTHORITY_PRODUCTION_MATERIAL_UNAVAILABLE");
        return createRepoComponent(startInput, material, input.hostServices);
      },
      serve: async ({ component }) => {
        (component as ProductionAuthorityRepoComponent).setServing(true);
      },
      stop: async ({ repo, component, reason }) => {
        const material = options.materials.get(repo.repoId);
        try {
          await component.stop(reason);
          await material?.recovery.promise;
        } finally {
          materials.delete(repo.repoId);
          publicationObservers.delete(repo.repoId);
        }
      }
    };
  }
}

interface ProductionAuthorityRepoComponent extends AuthorityRepoComponent {
  readonly setServing: (value: boolean) => void;
}

function createRepoComponent(
  input: Parameters<AuthorityRepoLifecycleHooks["start"]>[0],
  material: RepoProductionMaterial,
  hostServices: ProductionAuthorityHostServices<ProductionAuthorityIdentity>
): ProductionAuthorityRepoComponent {
  const writerGeneration = input.runtime.daemonGenerationContext?.()?.daemonGeneration;
  const sessions = new Set<ReturnType<typeof serveAuthorityForcedCommand>>();
  const publicationExecutor = createSerialPublicationExecutor();
  const readDownService = createAuthorityReadDownService({
    workspaceId: material.config.workspaceId,
    epoch: String(material.config.authorityGeneration),
    gitRoot: material.authoredRoot,
    state: material.replicationState,
    replicaChangeLog: material.replicaChangeLog,
    content: material.replicationContent,
    publicationExecutor
  });
  const repoGenerationFence = createRuntimeDaemonGenerationAuthorityFence({
    runtime: input.runtime,
    authorityFence: input.fenceWitness,
    workspaceId: material.config.workspaceId,
    repo: { repoId: material.config.repoId, canonicalRoot: material.config.canonicalRoot }
  });
  const cutoverControl = createAuthorityCutoverControlService({
    repoId: material.config.repoId,
    workspaceId: material.config.workspaceId,
    selectedSchemaTuple: material.config.schemaTuple,
    operationRegistry: input.operationRegistry,
    stateStore: input.cutoverState,
    productionScanner: createAuthorityProductionScanner({ authoredRoot: material.authoredRoot }),
    productionContext: {
      authorityId: material.config.authorityId,
      configurationDigest: material.configurationDigest,
      entityRegistryQualification: createAuthorityCutoverEntityRegistryQualification(
        entityRegistryKinds.map((kind) => {
          const registration = entityRegistry[kind];
          return {
            kind,
            identityCodecStatus: registration.identityCodec.status,
            storageLocatorStatus: registration.storageLocator.status,
            mutationContractStatus: registration.mutationContract.status,
            semanticDiffStatus: registration.semanticDiff.status,
            projectionFacetStatus: registration.projectionFacet.status,
            mutationActions: registration.mutationContract.status === "ready"
              ? registration.mutationContract.actions
              : []
          };
        })
      ),
      enabledV2WriterKinds: productionAuthorityV2EntityKinds,
      assertWriteFenceHeld: (repoGenerationFence ?? input.fenceWitness).assertHeld
    }
  });
  let serving = false;
  let stopped = false;
  const unbound = {
    submit: async () => {
      throw new Error("AUTHORITY_CONNECTION_CONTEXT_REQUIRED");
    },
    submitDurable: async () => {
      throw new Error("AUTHORITY_CONNECTION_CONTEXT_REQUIRED");
    }
  };
  const compoundReceipt = createProductionCompoundReceiptComposition({
    workspaceId: material.config.workspaceId,
    viewId: material.config.viewId,
    canonicalRoot: material.config.canonicalRoot,
    stateDirectory: `${material.serviceStateRoot}/compound-receipts/${Buffer.from(material.config.repoId, "utf8").toString("base64url")}`,
    replicaChangeLog: material.replicaChangeLog,
    ...(repoGenerationFence ? {
      generationFence: createProductionCompoundReceiptGenerationFence(
        repoGenerationFence,
        daemonGenerationAxes(input.runtime)
      )
    } : {})
  });
  return {
    commandSubmissionV2: unbound,
    cutoverControl,
    compoundReceipt,
    recoverCommittedReceipt: (opId) => recoverProductionCommittedReceipt({
      recovery: material.recovery.promise, operationRegistry: input.operationRegistry,
      publisher: input.committedEventPublisher, workspaceId: material.config.workspaceId, opId
    }),
    setServing: (value) => {
      if (stopped && value) throw new Error("AUTHORITY_REPO_COMPONENT_STOPPED");
      serving = value;
    },
    bindConnection: (context) => {
      if (!serving || stopped) throw new Error("AUTHORITY_REPO_COMPONENT_NOT_SERVING");
      assertConnectionContext(input, material.config, context);
      const authorityService = gateAuthoritySubmissionForRecovery(
        gateCutoverAdmission(
          attestSubmissionService(createConnectionAuthorityService(
            input,
            material,
            context,
            publicationExecutor,
            hostServices
          ), context),
          cutoverControl
        ),
        () => waitForProductionRecovery({ repoId: material.config.repoId, recovery: material.recovery })
      );
      const {
        compiler: progressCompiler,
        ...progressBinding
      } = createProductionProgressAppendConnectionBinding({
        material,
        ...(writerGeneration ? { writerGeneration } : {}),
        context,
        hostServices,
        authorityService,
        ...(input.runtime.runAuthorizedRepoWriteRecoveryPlan ? {
          runAuthorizedRecoveryPlan: input.runtime.runAuthorizedRepoWriteRecoveryPlan
        } : {})
      });
      const commandSubmission = createDaemonAuthorityCommandSubmissionV2({
        authorityService,
        attemptCompiler: progressCompiler
      });
      const binding: AuthorityRepoConnectionBinding = {
        ...commandSubmission,
        ...progressBinding,
        serveForcedCommand: ({ input: readable, output }) => {
          const session = serveAuthorityForcedCommand({
            input: readable,
            output,
            workspaceId: material.config.workspaceId,
            protocol: material.config.schemaTuple,
            serverChannelNonceDigest: context.channelBinding.digest,
            submissionService: authorityService,
            replicaChangeLog: material.replicaChangeLog,
            readDownService
          });
          sessions.add(session);
          readable.once("close", () => {
            void session.close().finally(() => sessions.delete(session));
          });
          return session;
        }
      };
      return binding;
    },
    stop: async () => {
      if (stopped) return;
      serving = false;
      stopped = true;
      await Promise.all([...sessions].map((session) => session.close()));
      sessions.clear();
    }
  };
}

function createConnectionAuthorityService(
  input: Parameters<AuthorityRepoLifecycleHooks["start"]>[0],
  material: RepoProductionMaterial,
  context: AuthorityConnectionContext,
  publicationExecutor: {
    readonly run: <Result>(publication: (
      context: AuthorityPublicationExecutionContext
    ) => Promise<Result>) => Promise<Result>;
  },
  hostServices: ProductionAuthorityHostServices<ProductionAuthorityIdentity>
): AuthoritySubmissionService {
  const publicationInspector = createGitCanonicalPublicationInspector(
    material.authoredRoot,
    productionPublicationRetryOptions(material, material.config)
  );
  const writerGeneration = input.runtime.daemonGenerationContext?.()?.daemonGeneration;
  const generationFence = createRuntimeDaemonGenerationWitnessFence({
    runtime: input.runtime,
    workspaceId: material.config.workspaceId,
    repo: { repoId: material.config.repoId, canonicalRoot: material.config.canonicalRoot },
    connectionId: context.connectionId
  });
  return createAuthoritySubmissionService({
    workspaceId: material.config.workspaceId,
    coordinatorFactory: input.attributedCoordinatorFactory,
    tokenVerifier: { verify: async () => { throw new Error("AUTHORITY_LEGACY_TOKEN_DISABLED"); } },
    operationRegistry: input.operationRegistry,
    replicaChangeLog: material.replicaChangeLog,
    publicationInspector,
    publicationExecutor,
    fenceWitness: input.fenceWitness,
    ...(generationFence ? { generationFenceWitness: generationFence } : {}),
    admissionBudget: input.admissionBudget,
    onTelemetry: reportCurrentRepoWriteTelemetry,
    v2: {
      schemaTuple: material.config.schemaTuple,
      channelNonceDigest: context.channelBinding.digest,
      ...(writerGeneration ? {
        recoveryScope: { repoId: material.config.repoId, writerGeneration }
      } : {}),
      bindingRuntime: connectionBoundRuntime(material.bindingRuntime, material.config, context),
      entityRegistrations: productionAuthorityV2EntityKinds.map((kind) =>
        entityRegistry[kind] as unknown as EntityRegistration<string, typeof kind>
      ),
      semanticCompiler: createProductionAuthoritySemanticCompiler(material.authoredRoot, hostServices),
      operationNamespaceVerifier: input.namespaceVerifier,
      committedEventPublisher: input.committedEventPublisher,
      recoverCommittedReceipt: (input.committedEventPublisher as typeof input.committedEventPublisher & {
        recoverCommittedReceipt?: NonNullable<AuthoritySubmissionV2Options["recoverCommittedReceipt"]>
      }).recoverCommittedReceipt,
      ...(input.runtime.runAuthorizedRepoWriteRecoveryAttempt ? {
        runAuthorizedRecoveryAttempt: input.runtime.runAuthorizedRepoWriteRecoveryAttempt
      } : {})
    }
  });
}

function assertConnectionContext(
  input: Parameters<AuthorityRepoLifecycleHooks["start"]>[0],
  config: AuthorityProductionRepoConfigV1,
  context: AuthorityConnectionContext
): void {
  if (context.repoId !== input.repo.repoId || context.channelBinding.digest.byteLength !== 32
    || !input.serverData.authenticatedPersonRegistry.find(context.actor.personId)) {
    throw new Error("AUTHORITY_CONNECTION_CONTEXT_REJECTED");
  }
  if (config.workspaceId !== input.serverData.workspaceId
    || config.deviceId !== input.serverData.deviceId
    || config.viewId !== input.serverData.viewId
    || config.sessionId !== input.serverData.sessionId) {
    throw new Error("AUTHORITY_SERVER_AXIS_MISMATCH");
  }
}
