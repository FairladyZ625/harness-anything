import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_HUMAN_CONSENT_ACTIONS,
  absentHostedDocumentSnapshotV2,
  encodeConsentCommandPayloadV2,
  encodeFactRelationCommandPayloadV2,
  encodeSessionExecutionReviewCommandPayloadV2,
  encodeTaskDecisionModuleCommandPayloadV2,
  evaluateTaskCompletionAuthority,
  finalizeExecutionSessionBindings,
  renderCodeDocReconciliationDraft,
  type ConsentCommandPayloadV2,
  type FactRelationCommandPayloadV2,
  type ProductionAuthorityCommand,
  type ProductionAuthorityCompilerHostServices,
  type SessionExecutionReviewCommandPayloadV2,
  type TaskDecisionModuleCommandPayloadV2
} from "@harness-anything/application";
import {
  executionDeclaration,
  deriveRelationId,
  makeLocalVersionControlSystem,
  sha256Text,
  taskEntityId,
  taskPackagePath,
  type ExecutionRecord,
  type RegistryEntityRefV2
} from "@harness-anything/kernel";
import type { DaemonAuthorityAttemptCompilerV2 } from "../authority-command-submission.ts";
import type { CanonicalAttemptIntent } from "./production-authority-attempt-compiler.ts";
import { acceptedTaskCompletionTransition } from "./production-authority-accepted-completion.ts";

type CompileInput = Parameters<DaemonAuthorityAttemptCompilerV2["compile"]>[0];

export function productionLifecycleAttemptIntent(input: {
  readonly command: ProductionAuthorityCommand;
  readonly currentSession: CompileInput["currentSession"];
  readonly canonicalEntityId: string;
  readonly authoredRoot: string;
  readonly actor: ExecutionRecord["primary_actor"];
}, hostServices: ProductionAuthorityCompilerHostServices): CanonicalAttemptIntent | null {
  const { action } = input.command;
  if (action.kind === "status-set") {
    const taskPath = taskLifecyclePath(input.authoredRoot, action.taskId, "INDEX.md");
    if (action.executionSubmission?.executionId) {
      return executionSubmitIntent(
        input.authoredRoot,
        { rootDir: input.command.rootDir, layoutOverrides: input.command.layoutOverrides },
        input.currentSession.detectedAt,
        action,
        taskPath
      );
    }
    const auditText = action.force
      ? hostServices.renderForceStatusAudit(action.status, action.reason ?? "unspecified", input.currentSession.detectedAt)
      : undefined;
    const payload: TaskDecisionModuleCommandPayloadV2 = {
      schema: "task.transition/v1", taskId: action.taskId, to: action.status,
      ...(auditText === undefined ? {} : { auditText })
    };
    return lifecycleIntent("task.transition", encodeTaskDecisionModuleCommandPayloadV2(payload), [
      lifecycleMutation("task", `task/${action.taskId}`, "transition")
    ], [lifecycleRef("task", `task/${action.taskId}`)], [
      ...portableLifecyclePaths(taskPath),
      ...(auditText === undefined ? [] : portableLifecyclePaths(taskLifecyclePath(input.authoredRoot, action.taskId, "progress.md")))
    ], taskEntityId(action.taskId), [
      requiredLifecycleSnapshot(input.authoredRoot, taskPath.logical, taskPath.physical)
    ]);
  }
  if (action.kind === "fact-invalidate") {
    const payload: FactRelationCommandPayloadV2 = {
      schema: "fact.invalidate/v1", ownerTaskId: action.taskId, factId: action.factId,
      invalidatedByFactId: action.invalidatedByFactId, rationale: action.rationale
    };
  const relationId = deriveRelationId({
    source: `fact/${action.taskId}/${action.invalidatedByFactId}`,
    target: `fact/${action.taskId}/${action.factId}`,
    type: "supersedes-fact",
    direction: "directed"
  });
    return lifecycleIntent("fact.invalidate", encodeFactRelationCommandPayloadV2(payload), [
      lifecycleMutation("fact", `fact/${action.taskId}/${action.factId}`, "invalidate"),
      lifecycleMutation("relation", `relation/${relationId}`, "create")
    ], [
      lifecycleRef("fact", `fact/${action.taskId}/${action.factId}`),
      lifecycleRef("fact", `fact/${action.taskId}/${action.invalidatedByFactId}`),
      lifecycleRef("relation", `relation/${relationId}`)
    ], portableLifecyclePaths(taskLifecyclePath(input.authoredRoot, action.taskId, "facts.md")), taskEntityId(action.taskId));
  }
  if (action.kind === "task-code-doc-reconcile") return codeDocIntent(input.authoredRoot, action);
  if (action.kind === "task-retire-execution") {
    return executionRetirementIntent(input.authoredRoot, action, input.actor);
  }
  if (action.kind === "task-review-execution" && action.verdict === "approved") {
    return approvedReviewIntent(input.authoredRoot, input.canonicalEntityId, action);
  }
  if (action.kind === "task-review-execution" && action.verdict === "changes_requested") {
    return changesRequestedReviewIntent(
      input.authoredRoot,
      input.currentSession.detectedAt,
      input.currentSession.sessionId,
      input.canonicalEntityId,
      action,
      input.actor
    );
  }
  if (action.kind === "task-review-execution" && action.verdict === "dismissed") {
    return dismissedReviewIntent(
      input.authoredRoot,
      input.currentSession.detectedAt,
      input.currentSession.sessionId,
      input.canonicalEntityId,
      action,
      input.actor
    );
  }
  if (action.kind === "task-complete") {
    return taskCompletionIntent(
      input.authoredRoot,
      input.command.rootDir,
      input.currentSession.detectedAt,
      input.currentSession.sessionId,
      action,
      input.canonicalEntityId,
      input.actor
    );
  }
  return null;
}

