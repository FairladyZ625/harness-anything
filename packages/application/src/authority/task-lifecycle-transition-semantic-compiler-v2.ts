import { Schema } from "effect";
import {
  computeExecutionConsentPin,
  consentDeclaration,
  executionDeclaration,
  reviewDeclaration,
  sha256Text,
  stablePayloadHash,
  type ConsentRecord,
  type EntityId,
  type ExecutionRecord,
  type HarnessLayoutInput,
  type RegistryMutationPlanInput,
  type ReviewRecord,
  type WriteOp
} from "@harness-anything/kernel";
import {
  consentSourceRequest,
  isTranscriptConsentAnchoredToSession,
  resolveConsentAuthorization
} from "../consent-source-resolution.ts";
import {
  assertConsentActions,
  consentSnapshot,
  createConsentRecord,
  DEFAULT_HUMAN_CONSENT_ACTIONS,
  DEFAULT_HUMAN_CONSENT_TTL_MS
} from "../execution-consent-helpers.ts";
import { executionHasArchiveWarnings } from "../execution-review-helpers.ts";
import { assertReviewEvidenceBelongsToExecution } from "../review-execution-service.ts";
import { decodeTaskCompletionEvidence } from "../task-completion-authority.ts";
import type { CanonicalTaskMutationPlan } from "../task-lifecycle-transition-service.ts";
import type { RuntimeLogOptions } from "../runtime-session-logs.ts";
import {
  decodeTaskLifecycleTransitionCommandPayloadV2
} from "./task-lifecycle-transition-command-v2.ts";
import { authorityConsentTranscriptCandidatesV2 } from "./authority-consent-transcript-candidates-v2.ts";
import type { HostedDocumentSnapshotV2 } from "./fact-relation-semantic-compiler-v2.ts";
import {
  type AuthorityAlreadySatisfiedStateProofV1,
  type AuthoritySemanticCompilerContextV2,
  type AuthoritySemanticCompilerV2,
  type RegistryEntityRefV2
} from "./semantic-mutation-envelope-v2.ts";
import { taskTransitionAlreadySatisfiedVerifierV1 } from "./task-transition-already-satisfied-v1.ts";
import { absentHostedDocumentSnapshotV2 } from "./session-execution-review-semantic-helpers-v2.ts";
import {
  semanticAdmissionV2 as admission,
  semanticMutationPlanV2 as mutationPlan,
  verifySemanticBaseCasV2,
  verifySemanticPathCasV2
} from "./semantic-authority-helpers-v2.ts";
import {
  assertSameCheckpoint,
  assertVerifiedWitnessBindings,
  contractSnapshot,
  taskLifecycleTransitionCompilerNever,
  taskLifecycleTransitionContextNow,
  taskLifecycleTransitionCheckpointDeclaration,
  taskLifecycleTransitionRefV2,
  transitionCheckpoint,
  witnessSnapshots,
  type TaskLifecycleTransitionAuthorityStateV2,
  type TransitionCheckpoint
} from "./task-lifecycle-transition-semantic-support-v2.ts";

export {
  decodeTaskLifecycleTransitionCheckpoint,
  taskLifecycleTransitionCheckpointDeclaration
} from "./task-lifecycle-transition-semantic-support-v2.ts";
export type { TaskLifecycleTransitionAuthorityStateV2 } from "./task-lifecycle-transition-semantic-support-v2.ts";

export { taskLifecycleTransitionTypedCommandsV2 } from "./task-lifecycle-transition-command-v2.ts";
export { encodeTaskLifecycleTransitionCommandPayloadV2 } from "./task-lifecycle-transition-command-v2.ts";

export interface TaskLifecycleTransitionSemanticCompilerV2Options {
  readonly state: TaskLifecycleTransitionAuthorityStateV2;
  readonly rootInput: HarnessLayoutInput;
  readonly runtimeLogOptions?: RuntimeLogOptions;
  readonly consentTtlMs?: number;
}

