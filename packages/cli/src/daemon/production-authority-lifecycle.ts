import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import {
  actorAxesBindingDigestV2,
  actorAxesBindingTokenDigestV2,
  canonicalPayloadDigestV2,
  createAuthorityCutoverEntityRegistryQualification,
  createAuthorityCutoverControlService,
  createDurableAuthorityCommittedEventPublisherV2,
  encodeSemanticMutationEnvelopeV2,
  encodeTaskDecisionModuleCommandPayloadV2,
  issueActorAxesBindingV2,
  makeTaskDecisionModuleSemanticCompilerV2,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  semanticMutationEnvelopeV2Schema,
  type ActorAxesBindingRuntimeV2,
  type AuthorityCutoverControlService,
  type AuthoritySubmissionService,
  type SemanticMutationEnvelopeV2
} from "../../../application/src/index.ts";
import { createAuthoritySubmissionService } from "../../../application/src/authority/service.ts";
import {
  answerAttestationChallenge,
  createAttestationChallenge,
  createTransportObservedAttestationAdapter,
  verifyAttestationAssertion,
  type AuthorityConnectionContext
} from "../../../daemon/src/index.ts";
import { serveAuthorityForcedCommand } from "../../../daemon/src/authority/forced-command-session.ts";
import {
  entityRegistry,
  entityRegistryKinds,
  makeLocalAuthorityAttributionEventV2Log,
  resolveHarnessLayout,
  taskEntityId,
  type EntityRegistration
} from "../../../kernel/src/index.ts";
import { loadDaemonIdentity } from "../commands/daemon/productization.ts";
import type { ParsedCommand } from "../cli/types.ts";
import {
  createDaemonAuthorityCommandSubmissionV2,
  type DaemonAuthorityAttemptCompilerV2
} from "./authority-command-submission.ts";
import {
  createAuthorityRepoLifecycleController,
  type AuthorityRepoComponent,
  type AuthorityRepoConnectionBinding,
  type AuthorityRepoLifecycleController,
  type AuthorityRepoLifecycleHooks
} from "./authority-lifecycle.ts";
import {
  createDurableAuthorityBindingRuntimeV2,
  createDurableOperationNamespaceVerifierV2,
  loadAuthorityProductionManifest,
  openAuthorityProductionKeyMaterial,
  type AuthorityProductionRepoConfigV1,
  type DurableAuthorityBindingRuntimeV2
} from "./authority-production-state.ts";
import { createGitCanonicalPublicationInspector } from "./authority-publication-evidence.ts";
import { createAuthorityProductionScanner } from "./authority-production-scanner.ts";

interface RepoProductionMaterial {
  readonly config: AuthorityProductionRepoConfigV1;
  readonly keyStore: ReturnType<typeof openAuthorityProductionKeyMaterial>["keyStore"];
  readonly keyRegistry: ReturnType<typeof openAuthorityProductionKeyMaterial>["registry"];
  readonly bindingRuntime: DurableAuthorityBindingRuntimeV2;
  readonly authoredRoot: string;
  readonly configurationDigest: string;
}

const productionAuthorityV2EntityKinds = ["task", "decision", "module"] as const;