function executionRetirementIntent(
  authoredRoot: string,
  action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "task-retire-execution" }>,
  actor: ExecutionRecord["primary_actor"]
): CanonicalAttemptIntent {
  const executionPath = taskLifecyclePath(authoredRoot, action.taskId, `executions/${action.executionId}.md`);
  const executionSnapshot = requiredLifecycleSnapshot(authoredRoot, executionPath.logical, executionPath.physical);
  const current = executionDeclaration.documentCodec.decode(executionSnapshot.body) as ExecutionRecord;
  if (current.execution_id !== action.executionId || current.task_ref !== `task/${action.taskId}`) {
    throw new Error("AUTHORITY_EXECUTION_RETIREMENT_IDENTITY_MISMATCH");
  }
  if (current.state !== "active") {
    throw new Error(`AUTHORITY_EXECUTION_RETIREMENT_ACTIVE_REQUIRED: execution ${action.executionId} is ${current.state}`);
  }
  const retiredBy = actor.executor
    ? `person:${actor.principal.personId}/agent:${actor.executor.id}`
    : `person:${actor.principal.personId}`;
  const payload: SessionExecutionReviewCommandPayloadV2 = {
    schema: "execution.close/v1",
    taskId: action.taskId,
    execution: { ...current, state: "abandoned", closed_at: action.retiredAt },
    retirement: { reason: action.reason, retiredAt: action.retiredAt, retiredBy }
  };
  const progressPath = taskLifecyclePath(authoredRoot, action.taskId, "progress.md");
  const progressSnapshot = optionalLifecycleSnapshot(authoredRoot, progressPath.logical, progressPath.physical);
  return lifecycleIntent("execution.close", encodeSessionExecutionReviewCommandPayloadV2(payload), [
    lifecycleMutation("execution", `execution/${action.taskId}/${action.executionId}`, "close"),
    lifecycleMutation("task", `task/${action.taskId}`, "append")
  ], [
    lifecycleRef("execution", `execution/${action.taskId}/${action.executionId}`),
    lifecycleRef("task", `task/${action.taskId}`)
  ], portableLifecyclePaths(executionPath, progressPath), `entity/execution/${action.executionId}`, [
    executionSnapshot,
    ...(progressSnapshot ? [progressSnapshot] : [])
  ]);
}