export function makeTaskLifecycleTransitionSemanticCompilerV2(
  options: TaskLifecycleTransitionSemanticCompilerV2Options
): AuthoritySemanticCompilerV2 {
  return {
    compile: async (envelope, context) => {
      if (!context) throw admission("AUTHORITY_COMPILER_CONTEXT_REQUIRED");
      const { payload, decodedBytes } = decodeTaskLifecycleTransitionCommandPayloadV2(envelope);
      const compiled = await compilePlan(options, payload.plan, context);
      await verifySemanticBaseCasV2(
        options.state,
        envelope.intent.kind === "typed" ? envelope.intent.baseCas : [],
        compiled.requiredBaseRefs
      );
      verifySemanticPathCasV2(
        envelope.intent.kind === "typed" ? envelope.intent.declaredPathCas : [],
        compiled.requiredPathSnapshots
      );
      return {
        mutationPlan: compiled.mutationPlan,
        operation: compiled.operation,
        decodedBytes,
        ...(compiled.alreadySatisfied ? { alreadySatisfied: compiled.alreadySatisfied } : {})
      };
    }
  };
}

interface CompiledTransition {
  readonly mutationPlan: RegistryMutationPlanInput;
  readonly operation: WriteOp;
  readonly requiredBaseRefs: ReadonlyArray<RegistryEntityRefV2>;
  readonly requiredPathSnapshots: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }>;
  readonly alreadySatisfied?: {
    readonly verify: () => Promise<AuthorityAlreadySatisfiedStateProofV1 | undefined>;
  };
}

async function compilePlan(
  options: TaskLifecycleTransitionSemanticCompilerV2Options,
  plan: CanonicalTaskMutationPlan,
  context: AuthoritySemanticCompilerContextV2
): Promise<CompiledTransition> {
  assertVerifiedWitnessBindings(plan);
  switch (plan.kind) {
    case "execution-review": return compileExecutionReview(options, plan, context);
    case "accepted-replay": return compileAcceptedReplay(options, plan);
    case "commit-anchor": return compileCommitAnchor(options, plan);
    case "already-committed": return compileAlreadyCommitted(options, plan);
    default: return taskLifecycleTransitionCompilerNever(plan);
  }
}

