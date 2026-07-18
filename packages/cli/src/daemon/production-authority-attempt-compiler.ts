import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  actorAxesBindingDigestV2,
  actorAxesBindingTokenDigestV2,
  canonicalPayloadDigestV2,
  encodeFactRelationCommandPayloadV2,
  encodeConsentCommandPayloadV2,
  encodeSemanticMutationEnvelopeV2,
  encodeSessionExecutionReviewCommandPayloadV2,
  encodeTaskDecisionModuleCommandPayloadV2,
  issueActorAxesBindingV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  type FactRelationCommandPayloadV2,
  type ConsentCommandPayloadV2,
  type SessionExecutionReviewCommandPayloadV2,
  type SemanticMutationEnvelopeV2,
  type TaskDecisionModuleCommandPayloadV2
} from "../../../application/src/index.ts";
import {
  decisionEntityId,
  deriveRelationId,
  encodeCanonicalCbor,
  moduleEntityId,
  sha256Text,
  semanticMutationWireV2,
  taskEntityId,
  type CanonicalCborValue,
  type DecisionPackage,
  type EntityRelationRecord,
  type RegistryEntityRefV2,
  type WriteOp
} from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "../cli/types.ts";
import type { AuthorityConnectionContext } from "../../../daemon/src/index.ts";
import type { DaemonAuthorityAttemptCompilerV2 } from "./authority-command-submission.ts";
import {
  openAuthorityProductionKeyMaterial,
  type AuthorityProductionRepoConfigV1,
  type DurableAuthorityBindingRuntimeV2
} from "./authority-production-state.ts";
import { productionLifecycleAttemptIntent } from "./production-authority-lifecycle-intents.ts";
import { defaultCliAdapterProvider } from "../composition/adapter-registry.ts";
import { buildAuthorityPresetTaskCreateWrites, shouldUsePresetAwareNewTask } from "../commands/preset-task.ts";
import { readProjectHarnessSettings, shouldUseSettingsPresetAwareNewTask } from "../commands/settings.ts";
import { provenanceSessionAttemptIntent } from "./production-authority-provenance-session-intent.ts";

type KeyMaterial = ReturnType<typeof openAuthorityProductionKeyMaterial>;

export interface CanonicalAttemptIntent {
  readonly commandName: string;
  readonly payload: Uint8Array;
  readonly mutations: ReadonlyArray<{
    readonly entity: RegistryEntityRefV2;
    readonly action: string;
  }>;
  readonly baseRefs: ReadonlyArray<RegistryEntityRefV2>;
  readonly portablePaths: ReadonlyArray<string>;
  readonly declaredPathCas: ReadonlyArray<{
    readonly path: string;
    readonly expectedEpoch: string;
    readonly expectedRevision: bigint;
    readonly expectedBlobDigest: Uint8Array;
  }>;
  readonly physicalEntityId: string;
}