export function createProductionAuthorityLifecycle(input: {
  readonly manifestPath: string;
  readonly layoutOverrides?: { readonly authoredRoot?: string };
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
      const identity = loadDaemonIdentity(
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
      const committedEventPublisher = createDurableAuthorityCommittedEventPublisherV2({
        eventLog: makeLocalAuthorityAttributionEventV2Log({
          rootDir: repo.canonicalRoot,
          ...(input.layoutOverrides ? { layoutOverrides: input.layoutOverrides } : {})
        }),
        observation: {
          observe: async (request) => {
            const inspect = publicationObservers.get(repo.repoId);
            if (!inspect) throw new Error("AUTHORITY_PRODUCTION_PUBLICATION_OBSERVER_UNAVAILABLE");
            const evidence = await inspect(request.previousCommit);
            if (evidence.commitSha !== request.commitSha || evidence.previousCommit !== request.previousCommit) {
              throw new Error("AUTHORITY_PRODUCTION_PUBLICATION_OBSERVATION_MISMATCH");
            }
            return { ...evidence, recordedAt: new Date().toISOString() };
          }
        }
      });
      materials.set(repo.repoId, {
        config,
        keyStore: keyMaterial.keyStore,
        keyRegistry: keyMaterial.registry,
        bindingRuntime,
        authoredRoot: resolveHarnessLayout({
          rootDir: repo.canonicalRoot,
          ...(input.layoutOverrides ? { layoutOverrides: input.layoutOverrides } : {})
        }).authoredRoot,
        configurationDigest: authorityManifestSourceDigest(input.manifestPath)
      });
      publicationObservers.set(repo.repoId, async (previousCommit) => {
        const inspector = createGitCanonicalPublicationInspector(
          input.layoutOverrides?.authoredRoot ?? repo.canonicalRoot
        );
        return inspector.inspectPublication(previousCommit);
      });
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
        return createRepoComponent(startInput, material);
      },
      serve: async ({ component }) => {
        (component as ProductionAuthorityRepoComponent).setServing(true);
      },
      stop: async ({ repo, component, reason }) => {
        try {
          await component.stop(reason);
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
  material: RepoProductionMaterial
): ProductionAuthorityRepoComponent {
  const sessions = new Set<ReturnType<typeof serveAuthorityForcedCommand>>();
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
  return {
    commandSubmissionV2: unbound,
    cutoverControl,
    setServing: (value) => {
      if (stopped && value) throw new Error("AUTHORITY_REPO_COMPONENT_STOPPED");
      serving = value;
    },
    bindConnection: (context) => {
      if (!serving || stopped) throw new Error("AUTHORITY_REPO_COMPONENT_NOT_SERVING");
      assertConnectionContext(input, material.config, context);
      const authorityService = gateCutoverAdmission(
        attestSubmissionService(createConnectionAuthorityService(input, material, context), context),
        cutoverControl
      );
      const commandSubmission = createDaemonAuthorityCommandSubmissionV2({
        authorityService,
        attemptCompiler: createProgressAppendAttemptCompiler(material, context)
      });
      const binding: AuthorityRepoConnectionBinding = {
        submit: commandSubmission.submit,
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

function gateCutoverAdmission(
  service: AuthoritySubmissionService,
  control: AuthorityCutoverControlService
): AuthoritySubmissionService {
  return {
    submit: (envelope) => control.runDuringOpenAdmission(() => service.submit(envelope)),
    ...(service.submitV2 ? {
      submitV2: (attempt: Parameters<NonNullable<AuthoritySubmissionService["submitV2"]>>[0]) =>
        control.runDuringOpenAdmission(() => service.submitV2!(attempt))
    } : {}),
    getOperation: service.getOperation
  };
}

function createConnectionAuthorityService(
  input: Parameters<AuthorityRepoLifecycleHooks["start"]>[0],
  material: RepoProductionMaterial,
  context: AuthorityConnectionContext
): AuthoritySubmissionService {
  const publicationInspector = createGitCanonicalPublicationInspector(material.authoredRoot);
  return createAuthoritySubmissionService({
    workspaceId: material.config.workspaceId,
    coordinatorFactory: input.attributedCoordinatorFactory,
    tokenVerifier: { verify: async () => { throw new Error("AUTHORITY_LEGACY_TOKEN_DISABLED"); } },
    operationRegistry: input.operationRegistry,
    replicaChangeLog: input.replicaChangeLog,
    publicationInspector,
    fenceWitness: input.fenceWitness,
    v2: {
      schemaTuple: material.config.schemaTuple,
      channelNonceDigest: context.channelBinding.digest,
      bindingRuntime: connectionBoundRuntime(material.bindingRuntime, material.config, context),
      entityRegistrations: productionAuthorityV2EntityKinds.map((kind) =>
        entityRegistry[kind] as unknown as EntityRegistration<string, typeof kind>
      ),
      semanticCompiler: makeTaskDecisionModuleSemanticCompilerV2({
        state: {
          readEntityBase: async () => null,
          readHostedDocument: async () => null
        }
      }),
      operationNamespaceVerifier: input.namespaceVerifier,
      committedEventPublisher: input.committedEventPublisher
    }
  });
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
        || record.sessionId !== config.sessionId
        || record.attribution.actor.principal.personId !== context.actor.personId) return undefined;
      return record;
    }
  };
}

function createProgressAppendAttemptCompiler(
  material: RepoProductionMaterial,
  context: AuthorityConnectionContext
): DaemonAuthorityAttemptCompilerV2 {
  return {
    compile: async ({ command, attribution, currentSession, canonicalEntityId }) => {
      if (command.action.kind !== "progress-append") throw new Error("AUTHORITY_TYPED_COMMAND_UNSUPPORTED");
      if (currentSession.sessionId !== material.config.sessionId) throw new Error("AUTHORITY_SESSION_AXIS_MISMATCH");
      if (canonicalEntityId !== taskEntityId(command.action.taskId)) throw new Error("AUTHORITY_CANONICAL_ENTITY_MISMATCH");
      const executorAgentId = attribution.executor?.id ?? null;
      if (executorAgentId && !material.config.allowedExecutorAgentIds.includes(executorAgentId)
        && !executorDerivedFromPreset(command, executorAgentId)) {
        throw new Error("AUTHORITY_EXECUTOR_NOT_SERVER_APPROVED");
      }
      const now = Date.now();
      const claims = {
        tokenId: `${material.config.admissionTokenRef}:${randomUUID()}`,
        bindingId: `binding:${randomUUID()}`,
        principalPersonId: context.actor.personId,
        executorAgentId,
        workspaceId: material.config.workspaceId,
        deviceId: material.config.deviceId,
        viewId: material.config.viewId,
        sessionId: material.config.sessionId,
        allowedEntityKinds: ["task"],
        allowedActions: ["append"],
        resourceScopes: [{
          kind: "entity-ref" as const,
          entityRef: { registryVersion: 1, entityKind: "task", canonicalRef: `task/${command.action.taskId}` }
        }, {
          kind: "portable-path" as const,
          path: `tasks/${command.action.taskId}/progress.md`
        }],
        pathFootprint: null,
        maxBytes: BigInt(Buffer.byteLength(command.action.text, "utf8")) + 4_096n,
        maxMutations: 1,
        maxOperations: 1,
        authorityGeneration: BigInt(material.config.authorityGeneration),
        channelNonceDigest: context.channelBinding.digest,
        schemaTuple: material.config.schemaTuple,
        issuedAt: BigInt(now),
        notBefore: BigInt(now),
        expiresAt: BigInt(now + 5 * 60_000),
        revocationEpochs: material.config.revocationEpochs
      };
      const token = issueActorAxesBindingV2(
        claims,
        material.keyStore.signingProfile(material.keyRegistry, now)
      );
      material.bindingRuntime.registerIssuedToken({
        claims,
        token,
        attribution: attribution.writeAttribution
      });
      const tokenDigest = actorAxesBindingTokenDigestV2(token);
      const evidence = command.action.evidence?.map((entry) =>
        `Evidence: ${entry.type}:${entry.path}:${entry.summary}`
      ).join("\n");
      const text = evidence ? `${command.action.text}\n\n${evidence}` : command.action.text;
      const payload = encodeTaskDecisionModuleCommandPayloadV2({
        schema: "task.append/v1",
        taskId: command.action.taskId,
        text
      });
      const mutationSet = {
        registryVersion: 1,
        mutations: [{
          entity: { registryVersion: 1, entityKind: "task", canonicalRef: `task/${command.action.taskId}` },
          action: { registryVersion: 1, action: "append" }
        }]
      } as const;
      const base: SemanticMutationEnvelopeV2 = {
        schema: semanticMutationEnvelopeV2Schema,
        workspaceId: material.config.workspaceId,
        operationId: {
          namespace: material.config.operationNamespace,
          clientRandom128: randomBytes(16)
        },
        binding: {
          bindingId: claims.bindingId,
          actorAxesBindingDigest: actorAxesBindingDigestV2(claims),
          deviceId: claims.deviceId,
          viewId: claims.viewId,
          sessionId: claims.sessionId,
          admissionTokenRef: { tokenId: claims.tokenId, tokenDigest }
        },
        schemaTuple: material.config.schemaTuple,
        intent: {
          kind: "typed",
          command: { registryVersion: 1, name: "task.append", version: 1 },
          canonicalPayload: { kind: "inline", size: BigInt(payload.byteLength), bytes: payload },
          canonicalPayloadDigest: canonicalPayloadDigestV2(payload),
          baseCas: [{
            entityRef: { registryVersion: 1, entityKind: "task", canonicalRef: `task/${command.action.taskId}` },
            expectedSemanticVersion: null,
            expectedStateDigest: null
          }],
          declaredPathCas: []
        },
        claimedMutationSet: mutationSet,
        claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
        claimedSemanticRequestDigest: Buffer.alloc(32)
      };
      const envelope = {
        ...base,
        claimedSemanticRequestDigest: semanticRequestDigestV2(base)
      };
      return {
        requestId: `authority-command:${randomUUID()}`,
        presentationToken: token,
        envelope: encodeSemanticMutationEnvelopeV2(envelope)
      };
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

function executorDerivedFromPreset(command: ParsedCommand, executorAgentId: string): boolean {
  const action = command.action;
  return (action.kind === "preset-run" || action.kind === "preset-action")
    && executorAgentId === `preset:${action.presetId}`;
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
