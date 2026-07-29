import { readFileSync } from "node:fs";
import {
  encodeFactRelationCommandPayloadV2,
  encodeConsentCommandPayloadV2,
  encodeSessionExecutionReviewCommandPayloadV2,
  encodeTaskDecisionModuleCommandPayloadV2,
  type AuthorizedOperationAttemptV2,
  type AuthorityIngressAdapter,
  type FactRelationCommandPayloadV2,
  type ConsentCommandPayloadV2,
  type ProductionAuthorityCommand,
  type ProductionAuthorityCompilerHostServices,
  type SessionExecutionReviewCommandPayloadV2,
  type TaskDecisionModuleCommandPayloadV2
} from "@harness-anything/application";
import {
  decisionEntityId,
  decisionSemanticMutationActions,
  parseDecisionDocument,
  sha256Text,
  taskEntityId,
  type DecisionPackage,
  type EntityRelationRecord,
  type RegistryEntityRefV2,
  type WriteOp
} from "@harness-anything/kernel";
import type { AuthorityConnectionContext } from "../../protocol/connection-context.ts";
import {
  authorityCompileRejected,
  type DaemonAuthorityAttemptCompilerV2,
  type DaemonAuthorityCommandSubmissionInputV2
} from "../authority-command-submission.ts";
import { hostedSnapshot } from "./semantic-state.ts";
import {
  canonicalIntent,
  decisionTransitionAttemptIntent,
  moduleCanonicalIntent,
  registryRef as ref
} from "./production-authority-canonical-intents.ts";
import {
  openAuthorityProductionKeyMaterial,
  type AuthorityProductionRepoConfigV1,
  type DurableAuthorityBindingRuntimeV2
} from "./authority-production-state.ts";
import { productionLifecycleAttemptIntent } from "./production-authority-lifecycle-intents.ts";
import { provenanceSessionAttemptIntent } from "./production-authority-provenance-session-intent.ts";
import { taskClaimAttemptIntent } from "./production-authority-task-claim-intent.ts";
import { productionScriptIngestAttemptIntent } from "./production-authority-script-ingest.ts";
import { productionObservedWriteAttemptIntent } from "./production-authority-observed-write-intents.ts";
import {
  createProductionAuthorityAttemptPlanner,
  type ProductionAuthorityAttemptPlanV1,
  type ProductionAuthorityOuterRecoveryWitnessV1,
  type ProductionAuthorityProgressAppendPlanV1
} from "./production-authority-attempt-plan.ts";
import {
  directTypedCommandEntityId
} from "./production-authority-pure-command-plan.ts";
export {
  productionAuthorityCommandHasPurePlan
} from "./production-authority-pure-command-plan.ts";
export {
  attemptFromAuthorityPlan,
  attemptFromProgressAppendPlan,
  productionAuthorityAttemptPlanV1Schema,
  type ProductionAuthorityAttemptPlanV1,
  type ProductionAuthorityOuterRecoveryWitnessV1,
  type ProductionAuthorityProgressAppendPlanV1
} from "./production-authority-attempt-plan.ts";
export { createProductionCanonicalSemanticState } from "./semantic-state.ts";

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

type CanonicalCompileInput =
  Omit<
    Extract<DaemonAuthorityCommandSubmissionInputV2, { readonly ingress: "generic" }>,
    "ingress"
  >;

export type ProductionProgressAppendCompileInput = CanonicalCompileInput & {
  readonly ingressAdapter?: AuthorityIngressAdapter;
};

export type ProductionAuthorityCommandPlanInput =
  Omit<CanonicalCompileInput, "canonicalEntityId">;

export interface ProductionCanonicalAttemptCompilerV2
  extends DaemonAuthorityAttemptCompilerV2 {
  readonly planCommand: (
    input: ProductionAuthorityCommandPlanInput
  ) => Promise<ProductionAuthorityAttemptPlanV1>;
  readonly activatePlannedCommand: (
    plan: ProductionAuthorityAttemptPlanV1
  ) => AuthorizedOperationAttemptV2;
  readonly activateRecoveryCommand: (
    plan: ProductionAuthorityAttemptPlanV1,
    witness: ProductionAuthorityOuterRecoveryWitnessV1
  ) => Promise<AuthorizedOperationAttemptV2>;
  readonly planProgressAppend: (
    input: CanonicalCompileInput
  ) => Promise<ProductionAuthorityProgressAppendPlanV1>;
  readonly activatePlannedProgressAppend: (
    plan: ProductionAuthorityProgressAppendPlanV1
  ) => AuthorizedOperationAttemptV2;
  readonly activateRecoveryProgressAppend: (
    plan: ProductionAuthorityProgressAppendPlanV1,
    witness: ProductionAuthorityOuterRecoveryWitnessV1
  ) => Promise<AuthorizedOperationAttemptV2>;
}