async function compileExecutionReview(
  options: TaskLifecycleTransitionSemanticCompilerV2Options,
  plan: Extract<CanonicalTaskMutationPlan, { readonly kind: "execution-review" }>,
  context: AuthoritySemanticCompilerContextV2
): Promise<CompiledTransition> {
  const approval = plan.command.approval;
  if (!approval) throw admission("TASK_LIFECYCLE_APPROVAL_REQUIRED");
  const executionPath = transitionTaskPath(plan.taskId, `executions/${plan.executionId}.md`);
  const taskIndexPath = transitionTaskPath(plan.taskId, "INDEX.md");
  const reviewPath = transitionTaskPath(plan.taskId, `reviews/${plan.reviewId}.md`);
  const consentPath = transitionTaskPath(plan.taskId, `consents/${plan.consentId}.md`);
  const checkpointPath = transitionTaskPath(plan.taskId, `transitions/${plan.transitionId}.json`);
  const executionSnapshot = await requiredTransitionSnapshot(options.state, executionPath, "EXECUTION_DOCUMENT_NOT_FOUND");
  const taskSnapshot = await requiredTransitionSnapshot(options.state, taskIndexPath, "TASK_INDEX_DOCUMENT_NOT_FOUND");
  const checkpointSnapshot = await options.state.readHostedDocument(checkpointPath);
  if (checkpointSnapshot) throw admission("TASK_LIFECYCLE_TRANSITION_ALREADY_EXISTS");
  if (await options.state.readHostedDocument(reviewPath)) throw admission("REVIEW_ALREADY_EXISTS");
  const execution = lifecycleDecodeExecution(executionSnapshot.body, plan.taskId, plan.executionId, "submitted");
  if (!/^  status:\s*in_review$/mu.test(taskSnapshot.body)) throw admission("REVIEW_TASK_NOT_IN_REVIEW");
  if (executionHasArchiveWarnings(execution) && !approval.archiveWarningsAcknowledged) {
    throw admission("REVIEW_ARCHIVE_WARNING_ACK_REQUIRED");
  }
  assertCompletionReviewEvidence(execution, approval.evidenceChecked);
  const storedConsent = await options.state.readHostedDocument(consentPath);
  const now = taskLifecycleTransitionContextNow(context);
  const open = storedConsent
    ? existingConsent(storedConsent.body, plan, execution, context, now)
    : await createPlanConsent(options, plan, execution, context, now);
  const consumed = decodeConsent({
    ...open,
    state: "consumed",
    consumed_by: `review/${plan.taskId}/${plan.reviewId}`,
    consumed_at: now
  });
  const accepted = decodeExecutionRecord({ ...execution, state: "accepted", closed_at: now });
  const review: ReviewRecord = {
    schema: "review/v3",
    review_id: plan.reviewId,
    task_ref: `task/${plan.taskId}`,
    execution_ref: `execution/${plan.taskId}/${plan.executionId}`,
    reviewer_actor: context.actor,
    reviewer_session_ref: `session/${context.sessionId}`,
    findings: approval.findings,
    evidence_checked: approval.evidenceChecked,
    rationale: approval.rationale,
    verdict: "approved",
    archive_warnings_acknowledged: approval.archiveWarningsAcknowledged,
    approval_basis: {
      kind: "human-consent",
      consent_ref: `consent/${plan.taskId}/${plan.consentId}`,
      consent_snapshot: consentSnapshot(consumed)
    },
    reviewed_at: now
  };
  const checkpoint = transitionCheckpoint(plan, "accepted");
  const contract = await contractSnapshot(options.state, plan);
  const relevantWitnessSnapshots = await witnessSnapshots(options.state, plan);
  return compiledTransition({
    plan,
    checkpoint,
    companionWrites: [
      { taskId: plan.taskId, path: `consents/${plan.consentId}.md`, body: consentDeclaration.documentCodec.encode(consumed) },
      { taskId: plan.taskId, path: `reviews/${plan.reviewId}.md`, body: reviewDeclaration.documentCodec.encode(review) },
      { taskId: plan.taskId, path: `executions/${plan.executionId}.md`, body: executionDeclaration.documentCodec.encode(accepted) },
      { taskId: plan.taskId, path: "INDEX.md", body: doneTaskBody(taskSnapshot.body) }
    ],
    preconditions: [
      precondition(plan.taskId, `transitions/${plan.transitionId}.json`, null),
      precondition(plan.taskId, `executions/${plan.executionId}.md`, executionSnapshot.body),
      precondition(plan.taskId, `reviews/${plan.reviewId}.md`, null),
      precondition(plan.taskId, `consents/${plan.consentId}.md`, storedConsent?.body ?? null),
      precondition(plan.taskId, "INDEX.md", taskSnapshot.body),
      precondition(plan.taskId, "task-contract.json", contract?.body ?? null),
      ...relevantWitnessSnapshots.map(({ relativePath, snapshot }) => precondition(plan.taskId, relativePath, snapshot.body))
    ],
    requiredPathSnapshots: [
      { path: executionPath, snapshot: executionSnapshot },
      { path: taskIndexPath, snapshot: taskSnapshot },
      { path: checkpointPath, snapshot: absentHostedDocumentSnapshotV2(checkpointPath) },
      { path: reviewPath, snapshot: absentHostedDocumentSnapshotV2(reviewPath) },
      ...(storedConsent ? [{ path: consentPath, snapshot: storedConsent }] : [{ path: consentPath, snapshot: absentHostedDocumentSnapshotV2(consentPath) }]),
      { path: transitionTaskPath(plan.taskId, "task-contract.json"), snapshot: contract ?? absentHostedDocumentSnapshotV2(transitionTaskPath(plan.taskId, "task-contract.json")) }
    ],
    mutations: [
      ...(storedConsent ? [] : [{ entityKind: "consent", identity: { taskId: plan.taskId, consentId: plan.consentId }, action: "grant" }]),
      { entityKind: "consent", identity: { taskId: plan.taskId, consentId: plan.consentId }, action: "consume" },
      { entityKind: "review", identity: { taskId: plan.taskId, reviewId: plan.reviewId }, action: "record" },
      { entityKind: "execution", identity: { taskId: plan.taskId, executionId: plan.executionId }, action: "close" },
      taskTransitionMutation(plan.taskId),
      checkpointMutation(plan)
    ],
    baseRefs: [
      taskLifecycleTransitionRefV2("execution", `execution/${plan.taskId}/${plan.executionId}`),
      taskLifecycleTransitionRefV2("consent", `consent/${plan.taskId}/${plan.consentId}`),
      taskLifecycleTransitionRefV2("review", `review/${plan.taskId}/${plan.reviewId}`),
      taskLifecycleTransitionRefV2("task", `task/${plan.taskId}`)
    ]
  });
}