function executionSubmitIntent(
  authoredRoot: string,
  rootInput: { readonly rootDir: string; readonly layoutOverrides?: { readonly authoredRoot?: string } },
  submittedAt: string,
  action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "status-set" }>,
  taskPath: ReturnType<typeof taskLifecyclePath>
): CanonicalAttemptIntent {
  const submission = action.executionSubmission!;
  const executionId = submission.executionId!;
  const executionPath = taskLifecyclePath(authoredRoot, action.taskId, `executions/${executionId}.md`);
  const executionSnapshot = requiredLifecycleSnapshot(authoredRoot, executionPath.logical, executionPath.physical);
  const taskSnapshot = requiredLifecycleSnapshot(authoredRoot, taskPath.logical, taskPath.physical);
  const current = executionDeclaration.documentCodec.decode(executionSnapshot.body) as ExecutionRecord;
  const sessionBindings = finalizeExecutionSessionBindings(
    rootInput,
    current.session_bindings,
    submittedAt
  );
  const next: ExecutionRecord = {
    ...current,
    state: "submitted",
    submitted_at: submittedAt,
    session_bindings: sessionBindings,
    outputs: [
      ...current.outputs,
      ...submission.outputs.map((text, index) => ({
        evidence_id: `ev_cli_${index + 1}`,
        execution_ref: `execution/${action.taskId}/${executionId}`,
        locator: { substrate: "inline" as const, text }
      }))
    ],
    submission: {
      completion_claim: submission.completionClaim,
      deliverables: submission.deliverables,
      evidence_refs: submission.outputs.map((_, index) => `ev_cli_${index + 1}`),
      verification_notes: submission.verificationNotes,
      known_gaps: submission.knownGaps,
      residual_risks: submission.residualRisks
    }
  };
  const taskIndexBody = taskSnapshot.body.replace(/^(  status:\s*).+$/mu, "$1in_review");
  const payload: SessionExecutionReviewCommandPayloadV2 = {
    schema: "execution.submit/v1",
    taskId: action.taskId,
    execution: next,
    taskIndexBody
  };
  return lifecycleIntent(
    "execution.submit",
    encodeSessionExecutionReviewCommandPayloadV2(payload),
    [
      lifecycleMutation("execution", `execution/${action.taskId}/${executionId}`, "submit"),
      lifecycleMutation("task", `task/${action.taskId}`, "transition")
    ],
    [
      lifecycleRef("execution", `execution/${action.taskId}/${executionId}`),
      lifecycleRef("task", `task/${action.taskId}`)
    ],
    [
      ...portableLifecyclePaths(executionPath),
      ...portableLifecyclePaths(taskPath)
    ],
    `execution/${executionId}`,
    [executionSnapshot, taskSnapshot]
  );
}

function codeDocIntent(
  authoredRoot: string,
  action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "task-code-doc-reconcile" }>
): CanonicalAttemptIntent {
  const taskRoot = resolvedTaskRoot(authoredRoot, action.taskId);
  const taskDocuments = readTaskDocuments(taskRoot);
  const documents = taskDocuments.filter((document) => document.path === "closeout.md" || document.path === "review.md");
  const draft = renderCodeDocReconciliationDraft({
    taskId: action.taskId, documents, sha: action.sha, paths: action.paths, prRef: action.prRef
  });
  const payload: TaskDecisionModuleCommandPayloadV2 = {
    schema: "task.document/v1",
    taskId: action.taskId,
    path: "code-doc-anchors.json",
    body: draft.body
  };
  const portablePath = taskLifecyclePath(authoredRoot, action.taskId, "code-doc-anchors.json");
  const existing = optionalLifecycleSnapshot(authoredRoot, portablePath.logical, portablePath.physical);
  return lifecycleIntent("task.document", encodeTaskDecisionModuleCommandPayloadV2(payload), [
    lifecycleMutation("task", `task/${action.taskId}`, "document")
  ], [lifecycleRef("task", `task/${action.taskId}`)], portableLifecyclePaths(portablePath), taskEntityId(action.taskId), existing ? [existing] : []);
}

