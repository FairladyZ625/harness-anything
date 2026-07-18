import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  encodeConsentCommandPayloadV2,
  encodeFactRelationCommandPayloadV2,
  encodeSessionExecutionReviewCommandPayloadV2,
  encodeTaskDecisionModuleCommandPayloadV2,
  renderCodeDocReconciliationDraft,
  type ConsentCommandPayloadV2,
  type FactRelationCommandPayloadV2,
  type SessionExecutionReviewCommandPayloadV2,
  type TaskDecisionModuleCommandPayloadV2
} from "../../../application/src/index.ts";
import {
  executionDeclaration,
  deriveRelationId,
  sha256Text,
  taskEntityId,
  taskPackagePath,
  type ExecutionRecord,
  type RegistryEntityRefV2
} from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "../cli/types.ts";
import type { DaemonAuthorityAttemptCompilerV2 } from "./authority-command-submission.ts";
import type { CanonicalAttemptIntent } from "./production-authority-attempt-compiler.ts";

type CompileInput = Parameters<DaemonAuthorityAttemptCompilerV2["compile"]>[0];

export function productionLifecycleAttemptIntent(input: {
  readonly command: ParsedCommand;
  readonly currentSession: CompileInput["currentSession"];
  readonly canonicalEntityId: string;
  readonly authoredRoot: string;
}): CanonicalAttemptIntent | null {
  const { action } = input.command;
  if (action.kind === "status-set") {
    const taskPath = taskLifecyclePath(input.authoredRoot, action.taskId, "INDEX.md");
    if (action.executionSubmission?.executionId) {
      return executionSubmitIntent(input.authoredRoot, input.currentSession.detectedAt, action, taskPath);
    }
    const payload: TaskDecisionModuleCommandPayloadV2 = {
      schema: "task.transition/v1", taskId: action.taskId, to: action.status
    };
    return lifecycleIntent("task.transition", encodeTaskDecisionModuleCommandPayloadV2(payload), [
      lifecycleMutation("task", `task/${action.taskId}`, "transition")
    ], [lifecycleRef("task", `task/${action.taskId}`)], portableLifecyclePaths(taskPath), taskEntityId(action.taskId), [
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
  if (action.kind === "task-review-execution" && action.verdict === "approved") {
    return approvedReviewIntent(input.authoredRoot, input.canonicalEntityId, action);
  }
  if (action.kind === "task-complete") {
    return taskCompletionIntent(input.authoredRoot, input.currentSession.detectedAt, action.taskId, input.canonicalEntityId);
  }
  return null;
}

function executionSubmitIntent(
  authoredRoot: string,
  submittedAt: string,
  action: Extract<ParsedCommand["action"], { readonly kind: "status-set" }>,
  taskPath: ReturnType<typeof taskLifecyclePath>
): CanonicalAttemptIntent {
  const submission = action.executionSubmission!;
  const executionId = submission.executionId!;
  const executionPath = taskLifecyclePath(authoredRoot, action.taskId, `executions/${executionId}.md`);
  const executionSnapshot = requiredLifecycleSnapshot(authoredRoot, executionPath.logical, executionPath.physical);
  const taskSnapshot = requiredLifecycleSnapshot(authoredRoot, taskPath.logical, taskPath.physical);
  const current = executionDeclaration.documentCodec.decode(executionSnapshot.body) as ExecutionRecord;
  const next: ExecutionRecord = {
    ...current,
    state: "submitted",
    submitted_at: submittedAt,
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
  action: Extract<ParsedCommand["action"], { readonly kind: "task-code-doc-reconcile" }>
): CanonicalAttemptIntent {
  const taskRoot = resolvedTaskRoot(authoredRoot, action.taskId);
  const documents = ["closeout.md", "review.md"]
    .filter((name) => existsSync(path.join(taskRoot, name)))
    .map((name) => ({ path: name, body: readFileSync(path.join(taskRoot, name), "utf8") }));
  const draft = renderCodeDocReconciliationDraft({
    taskId: action.taskId, documents, sha: action.sha, paths: action.paths, prRef: action.prRef
  });
  const payload: TaskDecisionModuleCommandPayloadV2 = {
    schema: "task.document/v1", taskId: action.taskId, path: "code-doc-anchors.json", body: draft.body
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
  action: Extract<ParsedCommand["action"], { readonly kind: "task-review-execution" }>
): CanonicalAttemptIntent {
  if (!action.consentId) {
    throw new Error("AUTHORITY_APPROVED_REVIEW_CONSENT_ID_REQUIRED: record consent first and retry with --consent-id");
  }
  const reviewId = canonicalEntityId.replace(/^(?:entity\/)?review\//u, "");
  const consentPath = taskLifecyclePath(authoredRoot, action.taskId, `consents/${action.consentId}.md`);
  const storedConsent = optionalLifecycleSnapshot(authoredRoot, consentPath.logical, consentPath.physical);
  const payload: ConsentCommandPayloadV2 = {
    schema: "consent.consume/v1", taskId: action.taskId, executionId: action.executionId,
    consentId: action.consentId,
    utterance: storedConsent ? null : action.consentUtterance ?? null,
    actions: storedConsent ? [] : action.consentActions ?? ["approve_execution", "complete_task"],
    review: {
      reviewId, findings: action.findings, evidenceChecked: action.evidenceChecked,
      rationale: action.rationale, archiveWarningsAcknowledged: action.archiveWarningsAcknowledged
    }
  };
  const executionPath = taskLifecyclePath(authoredRoot, action.taskId, `executions/${action.executionId}.md`);
  const taskPath = taskLifecyclePath(authoredRoot, action.taskId, "INDEX.md");
  const reviewPath = taskLifecyclePath(authoredRoot, action.taskId, `reviews/${reviewId}.md`);
  return lifecycleIntent("consent.consume", encodeConsentCommandPayloadV2(payload), [
    ...(storedConsent ? [] : [lifecycleMutation("consent", `consent/${action.taskId}/${action.consentId}`, "grant")]),
    lifecycleMutation("consent", `consent/${action.taskId}/${action.consentId}`, "consume"),
    lifecycleMutation("review", `review/${action.taskId}/${reviewId}`, "record")
  ], [
    lifecycleRef("execution", `execution/${action.taskId}/${action.executionId}`),
    lifecycleRef("consent", `consent/${action.taskId}/${action.consentId}`),
    lifecycleRef("review", `review/${action.taskId}/${reviewId}`)
  ], portableLifecyclePaths(executionPath, taskPath, consentPath, reviewPath), canonicalEntityId, [
    requiredLifecycleSnapshot(authoredRoot, executionPath.logical, executionPath.physical),
    requiredLifecycleSnapshot(authoredRoot, taskPath.logical, taskPath.physical),
    ...(storedConsent ? [storedConsent] : [])
  ]);
}

function taskCompletionIntent(authoredRoot: string, completedAt: string, taskId: string, canonicalEntityId: string): CanonicalAttemptIntent {
  const executionRoot = path.join(resolvedTaskRoot(authoredRoot, taskId), "executions");
  const executions = existsSync(executionRoot)
    ? readdirSync(executionRoot).filter((name) => name.endsWith(".md")).map((name) => ({
      name,
      record: executionDeclaration.documentCodec.decode(readFileSync(path.join(executionRoot, name), "utf8")) as ExecutionRecord
    }))
    : [];
  const submitted = executions.filter(({ record }) => record.state === "submitted");
  if (submitted.length !== 1 || executions.some(({ record }) => record.state === "active")) {
    throw new Error("AUTHORITY_TASK_COMPLETE_EXECUTION_SET_UNSUPPORTED: completion requires exactly one submitted execution and no stale active execution");
  }
  const current = submitted[0]!.record;
  const execution: ExecutionRecord = { ...current, state: "accepted", closed_at: completedAt };
  const taskPath = taskLifecyclePath(authoredRoot, taskId, "INDEX.md");
  const taskSnapshot = requiredLifecycleSnapshot(authoredRoot, taskPath.logical, taskPath.physical);
  const taskBody = taskSnapshot.body.replace(/^(  status:\s*).+$/mu, "$1done");
  const payload: SessionExecutionReviewCommandPayloadV2 = {
    schema: "execution.close/v1", taskId, execution, taskIndexBody: taskBody
  };
  const executionPath = taskLifecyclePath(authoredRoot, taskId, `executions/${execution.execution_id}.md`);
  return lifecycleIntent("execution.close", encodeSessionExecutionReviewCommandPayloadV2(payload), [
    lifecycleMutation("execution", `execution/${taskId}/${execution.execution_id}`, "close"),
    lifecycleMutation("task", `task/${taskId}`, "transition")
  ], [
    lifecycleRef("execution", `execution/${taskId}/${execution.execution_id}`),
    lifecycleRef("task", `task/${taskId}`)
  ], portableLifecyclePaths(executionPath, taskPath), canonicalEntityId, [
    requiredLifecycleSnapshot(authoredRoot, executionPath.logical, executionPath.physical), taskSnapshot
  ]);
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