function assertCompletionReviewEvidence(
  execution: Pick<ExecutionRecord, "execution_id" | "outputs">,
  evidenceChecked: ReadonlyArray<string>
): void {
  try {
    assertReviewEvidenceBelongsToExecution(execution, evidenceChecked);
  } catch {
    throw admission("REVIEW_EVIDENCE_NOT_IN_EXECUTION");
  }
}

async function compileAcceptedReplay(
  options: TaskLifecycleTransitionSemanticCompilerV2Options,
  plan: Extract<CanonicalTaskMutationPlan, { readonly kind: "accepted-replay" }>
): Promise<CompiledTransition> {
  const executionPath = transitionTaskPath(plan.taskId, `executions/${plan.executionId}.md`);
  const taskIndexPath = transitionTaskPath(plan.taskId, "INDEX.md");
  const reviewPath = transitionTaskPath(plan.taskId, `reviews/${plan.approvedReviewId}.md`);
  const consentPath = transitionTaskPath(plan.taskId, `consents/${plan.consumedConsentId}.md`);
  const checkpointPath = transitionTaskPath(plan.taskId, `transitions/${plan.transitionId}.json`);
  const [executionSnapshot, taskSnapshot, reviewSnapshot, consentSnapshotDocument] = await Promise.all([
    requiredTransitionSnapshot(options.state, executionPath, "EXECUTION_DOCUMENT_NOT_FOUND"),
    requiredTransitionSnapshot(options.state, taskIndexPath, "TASK_INDEX_DOCUMENT_NOT_FOUND"),
    requiredTransitionSnapshot(options.state, reviewPath, "REVIEW_DOCUMENT_NOT_FOUND"),
    requiredTransitionSnapshot(options.state, consentPath, "CONSENT_DOCUMENT_NOT_FOUND")
  ]);
  const execution = lifecycleDecodeExecution(executionSnapshot.body, plan.taskId, plan.executionId, "accepted");
  assertAcceptedApproval(plan, execution, reviewSnapshot.body, consentSnapshotDocument.body);
  const checkpointSnapshot = await options.state.readHostedDocument(checkpointPath);
  if (checkpointSnapshot) assertSameCheckpoint(checkpointSnapshot.body, transitionCheckpoint(plan, "accepted"));
  const contract = await contractSnapshot(options.state, plan);
  const relevantWitnessSnapshots = await witnessSnapshots(options.state, plan);
  return compiledTransition({
    plan,
    checkpoint: transitionCheckpoint(plan, "accepted"),
    companionWrites: [
      { taskId: plan.taskId, path: `executions/${plan.executionId}.md`, body: executionSnapshot.body },
      { taskId: plan.taskId, path: "INDEX.md", body: doneTaskBody(taskSnapshot.body) }
    ],
    preconditions: [
      precondition(plan.taskId, `transitions/${plan.transitionId}.json`, checkpointSnapshot?.body ?? null),
      precondition(plan.taskId, `executions/${plan.executionId}.md`, executionSnapshot.body),
      precondition(plan.taskId, `reviews/${plan.approvedReviewId}.md`, reviewSnapshot.body),
      precondition(plan.taskId, `consents/${plan.consumedConsentId}.md`, consentSnapshotDocument.body),
      precondition(plan.taskId, "INDEX.md", taskSnapshot.body),
      precondition(plan.taskId, "task-contract.json", contract?.body ?? null),
      ...relevantWitnessSnapshots.map(({ relativePath, snapshot }) => precondition(plan.taskId, relativePath, snapshot.body))
    ],
    requiredPathSnapshots: [
      { path: executionPath, snapshot: executionSnapshot }, { path: taskIndexPath, snapshot: taskSnapshot },
      { path: reviewPath, snapshot: reviewSnapshot }, { path: consentPath, snapshot: consentSnapshotDocument },
      { path: checkpointPath, snapshot: checkpointSnapshot ?? absentHostedDocumentSnapshotV2(checkpointPath) },
      { path: transitionTaskPath(plan.taskId, "task-contract.json"), snapshot: contract ?? absentHostedDocumentSnapshotV2(transitionTaskPath(plan.taskId, "task-contract.json")) }
    ],
    mutations: [taskTransitionMutation(plan.taskId), checkpointMutation(plan)],
    baseRefs: [
      taskLifecycleTransitionRefV2("execution", `execution/${plan.taskId}/${plan.executionId}`),
      taskLifecycleTransitionRefV2("review", `review/${plan.taskId}/${plan.approvedReviewId}`),
      taskLifecycleTransitionRefV2("consent", `consent/${plan.taskId}/${plan.consumedConsentId}`),
      taskLifecycleTransitionRefV2("task", `task/${plan.taskId}`)
    ]
  });
}

