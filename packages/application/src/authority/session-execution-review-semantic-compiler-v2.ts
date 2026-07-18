import { Schema } from "effect";
import {
  entityRegistry,
  executionDeclaration,
  reviewDeclaration,
  sha256Text,
  stablePayloadHash,
  type EntityId,
  type ExecutionRecord,
  type RegistryMutationPlanInput,
  type ReviewRecord,
  type SessionManifest,
  type WriteOp
} from "../../../kernel/src/index.ts";
import {
  decodeSessionExecutionReviewCommandPayloadV2,
  type ExecutionActionPayloadV2,
  type ReviewActionPayloadV2,
  type SessionActionPayloadV2,
  type SessionExecutionReviewCommandPayloadV2
} from "./session-execution-review-command-v2.ts";
import {
  type AuthoritySemanticCompilerV2,
  type RegistryEntityRefV2
} from "./semantic-mutation-envelope-v2.ts";
import {
  semanticAdmissionV2 as admission,
  semanticMutationPlanV2 as plan,
  verifySemanticBaseCasV2,
  verifySemanticPathCasV2
} from "./semantic-authority-helpers-v2.ts";
import type {
  HostedDocumentSnapshotV2,
  SemanticEntityBaseV2
} from "./fact-relation-semantic-compiler-v2.ts";

export {
  encodeSessionExecutionReviewCommandPayloadV2,
  sessionExecutionReviewTypedCommandsV2,
  type ExecutionActionPayloadV2,
  type ReviewActionPayloadV2,
  type SessionActionPayloadV2,
  type SessionExecutionReviewCommandPayloadV2,
  type SessionExecutionReviewTypedCommandV2
} from "./session-execution-review-command-v2.ts";

export interface SessionExecutionReviewAuthorityStateV2 {
  readonly readEntityBase: (entityRef: RegistryEntityRefV2) => Promise<SemanticEntityBaseV2 | null>;
  readonly readHostedDocument: (path: string) => Promise<HostedDocumentSnapshotV2 | null>;
}

export interface SessionExecutionReviewSemanticCompilerV2Options {
  readonly state: SessionExecutionReviewAuthorityStateV2;
}

interface CompiledSessionExecutionReviewCommandV2 {
  readonly mutationPlan: RegistryMutationPlanInput;
  readonly operation: WriteOp;
  readonly requiredBaseRefs: ReadonlyArray<RegistryEntityRefV2>;
  readonly requiredPathSnapshots: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }>;
}

const registryVersion = 1;

export function makeSessionExecutionReviewSemanticCompilerV2(
  options: SessionExecutionReviewSemanticCompilerV2Options
): AuthoritySemanticCompilerV2 {
  return {
    compile: async (envelope) => {
      const { payload, decodedBytes } = decodeSessionExecutionReviewCommandPayloadV2(envelope);
      const compiled = await compileSessionExecutionReviewPayloadV2(options.state, payload);
      await verifySemanticBaseCasV2(
        options.state,
        envelope.intent.kind === "typed" ? envelope.intent.baseCas : [],
        compiled.requiredBaseRefs
      );
      verifySemanticPathCasV2(
        envelope.intent.kind === "typed" ? envelope.intent.declaredPathCas : [],
        compiled.requiredPathSnapshots
      );
      return { mutationPlan: compiled.mutationPlan, operation: compiled.operation, decodedBytes };
    }
  };
}

async function compileSessionExecutionReviewPayloadV2(
  state: SessionExecutionReviewAuthorityStateV2,
  payload: SessionExecutionReviewCommandPayloadV2
): Promise<CompiledSessionExecutionReviewCommandV2> {
  if (payload.schema.startsWith("session.")) return compileSession(state, payload as SessionActionPayloadV2);
  if (payload.schema.startsWith("execution.")) return compileExecution(state, payload as ExecutionActionPayloadV2);
  return compileReview(state, payload as ReviewActionPayloadV2);
}