export function createProductionCanonicalAttemptCompiler(input: {
  readonly config: AuthorityProductionRepoConfigV1;
  readonly keyStore: KeyMaterial["keyStore"];
  readonly keyRegistry: KeyMaterial["registry"];
  readonly bindingRuntime: DurableAuthorityBindingRuntimeV2;
  readonly context: AuthorityConnectionContext;
  readonly authoredRoot: string;
}): DaemonAuthorityAttemptCompilerV2 {
  const compileIntent = async (
    command: ParsedCommand,
    attribution: Parameters<DaemonAuthorityAttemptCompilerV2["compile"]>[0]["attribution"],
    currentSession: Parameters<DaemonAuthorityAttemptCompilerV2["compile"]>[0]["currentSession"],
    canonicalEntityId: WriteOp["entityId"],
    intent: CanonicalAttemptIntent | null
  ) => {
      if (!intent) {
        throw new Error(
          `AUTHORITY_TYPED_COMMAND_UNSUPPORTED: production canonical ingress rejected ${command.action.kind}; ` +
          "use progress-append, decision-propose, module-register, record-fact, decision-relate, " +
          "session-export with an explicit transcript, task-claim with an execution id, " +
          "task lifecycle closeout commands, task-consent-record, or fact-invalidate"
        );
      }
      if (canonicalEntityId !== intent.physicalEntityId) {
        throw new Error(
          `AUTHORITY_CANONICAL_ENTITY_MISMATCH:submittedEntityId=${canonicalEntityId};intentEntityId=${intent.physicalEntityId}`
        );
      }
      const executorAgentId = attribution.executor?.id ?? null;
      if (executorAgentId && !input.config.allowedExecutorAgentIds.includes(executorAgentId)
        && !executorDerivedFromPreset(command, executorAgentId)) {
        throw new Error("AUTHORITY_EXECUTOR_NOT_SERVER_APPROVED");
      }
      const now = Date.now();
      const allowedEntityKinds = canonicalBindingTextSet(intent.mutations.map((mutation) => mutation.entity.entityKind));
      const allowedActions = canonicalBindingTextSet(intent.mutations.map((mutation) => mutation.action));
      const resourceScopes = [...intent.mutations.map((mutation) => ({
        kind: "entity-ref" as const,
        entityRef: mutation.entity
      })), ...intent.portablePaths.map((portablePath) => ({
        kind: "portable-path" as const,
        path: portablePath
      }))].sort((left, right) => Buffer.compare(
        Buffer.from(encodeCanonicalCbor(resourceScopeWire(left))),
        Buffer.from(encodeCanonicalCbor(resourceScopeWire(right)))
      ));
      const claims = {
        tokenId: `${input.config.admissionTokenRef}:${randomUUID()}`,
        bindingId: `binding:${randomUUID()}`,
        principalPersonId: input.context.actor.personId,
        executorAgentId,
        workspaceId: input.config.workspaceId,
        deviceId: input.config.deviceId,
        viewId: input.config.viewId,
        sessionId: currentSession.sessionId,
        allowedEntityKinds,
        allowedActions,
        resourceScopes,
        pathFootprint: null,
        maxBytes: BigInt(intent.payload.byteLength) + 4_096n,
        maxMutations: intent.mutations.length,
        maxOperations: 1,
        authorityGeneration: BigInt(input.config.authorityGeneration),
        channelNonceDigest: input.context.channelBinding.digest,
        schemaTuple: input.config.schemaTuple,
        issuedAt: BigInt(now),
        notBefore: BigInt(now),
        expiresAt: BigInt(now + 5 * 60_000),
        revocationEpochs: executorAgentId === null
          ? { ...input.config.revocationEpochs, executor: 0n }
          : input.config.revocationEpochs
      };
      const token = issueActorAxesBindingV2(
        claims,
        input.keyStore.signingProfile(input.keyRegistry, now)
      );
      input.bindingRuntime.registerIssuedToken({ claims, token, attribution: attribution.writeAttribution });
      const tokenDigest = actorAxesBindingTokenDigestV2(token);
      const mutationSet = {
        registryVersion: 1,
        mutations: intent.mutations.map((mutation) => ({
          entity: mutation.entity,
          action: { registryVersion: 1, action: mutation.action }
        })).sort((left, right) => Buffer.compare(
          Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(left))),
          Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(right)))
        ))
      } as const;
      const base: SemanticMutationEnvelopeV2 = {
        schema: semanticMutationEnvelopeV2Schema,
        workspaceId: input.config.workspaceId,
        operationId: { namespace: input.config.operationNamespace, clientRandom128: randomBytes(16) },
        binding: {
          bindingId: claims.bindingId,
          actorAxesBindingDigest: actorAxesBindingDigestV2(claims),
          deviceId: claims.deviceId,
          viewId: claims.viewId,
          sessionId: claims.sessionId,
          admissionTokenRef: { tokenId: claims.tokenId, tokenDigest }
        },
        schemaTuple: input.config.schemaTuple,
        intent: {
          kind: "typed",
          command: { registryVersion: 1, name: intent.commandName, version: 1 },
          canonicalPayload: { kind: "inline", size: BigInt(intent.payload.byteLength), bytes: intent.payload },
          canonicalPayloadDigest: canonicalPayloadDigestV2(intent.payload),
          baseCas: intent.baseRefs.map((entityRef) => ({
            entityRef,
            expectedSemanticVersion: null,
            expectedStateDigest: null
          })),
          declaredPathCas: intent.declaredPathCas
        },
        claimedMutationSet: mutationSet,
        claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
        claimedSemanticRequestDigest: Buffer.alloc(32)
      };
      const envelope = { ...base, claimedSemanticRequestDigest: semanticRequestDigestV2(base) };
      return {
        requestId: `authority-command:${randomUUID()}`,
        presentationToken: token,
        envelope: encodeSemanticMutationEnvelopeV2(envelope)
      };
  };
  return {
    compile: async ({ command, attribution, currentSession, canonicalEntityId }) => {
      const intent = await canonicalAttemptIntent(command, currentSession, canonicalEntityId, input.authoredRoot, attribution.writeAttribution.actor);
      return compileIntent(command, attribution, currentSession, canonicalEntityId, intent);
    },
    compileProvenanceSession: async ({ command, attribution, currentSession, operation }) => compileIntent(
      command,
      attribution,
      currentSession,
      operation.entityId,
      provenanceSessionAttemptIntent(command, currentSession, operation)
    )
  };
}