async function compileCommitAnchor(
  options: TaskLifecycleTransitionSemanticCompilerV2Options,
  plan: Extract<CanonicalTaskMutationPlan, { readonly kind: "commit-anchor" }>
): Promise<CompiledTransition> {
  const evidence = decodeTaskCompletionEvidence(plan.evidence);
  if (evidence.taskId !== plan.taskId || evidence.mode !== "commit-anchor") throw admission("COMMIT_COMPLETION_EVIDENCE_IDENTITY_INVALID");
  const taskIndexPath = transitionTaskPath(plan.taskId, "INDEX.md");
  const checkpointPath = transitionTaskPath(plan.taskId, `transitions/${plan.transitionId}.json`);
  const evidencePath = transitionTaskPath(plan.taskId, "completion-evidence.json");
  const taskSnapshot = await requiredTransitionSnapshot(options.state, taskIndexPath, "TASK_INDEX_DOCUMENT_NOT_FOUND");
  const checkpointSnapshot = await options.state.readHostedDocument(checkpointPath);
  const evidenceSnapshot = await options.state.readHostedDocument(evidencePath);
  const encodedEvidence = JSON.stringify(evidence, null, 2) + "\n";
  if (checkpointSnapshot) assertSameCheckpoint(checkpointSnapshot.body, transitionCheckpoint(plan, null));
  if (evidenceSnapshot && stablePayloadHash(JSON.parse(evidenceSnapshot.body)) !== stablePayloadHash(evidence)) {
    throw admission("COMMIT_COMPLETION_EVIDENCE_CHANGED");
  }
  const contract = await contractSnapshot(options.state, plan);
  const relevantWitnessSnapshots = await witnessSnapshots(options.state, plan);
  return compiledTransition({
    plan,
    checkpoint: transitionCheckpoint(plan, null),
    companionWrites: [
      { taskId: plan.taskId, path: "completion-evidence.json", body: encodedEvidence },
      { taskId: plan.taskId, path: "INDEX.md", body: doneTaskBody(taskSnapshot.body) }
    ],
    preconditions: [
      precondition(plan.taskId, `transitions/${plan.transitionId}.json`, checkpointSnapshot?.body ?? null),
      precondition(plan.taskId, "completion-evidence.json", evidenceSnapshot?.body ?? null),
      precondition(plan.taskId, "INDEX.md", taskSnapshot.body),
      precondition(plan.taskId, "task-contract.json", contract?.body ?? null),
      ...relevantWitnessSnapshots.map(({ relativePath, snapshot }) => precondition(plan.taskId, relativePath, snapshot.body))
    ],
    requiredPathSnapshots: [
      { path: taskIndexPath, snapshot: taskSnapshot },
      { path: checkpointPath, snapshot: checkpointSnapshot ?? absentHostedDocumentSnapshotV2(checkpointPath) },
      { path: evidencePath, snapshot: evidenceSnapshot ?? absentHostedDocumentSnapshotV2(evidencePath) },
      { path: transitionTaskPath(plan.taskId, "task-contract.json"), snapshot: contract ?? absentHostedDocumentSnapshotV2(transitionTaskPath(plan.taskId, "task-contract.json")) }
    ],
    mutations: [taskTransitionMutation(plan.taskId), checkpointMutation(plan)],
    baseRefs: [taskLifecycleTransitionRefV2("task", `task/${plan.taskId}`)]
  });
}