function approvedReviewIntent(
  authoredRoot: string,
  canonicalEntityId: string,
  action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "task-review-execution" }>
): CanonicalAttemptIntent {
  const executionId = requiredReviewExecutionId(action);
  const consentId = action.consentId ?? action.generatedConsentId;
  if (!consentId) {
    throw new Error("AUTHORITY_APPROVED_REVIEW_CONSENT_ID_REQUIRED: record consent first and retry with --consent-id");
  }
  const reviewId = canonicalEntityId.replace(/^(?:entity\/)?review\//u, "");
  const consentPath = taskLifecyclePath(authoredRoot, action.taskId, `consents/${consentId}.md`);
  const storedConsent = optionalLifecycleSnapshot(authoredRoot, consentPath.logical, consentPath.physical);
  const payload: ConsentCommandPayloadV2 = {
    schema: "consent.consume/v1", taskId: action.taskId, executionId,
    consentId,
    utterance: storedConsent ? null : action.consentUtterance ?? null,
    standingPolicyDecisionId: storedConsent ? null : action.consentStandingPolicyDecisionId ?? null,
    assertedRationale: storedConsent ? null : action.consentAssertedRationale ?? null,
    actions: storedConsent ? [] : action.consentActions ?? DEFAULT_HUMAN_CONSENT_ACTIONS,
    review: {
      reviewId, findings: action.findings, evidenceChecked: action.evidenceChecked,
      rationale: action.rationale, archiveWarningsAcknowledged: action.archiveWarningsAcknowledged
    }
  };
  const executionPath = taskLifecyclePath(authoredRoot, action.taskId, `executions/${executionId}.md`);
  const taskPath = taskLifecyclePath(authoredRoot, action.taskId, "INDEX.md");
  const reviewPath = taskLifecyclePath(authoredRoot, action.taskId, `reviews/${reviewId}.md`);
  return lifecycleIntent("consent.consume", encodeConsentCommandPayloadV2(payload), [
    ...(storedConsent ? [] : [lifecycleMutation("consent", `consent/${action.taskId}/${consentId}`, "grant")]),
    lifecycleMutation("consent", `consent/${action.taskId}/${consentId}`, "consume"),
    lifecycleMutation("review", `review/${action.taskId}/${reviewId}`, "record"),
    lifecycleMutation("execution", `execution/${action.taskId}/${executionId}`, "close")
  ], [
    lifecycleRef("execution", `execution/${action.taskId}/${executionId}`),
    lifecycleRef("consent", `consent/${action.taskId}/${consentId}`),
    lifecycleRef("review", `review/${action.taskId}/${reviewId}`)
  ], portableLifecyclePaths(executionPath, taskPath, consentPath, reviewPath), canonicalEntityId, [
    requiredLifecycleSnapshot(authoredRoot, executionPath.logical, executionPath.physical),
    requiredLifecycleSnapshot(authoredRoot, taskPath.logical, taskPath.physical),
    ...(storedConsent ? [storedConsent] : [])
  ]);
}

function changesRequestedReviewIntent(
  authoredRoot: string,
  reviewedAt: string,
  reviewerSessionId: string,
  canonicalEntityId: string,
  action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "task-review-execution" }>,
  reviewerActor: ExecutionRecord["primary_actor"]
): CanonicalAttemptIntent {
  const executionId = requiredReviewExecutionId(action);
  const reviewId = canonicalEntityId.replace(/^(?:entity\/)?review\//u, "");
  const executionPath = taskLifecyclePath(authoredRoot, action.taskId, `executions/${executionId}.md`);
  const executionSnapshot = requiredLifecycleSnapshot(authoredRoot, executionPath.logical, executionPath.physical);
  const current = executionDeclaration.documentCodec.decode(executionSnapshot.body) as ExecutionRecord;
  const execution: ExecutionRecord = { ...current, state: "changes_requested", closed_at: reviewedAt };
  const taskPath = taskLifecyclePath(authoredRoot, action.taskId, "INDEX.md");
  const taskSnapshot = requiredLifecycleSnapshot(authoredRoot, taskPath.logical, taskPath.physical);
  const taskIndexBody = hasOtherSubmittedExecution(authoredRoot, action.taskId, executionId)
    ? taskSnapshot.body
    : taskSnapshot.body.replace(/^(  status:\s*)in_review$/mu, "$1active");
  const reviewPath = taskLifecyclePath(authoredRoot, action.taskId, `reviews/${reviewId}.md`);
  const payload: SessionExecutionReviewCommandPayloadV2 = {
    schema: "review.create/v1",
    taskId: action.taskId,
    review: {
      schema: "review/v3", review_id: reviewId, task_ref: `task/${action.taskId}`,
      execution_ref: `execution/${action.taskId}/${executionId}`,
      reviewer_actor: reviewerActor,
      reviewer_session_ref: `session/${reviewerSessionId}`,
      findings: action.findings, evidence_checked: action.evidenceChecked, rationale: action.rationale,
      verdict: "changes_requested", archive_warnings_acknowledged: action.archiveWarningsAcknowledged,
      reviewed_at: reviewedAt, approval_basis: null
    },
    execution,
    taskIndexBody
  };
  const taskChanges = taskIndexBody !== taskSnapshot.body;
  return lifecycleIntent("review.create", encodeSessionExecutionReviewCommandPayloadV2(payload), [
    lifecycleMutation("review", `review/${action.taskId}/${reviewId}`, "create"),
    lifecycleMutation("execution", `execution/${action.taskId}/${executionId}`, "close"),
    ...(taskChanges ? [lifecycleMutation("task", `task/${action.taskId}`, "transition")] : [])
  ], [
    lifecycleRef("review", `review/${action.taskId}/${reviewId}`),
    lifecycleRef("execution", `execution/${action.taskId}/${executionId}`),
    lifecycleRef("task", `task/${action.taskId}`)
  ], portableLifecyclePaths(reviewPath, executionPath, taskPath), canonicalEntityId, [executionSnapshot, taskSnapshot]);
}

function hasOtherSubmittedExecution(authoredRoot: string, taskId: string, reviewedExecutionId: string): boolean {
  const executionRoot = path.join(resolvedTaskRoot(authoredRoot, taskId), "executions");
  if (!existsSync(executionRoot)) return false;
  return readdirSync(executionRoot).filter((name) => name.endsWith(".md") && name !== `${reviewedExecutionId}.md`)
    .some((name) => {
      const record = executionDeclaration.documentCodec.decode(readFileSync(path.join(executionRoot, name), "utf8")) as ExecutionRecord;
      return record.state === "submitted";
    });
}

function dismissedReviewIntent(
  authoredRoot: string,
  reviewedAt: string,
  reviewerSessionId: string,
  canonicalEntityId: string,
  action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "task-review-execution" }>,
  reviewerActor: ExecutionRecord["primary_actor"]
): CanonicalAttemptIntent {
  const executionId = requiredReviewExecutionId(action);
  const reviewId = canonicalEntityId.replace(/^(?:entity\/)?review\//u, "");
  const executionPath = taskLifecyclePath(authoredRoot, action.taskId, `executions/${executionId}.md`);
  const taskPath = taskLifecyclePath(authoredRoot, action.taskId, "INDEX.md");
  const reviewPath = taskLifecyclePath(authoredRoot, action.taskId, `reviews/${reviewId}.md`);
  const executionSnapshot = requiredLifecycleSnapshot(authoredRoot, executionPath.logical, executionPath.physical);
  const taskSnapshot = requiredLifecycleSnapshot(authoredRoot, taskPath.logical, taskPath.physical);
  const payload: SessionExecutionReviewCommandPayloadV2 = {
    schema: "review.dismiss/v1",
    taskId: action.taskId,
    review: {
      schema: "review/v3", review_id: reviewId, task_ref: `task/${action.taskId}`,
      execution_ref: `execution/${action.taskId}/${executionId}`,
      reviewer_actor: reviewerActor, reviewer_session_ref: `session/${reviewerSessionId}`,
      findings: action.findings, evidence_checked: action.evidenceChecked, rationale: action.rationale,
      verdict: "dismissed", archive_warnings_acknowledged: action.archiveWarningsAcknowledged,
      reviewed_at: reviewedAt, approval_basis: null
    }
  };
  return lifecycleIntent("review.dismiss", encodeSessionExecutionReviewCommandPayloadV2(payload), [
    lifecycleMutation("review", `review/${action.taskId}/${reviewId}`, "dismiss")
  ], [
    lifecycleRef("review", `review/${action.taskId}/${reviewId}`),
    lifecycleRef("execution", `execution/${action.taskId}/${executionId}`),
    lifecycleRef("task", `task/${action.taskId}`)
  ], portableLifecyclePaths(reviewPath, executionPath, taskPath), canonicalEntityId, [executionSnapshot, taskSnapshot]);
}

function requiredReviewExecutionId(
  action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "task-review-execution" }>
): string {
  if (!action.executionId) throw new Error("AUTHORITY_REVIEW_EXECUTION_SELECTION_REQUIRED: set executionId or provide exactly one submitted Execution");
  return action.executionId;
}