async function compileSession(
  state: SessionExecutionReviewAuthorityStateV2,
  payload: SessionActionPayloadV2
): Promise<CompiledSessionExecutionReviewCommandV2> {
  const action = sessionAction(payload.schema);
  const { manifest, body } = payload;
  assertSessionBody(manifest, body);
  if (action === "archive" && manifest.lifecycle !== "archived") throw admission("SESSION_ARCHIVE_STATE_REQUIRED");
  if (action !== "archive" && manifest.lifecycle === "archived") throw admission("SESSION_ARCHIVE_ACTION_REQUIRED");
  const path = storagePath("session", { sessionId: manifest.sessionId });
  const snapshot = await state.readHostedDocument(path);
  if (action === "export" && snapshot) throw admission("SESSION_ALREADY_EXISTS");
  if (action === "archive" && !snapshot) throw admission("SESSION_DOCUMENT_NOT_FOUND");
  const declaration = entityRegistry.session;
  return {
    mutationPlan: plan([{
      entityKind: "session",
      identity: { sessionId: manifest.sessionId },
      action
    }]),
    operation: declaredDocumentOperation(
      "session",
      manifest.sessionId,
      declaration,
      { sessionId: manifest.sessionId },
      declaration.documentCodec.encode(manifest),
      { blobRef: manifest.bodyRef, blobBody: body }
    ),
    requiredBaseRefs: [ref("session", `session/${encodeURIComponent(manifest.sessionId)}`)],
    requiredPathSnapshots: snapshot ? [{ path, snapshot }] : []
  };
}

async function compileExecution(
  state: SessionExecutionReviewAuthorityStateV2,
  payload: ExecutionActionPayloadV2
): Promise<CompiledSessionExecutionReviewCommandV2> {
  const action = executionAction(payload.schema);
  const execution = payload.execution;
  assertExecutionIdentity(payload.taskId, execution);
  const path = storagePath("execution", { taskId: payload.taskId, executionId: execution.execution_id });
  const snapshot = await state.readHostedDocument(path);
  const current = snapshot ? decodeExecutionDocument(snapshot.body) : null;
  assertExecutionTransition(action, current, execution);
  const taskPath = `tasks/${encodeURIComponent(payload.taskId)}/INDEX.md`;
  const taskSnapshot = payload.taskIndexBody === undefined ? null : await state.readHostedDocument(taskPath);
  if (payload.taskIndexBody !== undefined) {
    if (!taskSnapshot || !(
      (action === "close" && execution.state === "accepted")
      || (action === "submit" && execution.state === "submitted")
    )) {
      throw admission("EXECUTION_COMPLETION_TRANSACTION_INVALID");
    }
    const fromStatus = action === "close" ? "in_review" : "active";
    const toStatus = action === "close" ? "done" : "in_review";
    const expected = taskSnapshot.body.replace(/^(  status:\s*).+$/mu, `$1${toStatus}`);
    if (!new RegExp(`^  status:\\s*${fromStatus}$`, "mu").test(taskSnapshot.body) || payload.taskIndexBody !== expected) {
      throw admission("EXECUTION_COMPLETION_TASK_TRANSITION_INVALID");
    }
  }
  const mutations: RegistryMutationPlanInput["mutations"] = [{
    entityKind: "execution", identity: { taskId: payload.taskId, executionId: execution.execution_id }, action
  }, ...(payload.taskIndexBody === undefined ? [] : [{
    entityKind: "task", identity: { taskId: payload.taskId }, action: "transition",
    storageContext: { documentPath: "INDEX.md" }
  }])];
  return {
    mutationPlan: plan(mutations),
    operation: declaredDocumentOperation(
      "execution",
      execution.execution_id,
      executionDeclaration,
      { taskId: payload.taskId, executionId: execution.execution_id },
      executionDeclaration.documentCodec.encode(execution),
      undefined,
      payload.taskIndexBody === undefined ? undefined : {
        companionWrites: [{ taskId: payload.taskId, path: "INDEX.md", body: payload.taskIndexBody }],
        preconditions: [
          { taskId: payload.taskId, path: `executions/${execution.execution_id}.md`, bodySha256: sha256Text(snapshot!.body) },
          { taskId: payload.taskId, path: "INDEX.md", bodySha256: sha256Text(taskSnapshot!.body) }
        ]
      }
    ),
    requiredBaseRefs: [
      ref("execution", `execution/${encodeURIComponent(payload.taskId)}/${encodeURIComponent(execution.execution_id)}`),
      ...(payload.taskIndexBody === undefined ? [] : [ref("task", `task/${payload.taskId}`)])
    ],
    requiredPathSnapshots: [
      ...(snapshot ? [{ path, snapshot }] : []),
      ...(taskSnapshot ? [{ path: taskPath, snapshot: taskSnapshot }] : [])
    ]
  };
}