async function compileAlreadyCommitted(
  options: TaskLifecycleTransitionSemanticCompilerV2Options,
  plan: Extract<CanonicalTaskMutationPlan, { readonly kind: "already-committed" }>
): Promise<CompiledTransition> {
  const taskIndexPath = transitionTaskPath(plan.taskId, "INDEX.md");
  const checkpointPath = transitionTaskPath(plan.taskId, `transitions/${plan.transitionId}.json`);
  const taskSnapshot = await requiredTransitionSnapshot(options.state, taskIndexPath, "TASK_INDEX_DOCUMENT_NOT_FOUND");
  const checkpointSnapshot = await requiredTransitionSnapshot(options.state, checkpointPath, "TASK_LIFECYCLE_TRANSITION_CHECKPOINT_REQUIRED");
  const executionPath = plan.executionId === null
    ? null
    : transitionTaskPath(plan.taskId, `executions/${plan.executionId}.md`);
  const executionSnapshot = executionPath
    ? await requiredTransitionSnapshot(options.state, executionPath, "EXECUTION_DOCUMENT_NOT_FOUND")
    : null;
  if (!/^  status:\s*done$/mu.test(taskSnapshot.body)) throw admission("TASK_LIFECYCLE_TERMINAL_TASK_STATE_INVALID");
  if (executionSnapshot && plan.executionId) {
    lifecycleDecodeExecution(executionSnapshot.body, plan.taskId, plan.executionId, "accepted");
  }
  const checkpoint = transitionCheckpoint(plan, plan.executionId === null ? null : "accepted");
  assertSameCheckpoint(checkpointSnapshot.body, checkpoint);
  const contract = await contractSnapshot(options.state, plan);
  return {
    mutationPlan: mutationPlan([taskTransitionMutation(plan.taskId)]),
    operation: {
      opId: "authority-overrides-this",
      entityId: `entity/task/${plan.taskId}` as EntityId,
      kind: "transition_local",
      payload: { path: "INDEX.md", body: taskSnapshot.body, to: "done" }
    },
    requiredPathSnapshots: [
      { path: taskIndexPath, snapshot: taskSnapshot },
      { path: checkpointPath, snapshot: checkpointSnapshot },
      ...(executionSnapshot && executionPath ? [{ path: executionPath, snapshot: executionSnapshot }] : []),
      { path: transitionTaskPath(plan.taskId, "task-contract.json"), snapshot: contract ?? absentHostedDocumentSnapshotV2(transitionTaskPath(plan.taskId, "task-contract.json")) }
    ],
    requiredBaseRefs: [taskLifecycleTransitionRefV2("task", `task/${plan.taskId}`)],
    alreadySatisfied: {
      verify: taskTransitionAlreadySatisfiedVerifierV1({
        state: options.state,
        taskId: plan.taskId,
        path: taskIndexPath,
        requestedStatus: "done",
        expected: taskSnapshot
      })
    }
  };
}

function compiledTransition(input: {
  readonly plan: CanonicalTaskMutationPlan;
  readonly checkpoint: TransitionCheckpoint;
  readonly companionWrites: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly body: string }>;
  readonly preconditions: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly bodySha256: string | null }>;
  readonly requiredPathSnapshots: CompiledTransition["requiredPathSnapshots"];
  readonly mutations: RegistryMutationPlanInput["mutations"];
  readonly baseRefs: ReadonlyArray<RegistryEntityRefV2>;
}): CompiledTransition {
  return {
    mutationPlan: mutationPlan(input.mutations),
    operation: {
      opId: "authority-overrides-this",
      entityId: `entity/task/${input.plan.taskId}` as EntityId,
      kind: "doc_write",
      payload: {
        entityDocument: {
          declaration: {
            kind: taskLifecycleTransitionCheckpointDeclaration.kind,
            storageForm: taskLifecycleTransitionCheckpointDeclaration.storageForm,
            rootResolver: taskLifecycleTransitionCheckpointDeclaration.rootResolver!
          },
          identity: { taskId: input.plan.taskId, transitionId: input.plan.transitionId },
          body: taskLifecycleTransitionCheckpointDeclaration.documentCodec.encode(input.checkpoint)
        },
        companionWrites: dedupeWrites(input.companionWrites),
        preconditions: dedupePreconditions(input.preconditions)
      }
    },
    requiredBaseRefs: dedupeRefs(input.baseRefs),
    requiredPathSnapshots: dedupeSnapshots(input.requiredPathSnapshots)
  };
}