function taskCompletionIntent(
  authoredRoot: string,
  rootDir: string,
  completedAt: string,
  sessionId: string,
  action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "task-complete" }>,
  canonicalEntityId: string,
  actor: ExecutionRecord["primary_actor"]
): CanonicalAttemptIntent {
  const taskId = action.taskId;
  const taskRoot = resolvedTaskRoot(authoredRoot, taskId);
  const documents = readTaskDocuments(taskRoot);
  const taskPath = taskLifecyclePath(authoredRoot, taskId, "INDEX.md");
  const taskSnapshot = requiredLifecycleSnapshot(authoredRoot, taskPath.logical, taskPath.physical);
  const status = /^  status:\s*(\S+)$/mu.exec(taskSnapshot.body)?.[1] ?? "unknown";
  const evaluation = evaluateTaskCompletionAuthority({
    taskId,
    executionId: action.executionId,
    mode: action.evidenceMode ?? "execution-review",
    status,
    documents,
    actor,
    sessionRef: `session/${sessionId}`,
    judgedAt: completedAt,
    applicableGates: completionApplicableGates(action),
    ciGate: action.ciGate,
    commitRef: action.commitRef,
    judgment: action.judgment,
    rootDir,
    versionControlSystem: makeLocalVersionControlSystem()
  });
  if (!evaluation.ok) {
    throw new Error(`AUTHORITY_TASK_COMPLETE_REJECTED:${evaluation.issues.map((issue) => issue.code).join(",")}`);
  }
  const taskBody = taskSnapshot.body.replace(/^(  status:\s*).+$/mu, "$1done");
  const contractPath = taskLifecyclePath(authoredRoot, taskId, "task-contract.json");
  const contractSnapshot = optionalLifecycleSnapshot(authoredRoot, contractPath.logical, contractPath.physical);
  const absentContract = absentHostedDocumentSnapshotV2(contractPath.logical);
  const contractCas = contractSnapshot ?? {
    path: contractPath.logical,
    expectedEpoch: absentContract.epoch,
    expectedRevision: absentContract.revision,
    expectedBlobDigest: absentContract.blobDigest
  };
  const currentContractBodySha256 = contractSnapshot ? sha256Text(contractSnapshot.body) : null;
  const contractBodySha256 = action.completionContractBodySha256 === undefined
    ? currentContractBodySha256
    : action.completionContractBodySha256;
  if (contractBodySha256 !== currentContractBodySha256) {
    throw new Error("AUTHORITY_TASK_COMPLETE_CONTRACT_CHANGED");
  }
  if (evaluation.evidenceMode === "execution-review") {
    const executionDocument = documents.find((document) => document.path === `executions/${evaluation.executionId}.md`);
    if (!executionDocument) throw new Error("AUTHORITY_TASK_COMPLETE_EXECUTION_DOCUMENT_REQUIRED");
    const current = executionDeclaration.documentCodec.decode(executionDocument.body) as ExecutionRecord;
    if (current.state === "accepted") {
      const transition = acceptedTaskCompletionTransition(taskId, contractBodySha256);
      return lifecycleIntent(transition.commandName, transition.payload, transition.mutations, transition.baseRefs,
        portableLifecyclePaths(taskPath, contractPath), canonicalEntityId, [
        taskSnapshot,
        contractCas
      ]);
    }
    const execution: ExecutionRecord = { ...current, state: "accepted", closed_at: completedAt };
    const payload: SessionExecutionReviewCommandPayloadV2 = {
      schema: "execution.close/v1", taskId, execution, taskIndexBody: taskBody,
      completionContractBodySha256: contractBodySha256
    };
    const executionPath = taskLifecyclePath(authoredRoot, taskId, `executions/${execution.execution_id}.md`);
    return lifecycleIntent("execution.close", encodeSessionExecutionReviewCommandPayloadV2(payload), [
      lifecycleMutation("execution", `execution/${taskId}/${execution.execution_id}`, "close"),
      lifecycleMutation("task", `task/${taskId}`, "transition")
    ], [
      lifecycleRef("execution", `execution/${taskId}/${execution.execution_id}`),
      lifecycleRef("task", `task/${taskId}`)
    ], portableLifecyclePaths(executionPath, taskPath, contractPath), canonicalEntityId, [
      requiredLifecycleSnapshot(authoredRoot, executionPath.logical, executionPath.physical),
      taskSnapshot,
      contractCas
    ]);
  }

  const evidencePath = taskLifecyclePath(authoredRoot, taskId, "completion-evidence.json");
  const closeoutPath = taskLifecyclePath(authoredRoot, taskId, "closeout.md");
  const codeDocPath = taskLifecyclePath(authoredRoot, taskId, "code-doc-anchors.json");
  const payload: SessionExecutionReviewCommandPayloadV2 = {
    schema: "completion.commit/v1",
    taskId,
    evidence: evaluation.evidence,
    taskIndexBody: taskBody,
    completionContractBodySha256: contractBodySha256
  };
  return lifecycleIntent("completion.commit", encodeSessionExecutionReviewCommandPayloadV2(payload), [
    lifecycleMutation("task", `task/${taskId}`, "transition")
  ], [lifecycleRef("task", `task/${taskId}`)], portableLifecyclePaths(
    evidencePath, taskPath, contractPath, closeoutPath, codeDocPath
  ), canonicalEntityId, [
    taskSnapshot,
    contractCas,
    requiredLifecycleSnapshot(authoredRoot, closeoutPath.logical, closeoutPath.physical),
    requiredLifecycleSnapshot(authoredRoot, codeDocPath.logical, codeDocPath.physical)
  ]);
}