async function compileReview(
  state: SessionExecutionReviewAuthorityStateV2,
  payload: ReviewActionPayloadV2
): Promise<CompiledSessionExecutionReviewCommandV2> {
  const action = reviewAction(payload.schema);
  const review = payload.review;
  assertReviewIdentity(payload.taskId, review);
  if (review.verdict === "approved") {
    throw admission("REVIEW_APPROVAL_REQUIRES_CONSENT_TRANSACTION");
  }
  if (review.approval_basis !== null) throw admission("REVIEW_NON_APPROVAL_BASIS_FORBIDDEN");
  if (action === "dismiss" && review.verdict !== "dismissed") throw admission("REVIEW_DISMISS_VERDICT_REQUIRED");
  if (action === "record" && review.verdict === "dismissed") throw admission("REVIEW_RECORD_VERDICT_REQUIRED");
  const path = storagePath("review", { taskId: payload.taskId, reviewId: review.review_id });
  const snapshot = await state.readHostedDocument(path);
  if (snapshot) throw admission("REVIEW_ALREADY_EXISTS");
  return {
    mutationPlan: plan([{
      entityKind: "review",
      identity: { taskId: payload.taskId, reviewId: review.review_id },
      action
    }]),
    operation: declaredDocumentOperation(
      "review",
      review.review_id,
      reviewDeclaration,
      { taskId: payload.taskId, reviewId: review.review_id },
      reviewDeclaration.documentCodec.encode(review)
    ),
    requiredBaseRefs: [ref("review", `review/${encodeURIComponent(payload.taskId)}/${encodeURIComponent(review.review_id)}`)],
    requiredPathSnapshots: []
  };
}

function assertSessionBody(manifest: SessionManifest, body: string): void {
  const bytes = Buffer.from(body, "utf8");
  if (manifest.bodyRef.sha256 !== sha256Text(body) || manifest.bodyRef.size !== bytes.byteLength) {
    throw admission("SESSION_BODY_REF_MISMATCH");
  }
  if (!manifest.bodyRef.mediaType.trim()) throw admission("SESSION_BODY_MEDIA_TYPE_REQUIRED");
}

function assertExecutionIdentity(taskId: string, execution: ExecutionRecord): void {
  if (execution.task_ref !== `task/${taskId}`) throw admission("EXECUTION_TASK_REF_MISMATCH");
}

function assertExecutionTransition(
  action: "claim" | "submit" | "close",
  current: ExecutionRecord | null,
  next: ExecutionRecord
): void {
  if (action === "claim") {
    if (current) throw admission("EXECUTION_ALREADY_EXISTS");
    if (next.state !== "active" || next.submitted_at !== null || next.closed_at !== null || next.submission !== null) {
      throw admission("EXECUTION_CLAIM_STATE_INVALID");
    }
    return;
  }
  if (!current) throw admission("EXECUTION_DOCUMENT_NOT_FOUND");
  assertSameExecution(current, next);
  if (action === "submit") {
    if (current.state !== "active" || next.state !== "submitted" || next.submitted_at === null
      || next.closed_at !== null || next.submission === null || !arrayPrefix(current.outputs, next.outputs)) {
      throw admission("EXECUTION_SUBMIT_STATE_INVALID");
    }
    return;
  }
  if ((current.state !== "submitted" && current.state !== "changes_requested")
    || (next.state !== "accepted" && next.state !== "abandoned") || next.closed_at === null) {
    throw admission("EXECUTION_CLOSE_STATE_INVALID");
  }
  if (!same(current.session_bindings, next.session_bindings)
    || !same(current.outputs, next.outputs) || !same(current.submission, next.submission)) {
    throw admission("EXECUTION_CLOSE_PAYLOAD_INVALID");
  }
}