async function createPlanConsent(
  options: TaskLifecycleTransitionSemanticCompilerV2Options,
  plan: Extract<CanonicalTaskMutationPlan, { readonly kind: "execution-review" }>,
  execution: ExecutionRecord,
  context: AuthoritySemanticCompilerContextV2,
  now: string
): Promise<ConsentRecord> {
  const approval = plan.command.approval!;
  if (approval.consentSource.kind === "recorded-consent") throw admission("CONSENT_DOCUMENT_NOT_FOUND");
  const actions = approval.consentActions ?? DEFAULT_HUMAN_CONSENT_ACTIONS;
  assertCompletionConsentActions(actions);
  const request = approval.consentSource.kind === "utterance"
    ? consentSourceRequest({ utterance: approval.consentSource.utterance })
    : approval.consentSource.kind === "standing-policy"
      ? consentSourceRequest({ standingPolicyDecisionId: approval.consentSource.decisionId })
      : consentSourceRequest({ assertedRationale: approval.consentSource.rationale });
  let authorization;
  try {
    authorization = await resolveConsentAuthorization({
      rootInput: options.rootInput,
      transcriptCandidates: authorityConsentTranscriptCandidatesV2(
        execution,
        context.currentSession,
        now,
        context.sessionId,
        options.consentTtlMs ?? DEFAULT_HUMAN_CONSENT_TTL_MS,
        request.kind === "utterance"
      ),
      request,
      runtimeLogOptions: options.runtimeLogOptions
    });
  } catch (error) {
    throw admission("CONSENT_SOURCE_UNVERIFIED", error instanceof Error ? error.message : String(error));
  }
  if (!isTranscriptConsentAnchoredToSession(authorization.source, `session/${context.sessionId}`)) {
    throw admission("CONSENT_REVIEW_SESSION_MISMATCH");
  }
  return createConsentRecord({
    consentId: plan.consentId,
    taskId: plan.taskId,
    execution,
    actor: context.actor,
    authorization,
    actions,
    grantedAt: now,
    ttlMs: options.consentTtlMs ?? DEFAULT_HUMAN_CONSENT_TTL_MS
  });
}

function existingConsent(
  body: string,
  plan: Extract<CanonicalTaskMutationPlan, { readonly kind: "execution-review" }>,
  execution: ExecutionRecord,
  context: AuthoritySemanticCompilerContextV2,
  now: string
): ConsentRecord {
  if (plan.command.approval?.consentSource.kind !== "recorded-consent") throw admission("CONSENT_EXISTING_INPUT_INVALID");
  const consent = lifecycleDecodeConsentDocument(body, plan.taskId, plan.consentId);
  if (consent.state !== "open" || consent.principal.personId !== context.actor.principal.personId
    || consent.execution_ref !== `execution/${plan.taskId}/${plan.executionId}`
    || Date.parse(now) >= Date.parse(consent.expires_at)
    || consent.scope.content_pin.digest !== computeExecutionConsentPin(execution)) {
    throw admission("CONSENT_EXISTING_INPUT_INVALID");
  }
  assertCompletionConsentActions(consent.scope.actions);
  return consent;
}

function assertAcceptedApproval(
  plan: Extract<CanonicalTaskMutationPlan, { readonly kind: "accepted-replay" }>,
  execution: ExecutionRecord,
  reviewBody: string,
  consentBody: string
): void {
  const review = Schema.decodeUnknownSync(reviewDeclaration.schema)(reviewDeclaration.documentCodec.decode(reviewBody)) as ReviewRecord;
  const consent = lifecycleDecodeConsentDocument(consentBody, plan.taskId, plan.consumedConsentId);
  const submittedPin = computeExecutionConsentPin({ ...execution, state: "submitted", closed_at: null });
  if (review.review_id !== plan.approvedReviewId || review.verdict !== "approved"
    || review.execution_ref !== `execution/${plan.taskId}/${plan.executionId}`
    || review.approval_basis?.kind !== "human-consent"
    || review.approval_basis.consent_ref !== `consent/${plan.taskId}/${plan.consumedConsentId}`
    || consent.state !== "consumed"
    || consent.consumed_by !== `review/${plan.taskId}/${plan.approvedReviewId}`
    || consent.scope.content_pin.digest !== submittedPin
    || !consent.scope.actions.includes("complete_task")) {
    throw admission("TASK_LIFECYCLE_ACCEPTED_REPLAY_APPROVAL_INVALID");
  }
}