function completionApplicableGates(
  action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "task-complete" }>
): ReadonlyArray<string> {
  if ((action.evidenceMode ?? "execution-review") !== "commit-anchor") return [];
  if (!action.completionApplicableGates) {
    throw new Error("AUTHORITY_TASK_COMPLETE_APPLICABLE_GATES_REQUIRED");
  }
  return action.completionApplicableGates;
}

function readTaskDocuments(taskRoot: string, relativeRoot = ""): ReadonlyArray<{ readonly path: string; readonly body: string }> {
  const current = path.join(taskRoot, relativeRoot);
  if (!existsSync(current)) return [];
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeRoot.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) return readTaskDocuments(taskRoot, relativePath);
    if (!entry.isFile()) return [];
    return [{ path: relativePath, body: readFileSync(path.join(taskRoot, relativePath), "utf8") }];
  });
}

function lifecycleIntent(
  commandName: string,
  payload: Uint8Array,
  mutations: CanonicalAttemptIntent["mutations"],
  baseRefs: ReadonlyArray<RegistryEntityRefV2>,
  portablePaths: ReadonlyArray<string>,
  physicalEntityId: string,
  declaredPathCas: CanonicalAttemptIntent["declaredPathCas"] = []
): CanonicalAttemptIntent {
  return { commandName, payload, mutations, baseRefs, portablePaths, physicalEntityId, declaredPathCas };
}