export function createProductionCanonicalAttemptCompiler(input: {
  readonly config: AuthorityProductionRepoConfigV1;
  readonly writerGeneration?: number;
  readonly keyStore: KeyMaterial["keyStore"];
  readonly keyRegistry: KeyMaterial["registry"];
  readonly bindingRuntime: DurableAuthorityBindingRuntimeV2;
  readonly context: AuthorityConnectionContext;
  readonly authoredRoot: string;
  readonly hostServices: ProductionAuthorityCompilerHostServices;
  readonly nowMs?: () => number;
  readonly randomUuid?: () => string;
  readonly random128?: () => Uint8Array;
  readonly runAuthorizedRecoveryPlan?: <Result>(
    witness: ProductionAuthorityOuterRecoveryWitnessV1,
    useDurableProceeding: (
      outcome: import("../../runtime/repo-write-outcome-schema.ts").RepoWriteProceedingOutcomeV1
    ) => Result
  ) => Promise<Result>;
}): ProductionCanonicalAttemptCompilerV2 {
  const attemptPlanner = createProductionAuthorityAttemptPlanner(input);
  const planCommand = async ({
    command,
    attribution,
    currentSession
  }: ProductionAuthorityCommandPlanInput): Promise<ProductionAuthorityAttemptPlanV1> => {
    try {
      assertTypedIngressAdapter(command.action.kind, "generic", input.hostServices);
      const resolvedEntityId = directTypedCommandEntityId(command);
      if (!resolvedEntityId) {
        throw new Error(
          `AUTHORITY_COMMAND_PLAN_ENTITY_ID_REQUIRED:${command.action.kind}`
        );
      }
      const intent = await canonicalAttemptIntent(
        command,
        currentSession,
        resolvedEntityId,
        input.authoredRoot,
        attribution.writeAttribution.actor,
        input.hostServices
      );
      return attemptPlanner.planIntent(
        command,
        attribution,
        currentSession,
        resolvedEntityId,
        intent
      );
    } catch (cause) {
      throw authorityCompileRejected(cause);
    }
  };
  const compileIntent = async (
    command: ProductionAuthorityCommand,
    attribution: Parameters<DaemonAuthorityAttemptCompilerV2["compile"]>[0]["attribution"],
    currentSession: Parameters<DaemonAuthorityAttemptCompilerV2["compile"]>[0]["currentSession"],
    canonicalEntityId: WriteOp["entityId"],
    intent: CanonicalAttemptIntent | null
  ): Promise<AuthorizedOperationAttemptV2> =>
    attemptPlanner.activatePlan(
      await attemptPlanner.planIntent(command, attribution, currentSession, canonicalEntityId, intent)
    );
  return {
    planCommand,
    activatePlannedCommand: attemptPlanner.activatePlan,
    activateRecoveryCommand: attemptPlanner.activateRecoveryPlan,
    planProgressAppend: async ({ command, attribution, currentSession, canonicalEntityId }) => {
      if (command.action.kind !== "progress-append") {
        throw new Error(`AUTHORITY_PROGRESS_APPEND_PLAN_REQUIRED:${command.action.kind}`);
      }
      const plan = await planCommand({
        command,
        attribution,
        currentSession
      });
      if (canonicalEntityId !== plan.targetEntityId) {
        throw new Error(
          `AUTHORITY_CANONICAL_ENTITY_MISMATCH:submittedEntityId=${canonicalEntityId};intentEntityId=${plan.targetEntityId}`
        );
      }
      return plan as ProductionAuthorityProgressAppendPlanV1;
    },
    activatePlannedProgressAppend: (plan) => {
      if (plan.commandKind !== "progress-append") {
        throw new Error(`AUTHORITY_PROGRESS_APPEND_PLAN_REQUIRED:${plan.commandKind}`);
      }
      return attemptPlanner.activatePlan(plan);
    },
    activateRecoveryProgressAppend: async (plan, witness) => {
      if (plan.commandKind !== "progress-append") {
        throw new Error(`AUTHORITY_PROGRESS_APPEND_PLAN_REQUIRED:${plan.commandKind}`);
      }
      return attemptPlanner.activateRecoveryPlan(plan, witness);
    },
    compile: async (submission) => {
      switch (submission.ingress) {
        case "generic": {
          const {
            command,
            attribution,
            currentSession,
            canonicalEntityId
          } = submission;
          const disposition = input.hostServices.productionAuthorityIngressFor(command.action.kind);
          const intent = disposition?.status === "typed-v2" && disposition.adapter === "generic"
            ? await canonicalAttemptIntent(command, currentSession, canonicalEntityId, input.authoredRoot, attribution.writeAttribution.actor, input.hostServices)
            : null;
          return compileIntent(command, attribution, currentSession, canonicalEntityId, intent);
        }
        case "provenance-session":
          assertTypedIngressAdapter(submission.command.action.kind, "generic", input.hostServices);
          return compileIntent(
            submission.command,
            submission.attribution,
            submission.currentSession,
            submission.operation.entityId,
            provenanceSessionAttemptIntent(
              submission.command,
              submission.currentSession,
              submission.operation
            )
          );
        case "decision-transition":
          assertTypedIngressAdapter(submission.command.action.kind, "decision-transition", input.hostServices);
          return compileIntent(
            submission.command,
            submission.attribution,
            submission.currentSession,
            submission.operation.entityId,
            decisionTransitionAttemptIntent(
              submission.command,
              submission.operation,
              input.authoredRoot
            )
          );
        case "task-claim":
          assertTypedIngressAdapter(submission.command.action.kind, "task-claim", input.hostServices);
          return compileIntent(
            submission.command,
            submission.attribution,
            submission.currentSession,
            submission.operation.entityId,
            taskClaimAttemptIntent(
              submission.command,
              submission.attribution,
              submission.currentSession,
              submission.operation,
              input.authoredRoot
            )
          );
        case "observed-write":
          assertTypedIngressAdapter(submission.command.action.kind, "observed-write", input.hostServices);
          return compileIntent(
            submission.command,
            submission.attribution,
            submission.currentSession,
            submission.operation.entityId,
            productionObservedWriteAttemptIntent(
              submission.command,
              submission.operation,
              input.authoredRoot
            )
          );
        case "script-ingest":
          return compileIntent(
            submission.command,
            submission.attribution,
            submission.currentSession,
            submission.operation.entityId,
            productionScriptIngestAttemptIntent(
              submission.command,
              submission.operation,
              input.authoredRoot
            )
          );
        default:
          return assertNeverSubmissionIngress(submission);
      }
    }
  };
}

