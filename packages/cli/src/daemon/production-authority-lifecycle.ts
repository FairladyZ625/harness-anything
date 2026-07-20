import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import {
  createAuthorityCutoverEntityRegistryQualification,
  createAuthorityCutoverControlService,
  createDurableAuthorityCommittedEventPublisherV2,
  type ActorAxesBindingRuntimeV2,
  type AuthoritySubmissionV2Options,
  type AuthoritySubmissionService,
  type DaemonLogService,
  type ProductionAuthorityHostServices,
} from "@harness-anything/application";
import { createAuthoritySubmissionService } from "@harness-anything/application/authority/service";
import {
  answerAttestationChallenge,
  assertPublicationMatchesMutationSet,
  createAuthorityProductionScanner,
  createAttestationChallenge,
  createGitAuthorityAttributionEvidenceCommitterV2,
  createGitCanonicalPublicationInspector,
  createTransportObservedAttestationAdapter,
  createDaemonAuthorityCommandSubmissionV2,
  createAuthorityRepoLifecycleController,
  createProductionCompoundReceiptComposition,
  gateAuthoritySubmissionForRecovery,
  gateCutoverAdmission,
  recoverPendingProductionEvents,
  recoveryErrorCode,
  recoveryErrorSummary,
  verifyAttestationAssertion,
  type AuthorityConnectionContext,
  type AuthorityRepoComponent,
  type AuthorityRepoConnectionBinding,
  type AuthorityRepoLifecycleController,
  type AuthorityRepoLifecycleHooks,
  type PersonRegistry
} from "@harness-anything/daemon";
import { serveAuthorityForcedCommand } from "@harness-anything/daemon/authority/forced-command-session";
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
import { withProductionRecoveryV2 } from "./authority-attribution-event-v2-production-recovery.ts";
import { createProductionCanonicalAttemptCompiler } from "./production-authority-attempt-compiler.ts";
import { createProductionAuthoritySemanticCompiler } from "./production-authority-semantic-compiler.ts";
export { recoverPendingProductionEvents } from "@harness-anything/daemon";

interface RepoProductionMaterial {
  readonly config: AuthorityProductionRepoConfigV1;
  readonly keyStore: ReturnType<typeof openAuthorityProductionKeyMaterial>["keyStore"];
  readonly keyRegistry: ReturnType<typeof openAuthorityProductionKeyMaterial>["registry"];
  readonly bindingRuntime: DurableAuthorityBindingRuntimeV2;
  readonly authoredRoot: string;
  readonly configurationDigest: string;
  readonly serviceStateRoot: string;
  readonly recovery: ProductionRecoveryState;
}

interface ProductionRecoveryState {
  status: "recovering" | "complete" | "failed";
  error?: string;
  promise: Promise<void>;
}

const productionAuthorityV2EntityKinds = [
  "task", "decision", "module", "fact", "relation", "session", "execution", "review", "consent"
] as const;

interface ProductionAuthorityIdentity {
  readonly personRegistry?: PersonRegistry;
}