function lifecycleMutation(entityKind: string, canonicalRef: string, action: string) {
  return { entity: lifecycleRef(entityKind, canonicalRef), action };
}

function lifecycleRef(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function requiredLifecycleSnapshot(authoredRoot: string, logicalPath: string, physicalPath = logicalPath) {
  const snapshot = optionalLifecycleSnapshot(authoredRoot, logicalPath, physicalPath);
  if (!snapshot) throw new Error(`AUTHORITY_CANONICAL_HOST_DOCUMENT_REQUIRED:${physicalPath}`);
  return snapshot;
}

function optionalLifecycleSnapshot(authoredRoot: string, logicalPath: string, physicalPath = logicalPath) {
  const absolute = path.join(authoredRoot, physicalPath);
  if (!existsSync(absolute)) return null;
  const body = readFileSync(absolute, "utf8");
  const digest = sha256Text(body);
  return {
    path: logicalPath,
    body,
    expectedEpoch: digest,
    expectedRevision: 0n,
    expectedBlobDigest: Buffer.from(digest, "hex")
  };
}

function resolvedTaskRoot(authoredRoot: string, taskId: string): string {
  const rootDir = path.dirname(authoredRoot);
  return taskPackagePath({
    rootDir,
    layoutOverrides: { authoredRoot: path.relative(rootDir, authoredRoot) }
  }, taskId);
}

function taskLifecyclePath(authoredRoot: string, taskId: string, documentPath: string) {
  const physical = path.relative(authoredRoot, path.join(resolvedTaskRoot(authoredRoot, taskId), documentPath))
    .split(path.sep).join("/");
  return { logical: `tasks/${taskId}/${documentPath}`, physical };
}

function portableLifecyclePaths(...paths: ReadonlyArray<ReturnType<typeof taskLifecyclePath>>): ReadonlyArray<string> {
  return [...new Set(paths.flatMap((entry) => [entry.logical, entry.physical]))];
}