function assertNeverSubmissionIngress(input: never): never {
  throw new Error(`AUTHORITY_SUBMISSION_INGRESS_UNHANDLED:${String(input)}`);
}

function assertTypedIngressAdapter(
  kind: string,
  expected: "generic" | "decision-transition" | "task-claim" | "observed-write",
  hostServices: ProductionAuthorityCompilerHostServices
): void {
  const disposition = hostServices.productionAuthorityIngressFor(kind);
  if (disposition?.status !== "typed-v2" || disposition.adapter !== expected) {
    throw new Error(`AUTHORITY_TYPED_INGRESS_REGISTRY_MISMATCH:${kind}:${expected}`);
  }
}

async function canonicalAttemptIntent(
  command: ProductionAuthorityCommand,
  currentSession: Parameters<DaemonAuthorityAttemptCompilerV2["compile"]>[0]["currentSession"],
  canonicalEntityId: string,
  authoredRoot: string,
  actor: Parameters<DaemonAuthorityAttemptCompilerV2["compile"]>[0]["attribution"]["writeAttribution"]["actor"],
  hostServices: ProductionAuthorityCompilerHostServices
): Promise<CanonicalAttemptIntent | null> {
  const action = command.action.kind === "decision-propose"
    ? hostServices.normalizeDecisionProposeAction(command.action)
    : command.action;
  if ((action.kind === "decision-propose" && action.decisionIdProvided)
    || (action.kind === "record-fact" && action.factIdProvided)) {
    throw new Error(`AUTHORITY_MANUAL_ENTITY_ID_FORBIDDEN: omit --id; ${action.kind} identity is generated by canonical ingress`);
  }
  if (action.kind === "new-task" && action.registerModule) {
    throw new Error("AUTHORITY_TYPED_COMMAND_UNSUPPORTED:new-task[register-module]");
  }
  const executionActor = {
    principal: { personId: actor.principal.personId },
    executor: actor.executor,
    responsibleHuman: actor.principal.personId
  };
  if (action.kind === "new-task" && action.taskId
    && !action.fromLegacyId && !action.registerModule) {
    const provenance = {
      runtime: currentSession.runtime,
      sessionId: currentSession.sessionId,
      boundAt: currentSession.detectedAt
    };
    const writeResult = hostServices.buildTaskCreateWrites({
      rootInput: { rootDir: command.rootDir, layoutOverrides: command.layoutOverrides },
      action,
      createdAt: currentSession.detectedAt,
      provenance
    });
    if (!writeResult.ok) {
      throw new Error(`AUTHORITY_TASK_CREATE_SETTINGS_INVALID:${writeResult.settingsErrorCode ?? "unknown"}`);
    }
    const writes = writeResult.writes;
    const indexBody = writes.find((write) => write.path === "INDEX.md")!.body;
    const entity = ref("task", `task/${action.taskId}`);
    const payload: TaskDecisionModuleCommandPayloadV2 = {
      schema: "task.create/v1",
      taskId: action.taskId,
      packageSlug: action.slug,
      indexBody,
      writes
    };
    const intent = canonicalIntent(
      "task.create",
      encodeTaskDecisionModuleCommandPayloadV2(payload),
      [{ entity, action: "create" }],
      [entity],
      [
        ...writes.map((write) => `tasks/${action.taskId}/${write.path}`),
        ...(action.moduleKey ? ["modules.json"] : [])
      ],
      taskEntityId(action.taskId)
    );
    if (!action.moduleKey) return intent;
    const moduleRegistrySnapshot = hostedSnapshot(authoredRoot, "modules.json");
    if (!moduleRegistrySnapshot) {
      throw new Error(`AUTHORITY_PRESET_TASK_CREATE_MODULE_NOT_FOUND:${action.moduleKey}`);
    }
    return {
      ...intent,
      declaredPathCas: [{ path: "modules.json", ...moduleRegistrySnapshot.cas }]
    };
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
  if (action.kind === "record-fact") {
    const payload: FactRelationCommandPayloadV2 = {
      schema: "fact.create/v1",
      ownerTaskId: action.taskId,
      factId: action.factId,
      statement: action.statement,
      source: hostServices.normalizedFactSource(action),
      observedAt: action.observedAt,
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
  if (action.kind === "decision-propose") {
    if (action.rejected.some((entry) => !entry.why_not)) {
      throw new Error("AUTHORITY_DECISION_REJECTED_RATIONALE_REQUIRED: add why_not to every rejected alternative and retry decision propose");
    }
    const materialized = hostServices.materializeProposedDecision(action);
    if (!materialized.ok) throw new Error(`AUTHORITY_DECISION_PROPOSE_ENRICHMENT_INVALID:${materialized.reason}`);
    const decision: DecisionPackage = {
      ...materialized.decision,
      provenance: [{ runtime: currentSession.runtime, sessionId: currentSession.sessionId, boundAt: currentSession.detectedAt }]
    };
    const entity = ref("decision", `decision/${action.decisionId}`);
    const payload: TaskDecisionModuleCommandPayloadV2 = { schema: "decision.propose/v1", decision, ...(action.body === undefined ? {} : { body: action.body }) };
    const relationEntities = decision.relations.map((relation) => ref("relation", `relation/${relation.relation_id}`));
    return canonicalIntent(
      "decision.propose", encodeTaskDecisionModuleCommandPayloadV2(payload),
      [{ entity, action: decisionSemanticMutationActions.propose }, ...relationEntities.map((relationEntity) => ({ entity: relationEntity, action: "create" }))],
      [entity, ...relationEntities], [`decisions/decision-${action.decisionId}/decision.md`], decisionEntityId(action.decisionId)
    );
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
    return moduleCanonicalIntent("module.register", encodeTaskDecisionModuleCommandPayloadV2(payload), entity, "register", action.moduleKey, authoredRoot);
  }
  if (action.kind === "module-unregister") {
    const entity = ref("module", `module/${action.moduleKey}`);
    const payload: TaskDecisionModuleCommandPayloadV2 = { schema: "module.unregister/v1", moduleKey: action.moduleKey };
    return moduleCanonicalIntent("module.unregister", encodeTaskDecisionModuleCommandPayloadV2(payload), entity, "unregister", action.moduleKey, authoredRoot);
  }
  if (action.kind === "module-step") {
    const entity = ref("module", `module/${action.moduleKey}`);
    const payload: TaskDecisionModuleCommandPayloadV2 = { schema: "module.step/v1", moduleKey: action.moduleKey, stepId: action.stepId, state: action.state };
    return moduleCanonicalIntent("module.step", encodeTaskDecisionModuleCommandPayloadV2(payload), entity, "step", action.moduleKey, authoredRoot);
  }
  if (action.kind === "decision-relate") {
    const relation: EntityRelationRecord = hostServices.decisionRelationRecord({
      decisionId: action.decisionId,
      anchor: action.anchor,
      target: action.target,
      relationType: action.relationType,
      rationale: action.rationale
    });
    const entity = ref("relation", `relation/${relation.relation_id}`);
    const host = ref("decision", `decision/${action.decisionId}`);
    const documentPath = `decisions/decision-${action.decisionId}/decision.md`;
    const snapshot = hostedSnapshot(authoredRoot, documentPath);
    if (!snapshot) throw new Error("AUTHORITY_CANONICAL_HOST_DOCUMENT_REQUIRED: run decision show and repair the source Decision before decision relate");
    const current = parseDecisionDocument(snapshot.body).decision;
    const materialized = hostServices.materializedTaskPriorityWrites(
      { rootDir: command.rootDir, layoutOverrides: command.layoutOverrides }, current, relation
    );
    if (!materialized.ok) throw new Error(`AUTHORITY_DECISION_RELATION_PRIORITY_INVALID:${materialized.error.hint}`);
    const taskWrites = materialized.writes;
    const taskSnapshots = taskWrites.map((write) => {
      const taskPath = `tasks/${write.taskId}/${write.path}`;
      const taskSnapshot = hostedSnapshot(authoredRoot, taskPath);
      if (!taskSnapshot) throw new Error(`AUTHORITY_CANONICAL_HOST_DOCUMENT_REQUIRED:${taskPath}`);
      return { write, taskPath, taskSnapshot };
    });
    const payload: TaskDecisionModuleCommandPayloadV2 = {
      schema: "decision.relation/v1", decisionId: action.decisionId, relation,
      ...(taskWrites.length === 0 ? {} : { taskWrites })
    };
    return {
      ...canonicalIntent(
        "decision.relation", encodeTaskDecisionModuleCommandPayloadV2(payload),
        [{ entity: host, action: "relation" }, { entity, action: "create" }, ...taskSnapshots.map(({ write }) => ({ entity: ref("task", `task/${write.taskId}`), action: "document" }))],
        [host, entity, ...taskSnapshots.map(({ write }) => ref("task", `task/${write.taskId}`))],
        [documentPath, ...taskSnapshots.map(({ taskPath }) => taskPath)], decisionEntityId(action.decisionId)
      ),
      declaredPathCas: [
        { path: documentPath, ...snapshot.cas },
        ...taskSnapshots.map(({ taskPath, taskSnapshot }) => ({ path: taskPath, ...taskSnapshot.cas }))
      ]
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
  if (action.kind === "task-consent-record") {
    const consentId = canonicalEntityId.replace(/^(?:entity\/)?consent\//u, "");
    const executionPath = `tasks/${action.taskId}/executions/${action.executionId}.md`;
    const snapshot = hostedSnapshot(authoredRoot, executionPath);
    if (!snapshot) throw new Error("AUTHORITY_CONSENT_EXECUTION_REQUIRED: submit the Execution before recording consent");
    const payload: ConsentCommandPayloadV2 = {
      schema: "consent.grant/v1", taskId: action.taskId, executionId: action.executionId,
      consentId,
      utterance: action.utterance ?? null,
      standingPolicyDecisionId: action.standingPolicyDecisionId ?? null,
      assertedRationale: action.assertedRationale ?? null,
      actions: action.consentActions
    };
    const execution = ref("execution", `execution/${action.taskId}/${action.executionId}`);
    const consent = ref("consent", `consent/${action.taskId}/${consentId}`);
    return {
      ...canonicalIntent("consent.grant", encodeConsentCommandPayloadV2(payload), [{ entity: consent, action: "grant" }], [execution, consent], [`tasks/${action.taskId}/consents/${consentId}.md`, executionPath], canonicalEntityId),
      declaredPathCas: [{ path: executionPath, ...snapshot.cas }]
    };
  }
  return productionLifecycleAttemptIntent({ command, currentSession, canonicalEntityId, authoredRoot, actor: executionActor }, hostServices);
}