function assertSameExecution(current: ExecutionRecord, next: ExecutionRecord): void {
  if (current.execution_id !== next.execution_id || current.task_ref !== next.task_ref
    || current.claimed_at !== next.claimed_at || !same(current.primary_actor, next.primary_actor)) {
    throw admission("EXECUTION_IMMUTABLE_FIELD_CHANGED");
  }
}

function assertReviewIdentity(taskId: string, review: ReviewRecord): void {
  if (review.task_ref !== `task/${taskId}` || !review.execution_ref.startsWith(`execution/${taskId}/`)) {
    throw admission("REVIEW_HOST_REF_MISMATCH");
  }
}

function decodeExecutionDocument(body: string): ExecutionRecord {
  try {
    return Schema.decodeUnknownSync(executionDeclaration.schema)(
      executionDeclaration.documentCodec.decode(body)
    ) as ExecutionRecord;
  } catch {
    throw admission("EXECUTION_DOCUMENT_INVALID");
  }
}

function declaredDocumentOperation(
  kind: "session" | "execution" | "review",
  id: string,
  declaration: {
    readonly storageForm: string;
    readonly rootResolver?: unknown;
  },
  identity: Readonly<Record<string, string>>,
  body: string,
  blob?: { readonly blobRef: SessionManifest["bodyRef"]; readonly blobBody: string },
  transaction?: {
    readonly companionWrites: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly body: string }>;
    readonly preconditions: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly bodySha256: string | null }>;
  }
): WriteOp {
  if (!declaration.rootResolver) throw admission("ENTITY_ROOT_RESOLVER_REQUIRED");
  return {
    opId: "authority-overrides-this",
    entityId: `entity/${kind}/${id}` as EntityId,
    kind: "doc_write",
    payload: {
      entityDocument: {
        declaration: { kind, storageForm: declaration.storageForm, rootResolver: declaration.rootResolver },
        identity,
        body,
        ...(blob ? blob : {})
      },
      ...(transaction ?? {})
    }
  };
}

function storagePath(
  kind: "session" | "execution" | "review",
  identity: Readonly<Record<string, string>>
): string {
  const locator = entityRegistry[kind].storageLocator;
  if (locator.status !== "ready") throw admission("REGISTRY_FACET_NOT_WRITABLE");
  const target = locator.locator.locate(identity, {}).targets.find((candidate) => candidate.kind === "document");
  if (!target?.path) throw admission("ENTITY_STORAGE_TARGET_REQUIRED");
  return target.path;
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion, entityKind, canonicalRef };
}

function sessionAction(schema: SessionActionPayloadV2["schema"]): "export" | "sync" | "archive" {
  return schema.slice("session.".length, -"/v1".length) as "export" | "sync" | "archive";
}

function executionAction(schema: ExecutionActionPayloadV2["schema"]): "claim" | "submit" | "close" {
  return schema.slice("execution.".length, -"/v1".length) as "claim" | "submit" | "close";
}

function reviewAction(schema: ReviewActionPayloadV2["schema"]): "create" | "dismiss" | "record" {
  return schema.slice("review.".length, -"/v1".length) as "create" | "dismiss" | "record";
}

function arrayPrefix<T>(prefix: ReadonlyArray<T>, value: ReadonlyArray<T>): boolean {
  return prefix.length <= value.length && prefix.every((entry, index) => same(entry, value[index]));
}

function same(left: unknown, right: unknown): boolean {
  return stablePayloadHash(left) === stablePayloadHash(right);
}