function lifecycleDecodeExecution(
  body: string,
  taskId: string,
  executionId: string,
  state: "submitted" | "accepted"
): ExecutionRecord {
  const execution = decodeExecutionRecord(executionDeclaration.documentCodec.decode(body));
  if (execution.task_ref !== `task/${taskId}` || execution.execution_id !== executionId || execution.state !== state) {
    throw admission("TASK_LIFECYCLE_EXECUTION_STATE_INVALID");
  }
  return execution;
}

function decodeExecutionRecord(value: unknown): ExecutionRecord {
  try { return Schema.decodeUnknownSync(executionDeclaration.schema)(value) as ExecutionRecord; }
  catch { throw admission("EXECUTION_DOCUMENT_INVALID"); }
}

function decodeConsent(value: unknown): ConsentRecord {
  try { return Schema.decodeUnknownSync(consentDeclaration.schema)(value) as ConsentRecord; }
  catch { throw admission("CONSENT_DOCUMENT_INVALID"); }
}

function lifecycleDecodeConsentDocument(body: string, taskId: string, consentId: string): ConsentRecord {
  const consent = decodeConsent(consentDeclaration.documentCodec.decode(body));
  if (consent.task_ref !== `task/${taskId}` || consent.consent_id !== consentId) throw admission("CONSENT_IDENTITY_MISMATCH");
  return consent;
}

function assertCompletionConsentActions(actions: ReadonlyArray<ConsentRecord["scope"]["actions"][number]>): void {
  try { assertConsentActions(actions); } catch { throw admission("CONSENT_ACTION_SCOPE_INVALID"); }
  if (!actions.includes("complete_task")) throw admission("CONSENT_COMPLETION_SCOPE_REQUIRED");
}

function doneTaskBody(body: string): string {
  if (!/^  status:\s*(planned|active|blocked|in_review|done)$/mu.test(body)) throw admission("TASK_LIFECYCLE_TASK_NOT_OPEN");
  return body.replace(/^(  status:\s*).+$/mu, "$1done");
}

function transitionTaskPath(taskId: string, relativePath: string): string {
  return `tasks/${encodeURIComponent(taskId)}/${relativePath}`;
}

function precondition(taskId: string, path: string, body: string | null) {
  return { taskId, path, bodySha256: body === null ? null : sha256Text(body) };
}

function taskTransitionMutation(taskId: string) {
  return { entityKind: "task", identity: { taskId }, action: "transition", storageContext: { documentPath: "INDEX.md" } };
}

function checkpointMutation(plan: CanonicalTaskMutationPlan) {
  return { entityKind: "task", identity: { taskId: plan.taskId }, action: "document", storageContext: { documentPath: `transitions/${plan.transitionId}.json` } };
}

async function requiredTransitionSnapshot(state: TaskLifecycleTransitionAuthorityStateV2, path: string, code: string): Promise<HostedDocumentSnapshotV2> {
  const snapshot = await state.readHostedDocument(path);
  if (!snapshot) throw admission(code);
  return snapshot;
}

function dedupeWrites(values: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly body: string }>) {
  return [...new Map(values.map((entry) => [`${entry.taskId}:${entry.path}`, entry])).values()];
}

function dedupePreconditions(values: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly bodySha256: string | null }>) {
  const result = new Map<string, typeof values[number]>();
  for (const entry of values) {
    const key = `${entry.taskId}:${entry.path}`;
    const existing = result.get(key);
    if (existing && existing.bodySha256 !== entry.bodySha256) throw admission("TASK_LIFECYCLE_PRECONDITION_CONFLICT");
    result.set(key, entry);
  }
  return [...result.values()];
}

function dedupeRefs(values: ReadonlyArray<RegistryEntityRefV2>): ReadonlyArray<RegistryEntityRefV2> {
  return [...new Map(values.map((entry) => [`${entry.entityKind}:${entry.canonicalRef}`, entry])).values()];
}

function dedupeSnapshots(values: CompiledTransition["requiredPathSnapshots"]): CompiledTransition["requiredPathSnapshots"] {
  return [...new Map(values.map((entry) => [entry.path, entry])).values()];
}