export function createProductionAuthorityLifecycle(input: {
  readonly manifestPath: string;
  readonly layoutOverrides?: { readonly authoredRoot?: string };
  readonly daemonLogService?: DaemonLogService;
  readonly backgroundRecovery?: true;
  readonly hostServices: ProductionAuthorityHostServices<ProductionAuthorityIdentity>;
}): AuthorityRepoLifecycleController {
  const manifest = loadAuthorityProductionManifest(input.manifestPath);
  const materials = new Map<string, RepoProductionMaterial>();
  const publicationObservers = new Map<string, Parameters<AuthorityRepoLifecycleHooks["start"]>[0]["inspectPublication"]>();
  const hooks = createProductionAuthorityRepoLifecycleHooks({ materials });
  return createAuthorityRepoLifecycleController({
    hooks,
    serviceStateRoot: manifest.serviceStateRoot,
    resolveCompositionData: async (repo, state) => {
      const config = manifest.repos.find((candidate) => candidate.repoId === repo.repoId);
      if (!config || canonicalRoot(config.canonicalRoot) !== canonicalRoot(repo.canonicalRoot)) {
        throw new Error("AUTHORITY_PRODUCTION_REPO_NOT_CONFIGURED");
      }
      const identity = input.hostServices.loadDaemonIdentity(
        repo.canonicalRoot,
        input.layoutOverrides,
        undefined,
        manifest.serviceStateRoot
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
      const publicationInspector = createGitCanonicalPublicationInspector(authoredRoot);
      const evidenceCommitter = createGitAuthorityAttributionEvidenceCommitterV2({
        rootDir: repo.canonicalRoot,
        ...(input.layoutOverrides ? { layoutOverrides: input.layoutOverrides } : {})
      });
      const basePublisher = createDurableAuthorityCommittedEventPublisherV2({
        eventLog,
        commitEvidence: evidenceCommitter.commitPending,
        observation: {
          observe: async (request) => {
            const inspect = publicationObservers.get(repo.repoId);
            if (!inspect) throw new Error("AUTHORITY_PRODUCTION_PUBLICATION_OBSERVER_UNAVAILABLE");
            const changes = await state.replicaChangeLog.changesAfter(request.workspaceId, 0);
            const expectedOpIds = changes
              .filter((change) => change.commitSha === request.commitSha)
              .sort((left, right) => left.revision - right.revision)
              .map((change) => change.opId);
            if (!expectedOpIds.includes(request.opId)) {
              throw new Error(`AUTHORITY_PRODUCTION_PUBLICATION_OPERATION_MISSING:opId=${request.opId};commitSha=${request.commitSha}`);
            }
            const evidence = await inspect(request.previousCommit, expectedOpIds, request.commitSha);
            if (evidence.commitSha !== request.commitSha || evidence.previousCommit !== request.previousCommit) {
              throw new Error("AUTHORITY_PRODUCTION_PUBLICATION_OBSERVATION_MISMATCH");
            }
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
            return { ...evidence, recordedAt: new Date().toISOString() };
          }
        }
      });
      const committedEventPublisher = withProductionRecoveryV2({
        publisher: basePublisher,
        replicaChangeLog: state.replicaChangeLog,
        operationRegistry: state.operationRegistry,
        bindingRuntime,
        eventLog,
        publicationInspector,
        commitEvidence: evidenceCommitter.commitPending
      });
      const recovery = {} as ProductionRecoveryState;
      const material: RepoProductionMaterial = {
        config,
        keyStore: keyMaterial.keyStore,
        keyRegistry: keyMaterial.registry,
        bindingRuntime,
        authoredRoot: resolveHarnessLayout({
          rootDir: repo.canonicalRoot,
          ...(input.layoutOverrides ? { layoutOverrides: input.layoutOverrides } : {})
        }).authoredRoot,
        configurationDigest: authorityManifestSourceDigest(input.manifestPath),
        serviceStateRoot: manifest.serviceStateRoot,
        recovery
      };
      materials.set(repo.repoId, material);
      publicationObservers.set(repo.repoId, async (previousCommit, expectedOpIds, expectedCommitSha) => {
        const inspector = publicationInspector;
        return inspector.inspectPublication(previousCommit, expectedOpIds, expectedCommitSha);
      });
      const runRecovery = async () => recoverPendingProductionEvents({
        workspaceId: config.workspaceId,
        operationRegistry: state.operationRegistry,
        replicaChangeLog: state.replicaChangeLog,
        eventLog,
        publicationInspector,
        recover: committedEventPublisher.recoverCommittedReceipt,
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

  function createProductionAuthorityRepoLifecycleHooks(options: {
    readonly materials: ReadonlyMap<string, RepoProductionMaterial>;
  }): AuthorityRepoLifecycleHooks {
    return {
      start: async (startInput) => {
        publicationObservers.set(startInput.repo.repoId, startInput.inspectPublication);
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
  const sessions = new Set<ReturnType<typeof serveAuthorityForcedCommand>>();
  const publicationExecutor = createSerialPublicationExecutor();
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
      assertWriteFenceHeld: input.fenceWitness.assertHeld
    }
  });
  let serving = false;
  let stopped = false;
  const unbound = {
    submit: async () => {
      throw new Error("AUTHORITY_CONNECTION_CONTEXT_REQUIRED");
    }
  };
  const compoundReceipt = createProductionCompoundReceiptComposition({
    workspaceId: material.config.workspaceId,
    viewId: material.config.viewId,
    canonicalRoot: material.config.canonicalRoot,
    stateDirectory: `${material.serviceStateRoot}/compound-receipts/${Buffer.from(material.config.repoId, "utf8").toString("base64url")}`,
    replicaChangeLog: input.replicaChangeLog
  });
  return {
    commandSubmissionV2: unbound,
    cutoverControl,
    compoundReceipt,
    setServing: (value) => {
      if (stopped && value) throw new Error("AUTHORITY_REPO_COMPONENT_STOPPED");
      serving = value;
    },
    bindConnection: (context) => {
      if (!serving || stopped) throw new Error("AUTHORITY_REPO_COMPONENT_NOT_SERVING");
      assertConnectionContext(input, material.config, context);
      const authorityService = gateAuthoritySubmissionForRecovery(
        gateCutoverAdmission(
          attestSubmissionService(createConnectionAuthorityService(input, material, context, publicationExecutor), context),
          cutoverControl
        ),
        () => recoveryUnavailableReason(material)
      );
      const commandSubmission = createDaemonAuthorityCommandSubmissionV2({
        authorityService,
        attemptCompiler: createProductionCanonicalAttemptCompiler({
          config: material.config,
          keyStore: material.keyStore,
          keyRegistry: material.keyRegistry,
          bindingRuntime: material.bindingRuntime,
          context,
          authoredRoot: material.authoredRoot,
          hostServices
        })
      });
      const binding: AuthorityRepoConnectionBinding = {
        submit: commandSubmission.submit,
        ...(commandSubmission.submitProvenanceSession ? {
          submitProvenanceSession: commandSubmission.submitProvenanceSession
        } : {}),
        ...(commandSubmission.submitDecisionTransition ? {
          submitDecisionTransition: commandSubmission.submitDecisionTransition
        } : {}),
        ...(commandSubmission.submitTaskClaim ? {
          submitTaskClaim: commandSubmission.submitTaskClaim
        } : {}),
        ...(commandSubmission.submitObservedWrite ? {
          submitObservedWrite: commandSubmission.submitObservedWrite
        } : {}),
        ...(commandSubmission.submitScriptIngest ? {
          submitScriptIngest: commandSubmission.submitScriptIngest
        } : {}),
        serveForcedCommand: ({ input: readable, output }) => {
          const session = serveAuthorityForcedCommand({
            input: readable,
            output,
            workspaceId: material.config.workspaceId,
            protocol: material.config.schemaTuple,
            serverChannelNonceDigest: context.channelBinding.digest,
            submissionService: authorityService,
            replicaChangeLog: input.replicaChangeLog
          });
          sessions.add(session);
          readable.once("close", () => sessions.delete(session));
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

async function settleProductionRecovery(
  recovery: ProductionRecoveryState,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run();
    recovery.status = "complete";
    recovery.error = undefined;
  } catch (error) {
    recovery.status = "failed";
    recovery.error = recoveryErrorSummary(error);
  }
}

function recoveryUnavailableReason(material: RepoProductionMaterial): string | undefined {
  if (material.recovery.status === "complete") return undefined;
  if (material.recovery.status === "recovering") {
    return `AUTHORITY_RECOVERY_IN_PROGRESS:repoId=${material.config.repoId}; retry after daemon recovery completes`;
  }
  return `AUTHORITY_RECOVERY_FAILED:repoId=${material.config.repoId};error=${material.recovery.error ?? "unknown"}`;
}

function createConnectionAuthorityService(
  input: Parameters<AuthorityRepoLifecycleHooks["start"]>[0],
  material: RepoProductionMaterial,
  context: AuthorityConnectionContext,
  publicationExecutor: {
    readonly run: <Result>(publication: () => Promise<Result>) => Promise<Result>;
  }
): AuthoritySubmissionService {
  const publicationInspector = createGitCanonicalPublicationInspector(material.authoredRoot);
  return createAuthoritySubmissionService({
    workspaceId: material.config.workspaceId,
    coordinatorFactory: input.attributedCoordinatorFactory,
    tokenVerifier: { verify: async () => { throw new Error("AUTHORITY_LEGACY_TOKEN_DISABLED"); } },
    operationRegistry: input.operationRegistry,
    replicaChangeLog: input.replicaChangeLog,
    publicationInspector,
    publicationExecutor,
    fenceWitness: input.fenceWitness,
    admissionBudget: input.admissionBudget,
    v2: {
      schemaTuple: material.config.schemaTuple,
      channelNonceDigest: context.channelBinding.digest,
      bindingRuntime: connectionBoundRuntime(material.bindingRuntime, material.config, context),
      entityRegistrations: productionAuthorityV2EntityKinds.map((kind) =>
        entityRegistry[kind] as unknown as EntityRegistration<string, typeof kind>
      ),
      semanticCompiler: createProductionAuthoritySemanticCompiler(material.authoredRoot),
      operationNamespaceVerifier: input.namespaceVerifier,
      committedEventPublisher: input.committedEventPublisher,
      recoverCommittedReceipt: (input.committedEventPublisher as typeof input.committedEventPublisher & {
        recoverCommittedReceipt?: NonNullable<AuthoritySubmissionV2Options["recoverCommittedReceipt"]>
      }).recoverCommittedReceipt
    }
  });
}

function createSerialPublicationExecutor(): {
  readonly run: <Result>(publication: () => Promise<Result>) => Promise<Result>;
} {
  let tail = Promise.resolve();
  return {
    run: <Result>(publication: () => Promise<Result>): Promise<Result> => {
      const result = tail.then(publication, publication);
      tail = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}

function connectionBoundRuntime(
  runtime: DurableAuthorityBindingRuntimeV2,
  config: AuthorityProductionRepoConfigV1,
  context: AuthorityConnectionContext
): ActorAxesBindingRuntimeV2 {
  return {
    ...runtime,
    getBinding: async (bindingId) => {
      const record = await runtime.getBinding(bindingId);
      if (!record) return undefined;
      if (record.principalPersonId !== context.actor.personId
        || record.workspaceId !== config.workspaceId
        || record.deviceId !== config.deviceId
        || record.viewId !== config.viewId
        || record.attribution.actor.principal.personId !== context.actor.personId) return undefined;
      return record;
    }
  };
}

function attestSubmissionService(
  service: AuthoritySubmissionService,
  context: AuthorityConnectionContext
): AuthoritySubmissionService {
  const assertAttested = () => assertTransportObservedAttestation(context);
  return {
    submit: async (envelope) => {
      await assertAttested();
      return service.submit(envelope);
    },
    ...(service.submitV2 ? {
      submitV2: async (attempt: Parameters<NonNullable<AuthoritySubmissionService["submitV2"]>>[0]) => {
        await assertAttested();
        return service.submitV2!(attempt);
      }
    } : {}),
    getOperation: async (workspaceId, opId) => {
      await assertAttested();
      return service.getOperation(workspaceId, opId);
    }
  };
}

async function assertTransportObservedAttestation(context: AuthorityConnectionContext): Promise<void> {
  const channel = Buffer.from(context.channelBinding.digest).toString("hex");
  const adapter = createTransportObservedAttestationAdapter(context);
  const challenge = createAttestationChallenge({ verifierRole: "broker", channelBinding: channel });
  const assertion = await answerAttestationChallenge(
    challenge,
    context.actor.resolvedCredential,
    adapter.proofProvider
  );
  await verifyAttestationAssertion({
    challenge,
    assertion,
    observedCredential: context.actor.resolvedCredential,
    verifier: adapter.proofVerifier
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

function canonicalRoot(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function authorityManifestSourceDigest(manifestPath: string): string {
  return createHash("sha256")
    .update("ha/authority-production-manifest-source/v1\0", "utf8")
    .update(readFileSync(manifestPath))
    .digest("hex");
}
