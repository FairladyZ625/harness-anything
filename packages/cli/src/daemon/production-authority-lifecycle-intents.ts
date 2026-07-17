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
    const payload: TaskDecisionModuleCommandPayloadV2 = {
      schema: "task.transition/v1", taskId: action.taskId, to: action.status
    };
    return lifecycleIntent("task.transition", encodeTaskDecisionModuleCommandPayloadV2(payload), [
      lifecycleMutation("task", `task/${action.taskId}`, "transition")
    ], [lifecycleRef("task", `task/${action.taskId}`)], [`tasks/${action.taskId}/INDEX.md`], taskEntityId(action.taskId), [
      requiredLifecycleSnapshot(input.authoredRoot, `tasks/${action.taskId}/INDEX.md`)
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
    ], [`tasks/${action.taskId}/facts.md`], taskEntityId(action.taskId));
  }
  if (action.kind === "task-code-doc-reconcile") return codeDocIntent(input.authoredRoot, action);
  if (action.kind === "task-review-execution" && action.verdict === "approved") {
    return approvedReviewIntent(input.authoredRoot, input.canonicalEntityId, action);
  }
  if (action.kind === "task-complete") {
    return taskCompletionIntent(input.authoredRoot, input.currentSession.detectedAt, action.taskId);
  }
  return null;
}

function codeDocIntent(
  authoredRoot: string,
  action: Extract<ParsedCommand["action"], { readonly kind: "task-code-doc-reconcile" }>
): CanonicalAttemptIntent {
  const taskRoot = path.join(authoredRoot, "tasks", action.taskId);
  const documents = ["closeout.md", "review.md"]
    .filter((name) => existsSync(path.join(taskRoot, name)))
    .map((name) => ({ path: name, body: readFileSync(path.join(taskRoot, name), "utf8") }));
  const draft = renderCodeDocReconciliationDraft({
    taskId: action.taskId, documents, sha: action.sha, paths: action.paths, prRef: action.prRef
  });
  const payload: TaskDecisionModuleCommandPayloadV2 = {
    schema: "task.document/v1", taskId: action.taskId, path: "code-doc-anchors.json", body: draft.body
  };
  const portablePath = `tasks/${action.taskId}/code-doc-anchors.json`;
  const existing = optionalLifecycleSnapshot(authoredRoot, portablePath);
  return lifecycleIntent("task.document", encodeTaskDecisionModuleCommandPayloadV2(payload), [
    lifecycleMutation("task", `task/${action.taskId}`, "document")
  ], [lifecycleRef("task", `task/${action.taskId}`)], [portablePath], taskEntityId(action.taskId), existing ? [existing] : []);
}

function approvedReviewIntent(
  authoredRoot: string,
  canonicalEntityId: string,
  action: Extract<ParsedCommand["action"], { readonly kind: "task-review-execution" }>
): CanonicalAttemptIntent {
  if (!action.consentId) {
    throw new Error("AUTHORITY_APPROVED_REVIEW_CONSENT_ID_REQUIRED: record consent first and retry with --consent-id");
  }
  const reviewId = canonicalEntityId.replace(/^review\//u, "");
  const consentPath = `tasks/${action.taskId}/consents/${action.consentId}.md`;
  const storedConsent = optionalLifecycleSnapshot(authoredRoot, consentPath);
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
  const executionPath = `tasks/${action.taskId}/executions/${action.executionId}.md`;
  const taskPath = `tasks/${action.taskId}/INDEX.md`;
  return lifecycleIntent("consent.consume", encodeConsentCommandPayloadV2(payload), [
    ...(storedConsent ? [] : [lifecycleMutation("consent", `consent/${action.taskId}/${action.consentId}`, "grant")]),
    lifecycleMutation("consent", `consent/${action.taskId}/${action.consentId}`, "consume"),
    lifecycleMutation("review", `review/${action.taskId}/${reviewId}`, "record")
  ], [
    lifecycleRef("execution", `execution/${action.taskId}/${action.executionId}`),
    lifecycleRef("consent", `consent/${action.taskId}/${action.consentId}`),
    lifecycleRef("review", `review/${action.taskId}/${reviewId}`)
  ], [executionPath, taskPath, consentPath, `tasks/${action.taskId}/reviews/${reviewId}.md`], `review/${reviewId}`, [
    requiredLifecycleSnapshot(authoredRoot, executionPath),
    requiredLifecycleSnapshot(authoredRoot, taskPath),
    ...(storedConsent ? [storedConsent] : [])
  ]);
}

function taskCompletionIntent(authoredRoot: string, completedAt: string, taskId: string): CanonicalAttemptIntent {
  const executionRoot = path.join(authoredRoot, "tasks", taskId, "executions");
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
  const taskPath = `tasks/${taskId}/INDEX.md`;
  const taskSnapshot = requiredLifecycleSnapshot(authoredRoot, taskPath);
  const taskBody = taskSnapshot.body.replace(/^(  status:\s*).+$/mu, "$1done");
  const payload: SessionExecutionReviewCommandPayloadV2 = {
    schema: "execution.close/v1", taskId, execution, taskIndexBody: taskBody
  };
  const executionPath = `tasks/${taskId}/executions/${execution.execution_id}.md`;
  return lifecycleIntent("execution.close", encodeSessionExecutionReviewCommandPayloadV2(payload), [
    lifecycleMutation("execution", `execution/${taskId}/${execution.execution_id}`, "close"),
    lifecycleMutation("task", `task/${taskId}`, "transition")
  ], [
    lifecycleRef("execution", `execution/${taskId}/${execution.execution_id}`),
    lifecycleRef("task", `task/${taskId}`)
  ], [executionPath, taskPath], `execution/${execution.execution_id}`, [
    requiredLifecycleSnapshot(authoredRoot, executionPath), taskSnapshot
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

function requiredLifecycleSnapshot(authoredRoot: string, portablePath: string) {
  const snapshot = optionalLifecycleSnapshot(authoredRoot, portablePath);
  if (!snapshot) throw new Error(`AUTHORITY_CANONICAL_HOST_DOCUMENT_REQUIRED:${portablePath}`);
  return snapshot;
}

function optionalLifecycleSnapshot(authoredRoot: string, portablePath: string) {
  const absolute = path.join(authoredRoot, portablePath);
  if (!existsSync(absolute)) return null;
  const body = readFileSync(absolute, "utf8");
  const digest = sha256Text(body);
  return {
    path: portablePath,
    body,
    expectedEpoch: digest,
    expectedRevision: 0n,
    expectedBlobDigest: Buffer.from(digest, "hex")
  };
}