async function canonicalAttemptIntent(
  command: ParsedCommand,
  currentSession: Parameters<DaemonAuthorityAttemptCompilerV2["compile"]>[0]["currentSession"],
  canonicalEntityId: string,
  authoredRoot: string,
  actor: Parameters<DaemonAuthorityAttemptCompilerV2["compile"]>[0]["attribution"]["writeAttribution"]["actor"]
): Promise<CanonicalAttemptIntent | null> {
  const action = command.action;
  const executionActor = {
    principal: { personId: actor.principal.personId },
    executor: actor.executor,
    responsibleHuman: actor.principal.personId
  };
  if (action.kind === "new-task" && action.taskId
    && !action.fromLegacyId && !action.moduleKey && !action.registerModule) {
    const provenance = {
      runtime: currentSession.runtime,
      sessionId: currentSession.sessionId,
      boundAt: currentSession.detectedAt
    };
    const settingsResult = readProjectHarnessSettings({ rootDir: command.rootDir, layoutOverrides: command.layoutOverrides }, "new-task");
    if (!settingsResult.ok) throw new Error(`AUTHORITY_TASK_CREATE_SETTINGS_INVALID:${settingsResult.result.error?.code ?? "unknown"}`);
    const writes = shouldUsePresetAwareNewTask(action) || shouldUseSettingsPresetAwareNewTask(settingsResult.settings)
      ? buildAuthorityPresetTaskCreateWrites(
        { rootDir: command.rootDir, layoutOverrides: command.layoutOverrides },
        action,
        settingsResult.settings,
        currentSession.detectedAt,
        provenance
      )
      : defaultCliAdapterProvider().buildLocalTaskCreateWrites({
        taskId: action.taskId,
        title: action.title,
        allowManualId: action.allowManualId,
        slug: action.slug,
        parent: action.parent,
        workKind: action.workKind,
        riskTier: action.riskTier,
        urgency: action.urgency
      }, currentSession.detectedAt, provenance);
    const indexBody = writes.find((write) => write.path === "INDEX.md")!.body;
    const entity = ref("task", `task/${action.taskId}`);
    const payload: TaskDecisionModuleCommandPayloadV2 = {
      schema: "task.create/v1",
      taskId: action.taskId,
      packageSlug: action.slug,
      indexBody,
      writes
    };
    return canonicalIntent(
      "task.create",
      encodeTaskDecisionModuleCommandPayloadV2(payload),
      [{ entity, action: "create" }],
      [entity],
      writes.map((write) => `tasks/${action.taskId}/${write.path}`),
      taskEntityId(action.taskId)
    );
  }
  if (action.kind === "progress-append") {
    const evidence = action.evidence?.map((entry) => `Evidence: ${entry.type}:${entry.path}:${entry.summary}`).join("\n");
    const payload: TaskDecisionModuleCommandPayloadV2 = {
      schema: "task.append/v1",
      taskId: action.taskId,
      text: evidence ? `${action.text}\n\n${evidence}` : action.text
    };
    const entity = ref("task", `task/${action.taskId}`);
    return {
      commandName: "task.append",
      payload: encodeTaskDecisionModuleCommandPayloadV2(payload),
      mutations: [{ entity, action: "append" }],
      baseRefs: [entity],
      portablePaths: [`tasks/${action.taskId}/progress.md`],
      declaredPathCas: [],
      physicalEntityId: taskEntityId(action.taskId)
    };
  }
  if (action.kind === "record-fact" && action.factId) {
    const payload: FactRelationCommandPayloadV2 = {
      schema: "fact.create/v1",
      ownerTaskId: action.taskId,
      factId: action.factId,
      statement: action.statement,
      source: action.source,
      observedAt: action.observedAt ?? new Date().toISOString(),
      confidence: action.confidence,
      memoryClass: action.memoryClass,
      memoryTags: action.memoryTags,
      provenance: [{
        runtime: currentSession.runtime,
        sessionId: currentSession.sessionId,
        boundAt: currentSession.detectedAt
      }]
    };
    const entity = ref("fact", `fact/${action.taskId}/${action.factId}`);
    return {
      commandName: "fact.create",
      payload: encodeFactRelationCommandPayloadV2(payload),
      mutations: [{ entity, action: "create" }],
      baseRefs: [entity],
      portablePaths: [`tasks/${action.taskId}/facts.md`],
      declaredPathCas: [],
      physicalEntityId: taskEntityId(action.taskId)
    };
  }
  if (action.kind === "decision-propose" && action.decisionId) {
    if (action.rejected.some((entry) => !entry.why_not)) {
      throw new Error("AUTHORITY_DECISION_REJECTED_RATIONALE_REQUIRED: add why_not to every rejected alternative and retry decision propose");
    }
    const decision: DecisionPackage = {
      schema: "decision-package/v1",
      decision_id: action.decisionId,
      title: action.title,
      state: "proposed",
      riskTier: action.riskTier,
      urgency: action.urgency,
      vertical: "software/coding",
      preset: "architecture-decision",
      applies_to: { modules: action.modules, productLines: action.productLines },
      proposedAt: currentSession.detectedAt,
      provenance: [{ runtime: currentSession.runtime, sessionId: currentSession.sessionId, boundAt: currentSession.detectedAt }],
      question: action.question,
      chosen: action.chosen.map((entry, index) => ({ id: entry.id ?? `CH${index + 1}`, text: entry.text, ...(entry.load_bearing === undefined ? {} : { load_bearing: entry.load_bearing }) })),
      rejected: action.rejected.map((entry, index) => ({ id: entry.id ?? `RJ${index + 1}`, text: entry.text, why_not: entry.why_not! })),
      claims: action.claims.map((entry, index) => ({ id: entry.id ?? `C${index + 1}`, text: entry.text, ...(entry.load_bearing === undefined ? {} : { load_bearing: entry.load_bearing }), ...(entry.fulfillment === undefined ? {} : { fulfillment: entry.fulfillment }) })),
      relations: []
    };
    const entity = ref("decision", `decision/${action.decisionId}`);
    const payload: TaskDecisionModuleCommandPayloadV2 = { schema: "decision.propose/v1", decision, ...(action.body === undefined ? {} : { body: action.body }) };
    return canonicalIntent("decision.propose", encodeTaskDecisionModuleCommandPayloadV2(payload), [{ entity, action: "propose" }], [entity], [`decisions/decision-${action.decisionId}/decision.md`], decisionEntityId(action.decisionId));
  }
  if (action.kind === "module-register") {
    const entity = ref("module", `module/${action.moduleKey}`);
    const payload: TaskDecisionModuleCommandPayloadV2 = {
      schema: "module.register/v1",
      module: {
        key: action.moduleKey, title: action.title, status: action.status ?? "active",
        scopes: [action.scope], shared: action.shared, dependsOn: action.dependsOn, steps: [],
        ...(action.prefix === undefined ? {} : { prefix: action.prefix }),
        ...(action.branch === undefined ? {} : { branch: action.branch }),
        ...(action.owner === undefined ? {} : { owner: action.owner }),
        ...(action.currentStep === undefined ? {} : { currentStep: action.currentStep })
      }
    };
    return canonicalIntent("module.register", encodeTaskDecisionModuleCommandPayloadV2(payload), [{ entity, action: "register" }], [entity], ["modules.json"], moduleEntityId(action.moduleKey));
  }
  if (action.kind === "decision-relate") {
    const identity = {
      source: action.anchor,
      target: action.target,
      type: action.relationType,
      direction: "directed" as const
    };
    const relation: EntityRelationRecord = {
      relation_id: deriveRelationId(identity), ...identity, strength: "strong", origin: "declared",
      rationale: action.rationale, state: "active"
    };
    const entity = ref("relation", `relation/${relation.relation_id}`);
    const host = ref("decision", `decision/${action.decisionId}`);
    const documentPath = `decisions/decision-${action.decisionId}/decision.md`;
    const snapshot = hostedSnapshot(authoredRoot, documentPath);
    if (!snapshot) throw new Error("AUTHORITY_CANONICAL_HOST_DOCUMENT_REQUIRED: run decision show and repair the source Decision before decision relate");
    const payload: TaskDecisionModuleCommandPayloadV2 = { schema: "decision.relation/v1", decisionId: action.decisionId, relation };
    return {
      ...canonicalIntent("decision.relation", encodeTaskDecisionModuleCommandPayloadV2(payload), [{ entity: host, action: "relation" }, { entity, action: "create" }], [host, entity], [documentPath], decisionEntityId(action.decisionId)),
      declaredPathCas: [{ path: documentPath, ...snapshot.cas }]
    };
  }
  if (action.kind === "session-export" && action.sessionId && action.runtime && action.transcriptFile) {
    const body = readFileSync(action.transcriptFile, "utf8");
    const digest = sha256Text(body);
    const payload: SessionExecutionReviewCommandPayloadV2 = {
      schema: "session.export/v1",
      manifest: {
        schema: "session-entity/v1", sessionId: action.sessionId, lifecycle: "sealed", archiveStatus: "complete",
        runtime: action.runtime, source: action.source ?? "manual", detectedAt: action.detectedAt ?? currentSession.detectedAt,
        exportedAt: currentSession.detectedAt,
        bodyRef: { store: "authored-cas/v1", ref: `harness/objects/sha256/${digest.slice(0, 2)}/${digest.slice(2)}`, sha256: digest, size: Buffer.byteLength(body), mediaType: "text/markdown; charset=utf-8" },
        snapshot: { capturedAt: currentSession.detectedAt, completeness: "complete", captureRange: { messageCount: 0 }, privacyScan: { scannerVersion: "production-authority/v1", passed: true, findings: [] } }
      },
      body
    };
    const entity = ref("session", `session/${action.sessionId}`);
    return canonicalIntent("session.export", encodeSessionExecutionReviewCommandPayloadV2(payload), [{ entity, action: "export" }], [entity], [`sessions/${action.sessionId}.md`, `objects/sha256/${digest.slice(0, 2)}/${digest.slice(2)}`], `entity/session/${action.sessionId}`);
  }
  if (action.kind === "task-claim" && action.executionId) {
    const executionId = action.executionId;
    const payload: SessionExecutionReviewCommandPayloadV2 = {
      schema: "execution.claim/v1", taskId: action.taskId,
      execution: {
        schema: "execution/v2", execution_id: executionId, task_ref: `task/${action.taskId}`, state: "active",
        primary_actor: executionActor, claimed_at: currentSession.detectedAt, submitted_at: null, closed_at: null,
        session_bindings: [], outputs: [], submission: null
      }
    };
    const entity = ref("execution", `execution/${action.taskId}/${executionId}`);
    return canonicalIntent("execution.claim", encodeSessionExecutionReviewCommandPayloadV2(payload), [{ entity, action: "claim" }], [entity], [`tasks/${action.taskId}/executions/${executionId}.md`], `execution/${executionId}`);
  }
  if (action.kind === "task-review-execution" && !action.consentId && action.verdict !== "approved") {
    const reviewId = canonicalEntityId.replace(/^review\//u, "");
    const payload: SessionExecutionReviewCommandPayloadV2 = {
      schema: action.verdict === "dismissed" ? "review.dismiss/v1" : "review.create/v1",
      taskId: action.taskId,
      review: {
        schema: "review/v3", review_id: reviewId, task_ref: `task/${action.taskId}`,
        execution_ref: `execution/${action.taskId}/${action.executionId}`, reviewer_actor: executionActor,
        reviewer_session_ref: `session/${currentSession.sessionId}`, findings: action.findings,
        evidence_checked: action.evidenceChecked, rationale: action.rationale, verdict: action.verdict,
        archive_warnings_acknowledged: action.archiveWarningsAcknowledged,
        reviewed_at: currentSession.detectedAt, approval_basis: null
      }
    };
    const mutationAction = action.verdict === "dismissed" ? "dismiss" : "create";
    const entity = ref("review", `review/${action.taskId}/${reviewId}`);
    return canonicalIntent(`review.${mutationAction}`, encodeSessionExecutionReviewCommandPayloadV2(payload), [{ entity, action: mutationAction }], [entity], [`tasks/${action.taskId}/reviews/${reviewId}.md`], `review/${reviewId}`);
  }
  if (action.kind === "task-consent-record") {
    const consentId = canonicalEntityId.replace(/^consent\//u, "");
    const executionPath = `tasks/${action.taskId}/executions/${action.executionId}.md`;
    const snapshot = hostedSnapshot(authoredRoot, executionPath);
    if (!snapshot) throw new Error("AUTHORITY_CONSENT_EXECUTION_REQUIRED: submit the Execution before recording consent");
    const payload: ConsentCommandPayloadV2 = {
      schema: "consent.grant/v1", taskId: action.taskId, executionId: action.executionId,
      consentId, utterance: action.utterance, actions: action.consentActions ?? ["approve_execution"]
    };
    const execution = ref("execution", `execution/${action.taskId}/${action.executionId}`);
    const consent = ref("consent", `consent/${action.taskId}/${consentId}`);
    return {
      ...canonicalIntent("consent.grant", encodeConsentCommandPayloadV2(payload), [{ entity: consent, action: "grant" }], [execution, consent], [`tasks/${action.taskId}/consents/${consentId}.md`, executionPath], `consent/${consentId}`),
      declaredPathCas: [{ path: executionPath, ...snapshot.cas }]
    };
  }
  return productionLifecycleAttemptIntent({ command, currentSession, canonicalEntityId, authoredRoot });
}

function canonicalIntent(
  commandName: string,
  payload: Uint8Array,
  mutations: CanonicalAttemptIntent["mutations"],
  baseRefs: ReadonlyArray<RegistryEntityRefV2>,
  portablePaths: ReadonlyArray<string>,
  physicalEntityId: string
): CanonicalAttemptIntent {
  return { commandName, payload, mutations, baseRefs, portablePaths, declaredPathCas: [], physicalEntityId };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function resourceScopeWire(scope: {
  readonly kind: "entity-ref";
  readonly entityRef: RegistryEntityRefV2;
} | {
  readonly kind: "portable-path";
  readonly path: string;
}): CanonicalCborValue {
  if (scope.kind === "portable-path") return { kind: scope.kind, path: scope.path };
  return {
    kind: scope.kind,
    entityRef: {
      registryVersion: scope.entityRef.registryVersion,
      entityKind: scope.entityRef.entityKind,
      canonicalRef: scope.entityRef.canonicalRef
    }
  };
}

function canonicalBindingTextSet(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].sort((left, right) => Buffer.compare(
    Buffer.from(encodeCanonicalCbor(left)),
    Buffer.from(encodeCanonicalCbor(right))
  ));
}

function hostedSnapshot(authoredRoot: string, portablePath: string): {
  readonly body: string;
  readonly cas: { readonly expectedEpoch: string; readonly expectedRevision: bigint; readonly expectedBlobDigest: Uint8Array };
} | null {
  const absolute = path.join(authoredRoot, portablePath);
  if (!existsSync(absolute)) return null;
  const body = readFileSync(absolute, "utf8");
  return {
    body,
    cas: { expectedEpoch: sha256Text(body), expectedRevision: 0n, expectedBlobDigest: Buffer.from(sha256Text(body), "hex") }
  };
}

export function createProductionCanonicalSemanticState(authoredRoot: string) {
  return {
    readEntityBase: async () => null,
    readHostedDocument: async (portablePath: string) => {
      const snapshot = hostedSnapshot(authoredRoot, portablePath);
      return snapshot ? {
        body: snapshot.body,
        epoch: snapshot.cas.expectedEpoch,
        revision: snapshot.cas.expectedRevision,
        blobDigest: snapshot.cas.expectedBlobDigest
      } : null;
    }
  };
}

function executorDerivedFromPreset(command: ParsedCommand, executorAgentId: string): boolean {
  const action = command.action;
  return action.kind === "preset-entrypoint"
    && executorAgentId === `preset:${action.presetId}`;
}
