import { Schema } from "effect";
import {
  computeExecutionConsentPin,
  consentDeclaration,
  entityRegistry,
  executionDeclaration,
  reviewDeclaration,
  sha256Text,
  type ConsentRecord,
  type EntityId,
  type ExecutionRecord,
  type RegistryMutationPlanInput,
  type ReviewRecord,
  type WriteOp
} from "../../../kernel/src/index.ts";
import {
  assertConsentActions,
  consentSnapshot,
  createConsentRecord,
  DEFAULT_HUMAN_CONSENT_TTL_MS
} from "../execution-consent-helpers.ts";
import {
  assertExecutionTaskInReview,
  executionHasArchiveWarnings
} from "../execution-review-helpers.ts";
import {
  decodeConsentCommandPayloadV2,
  type ConsentCommandPayloadV2,
  type ConsentConsumePayloadV2,
  type ConsentExpirePayloadV2,
  type ConsentGrantPayloadV2
} from "./consent-command-v2.ts";
import {
  type AuthoritySemanticCompilerContextV2,
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
  consentTypedCommandsV2,
  encodeConsentCommandPayloadV2,
  type ConsentCommandPayloadV2,
  type ConsentConsumePayloadV2,
  type ConsentExpirePayloadV2,
  type ConsentGrantPayloadV2,
  type ConsentReviewInputV2,
  type ConsentTypedCommandV2
} from "./consent-command-v2.ts";

export interface ConsentAuthorityStateV2 {
  readonly readEntityBase: (entityRef: RegistryEntityRefV2) => Promise<SemanticEntityBaseV2 | null>;
  readonly readHostedDocument: (path: string) => Promise<HostedDocumentSnapshotV2 | null>;
}

export interface ConsentSemanticCompilerV2Options {
  readonly state: ConsentAuthorityStateV2;
  readonly ttlMs?: number;
}

interface CompiledConsentCommandV2 {
  readonly mutationPlan: RegistryMutationPlanInput;
  readonly operation: WriteOp;
  readonly requiredBaseRefs: ReadonlyArray<RegistryEntityRefV2>;
  readonly requiredPathSnapshots: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }>;
}

const registryVersion = 1;

export function makeConsentSemanticCompilerV2(options: ConsentSemanticCompilerV2Options): AuthoritySemanticCompilerV2 {
  const ttlMs = options.ttlMs ?? DEFAULT_HUMAN_CONSENT_TTL_MS;
  return {
    compile: async (envelope, context) => {
      if (!context) throw admission("AUTHORITY_COMPILER_CONTEXT_REQUIRED");
      const { payload, decodedBytes } = decodeConsentCommandPayloadV2(envelope);
      const compiled = await compileConsentPayloadV2(options.state, payload, context, ttlMs);
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

async function compileConsentPayloadV2(
  state: ConsentAuthorityStateV2,
  payload: ConsentCommandPayloadV2,
  context: AuthoritySemanticCompilerContextV2,
  ttlMs: number
): Promise<CompiledConsentCommandV2> {
  if (payload.schema === "consent.grant/v1") return compileConsentGrantV2(state, payload, context, ttlMs);
  if (payload.schema === "consent.consume/v1") return compileConsentConsumeV2(state, payload, context, ttlMs);
  return compileConsentExpireV2(state, payload, context);
}

async function compileConsentGrantV2(
  state: ConsentAuthorityStateV2,
  payload: ConsentGrantPayloadV2,
  context: AuthoritySemanticCompilerContextV2,
  ttlMs: number
): Promise<CompiledConsentCommandV2> {
  requireConsentActionsV2(payload.actions);
  const executionPath = consentStoragePathV2("execution", { taskId: payload.taskId, executionId: payload.executionId });
  const consentPath = consentStoragePathV2("consent", { taskId: payload.taskId, consentId: payload.consentId });
  const executionSnapshot = await requiredConsentDocumentV2(state, executionPath, "EXECUTION_DOCUMENT_NOT_FOUND");
  if (await state.readHostedDocument(consentPath)) throw admission("CONSENT_ALREADY_EXISTS");
  const execution = decodeConsentExecutionV2(executionSnapshot.body, payload.taskId, payload.executionId);
  const now = consentCompilerNowV2(context);
  const consent = createConsentRecord({
    consentId: payload.consentId,
    taskId: payload.taskId,
    execution,
    actor: context.actor,
    session: consentCompilerSessionV2(context, now),
    utterance: payload.utterance,
    actions: payload.actions,
    grantedAt: now,
    ttlMs
  });
  return {
    mutationPlan: plan([{ entityKind: "consent", identity: { taskId: payload.taskId, consentId: payload.consentId }, action: "grant" }]),
    operation: consentDeclaredOperationV2(
      "consent",
      payload.consentId,
      consentDeclaration,
      { taskId: payload.taskId, consentId: payload.consentId },
      consentDeclaration.documentCodec.encode(consent),
      [],
      [
        consentPreconditionV2(payload.taskId, `executions/${payload.executionId}.md`, executionSnapshot.body),
        consentPreconditionV2(payload.taskId, `consents/${payload.consentId}.md`, null)
      ]
    ),
    requiredBaseRefs: [
      consentRefV2("execution", `execution/${payload.taskId}/${payload.executionId}`),
      consentRefV2("consent", `consent/${payload.taskId}/${payload.consentId}`)
    ],
    requiredPathSnapshots: [{ path: executionPath, snapshot: executionSnapshot }]
  };
}

async function compileConsentConsumeV2(
  state: ConsentAuthorityStateV2,
  payload: ConsentConsumePayloadV2,
  context: AuthoritySemanticCompilerContextV2,
  ttlMs: number
): Promise<CompiledConsentCommandV2> {
  const executionPath = consentStoragePathV2("execution", { taskId: payload.taskId, executionId: payload.executionId });
  const consentPath = consentStoragePathV2("consent", { taskId: payload.taskId, consentId: payload.consentId });
  const reviewPath = consentStoragePathV2("review", { taskId: payload.taskId, reviewId: payload.review.reviewId });
  const taskIndexPath = `tasks/${encodeURIComponent(payload.taskId)}/INDEX.md`;
  const executionSnapshot = await requiredConsentDocumentV2(state, executionPath, "EXECUTION_DOCUMENT_NOT_FOUND");
  const taskIndexSnapshot = await requiredConsentDocumentV2(state, taskIndexPath, "TASK_INDEX_DOCUMENT_NOT_FOUND");
  if (await state.readHostedDocument(reviewPath)) throw admission("REVIEW_ALREADY_EXISTS");
  const execution = decodeConsentExecutionV2(executionSnapshot.body, payload.taskId, payload.executionId);
  assertConsentReviewContextV2(payload, execution, taskIndexSnapshot.body);
  const storedConsent = await state.readHostedDocument(consentPath);
  const now = consentCompilerNowV2(context);
  const open = storedConsent
    ? existingConsentForConsumeV2(storedConsent.body, payload, execution, context, now)
    : newConsentForConsumeV2(payload, execution, context, now, ttlMs);
  const consumed = decodeConsentRecordV2({
    ...open,
    state: "consumed",
    consumed_by: `review/${payload.taskId}/${payload.review.reviewId}`,
    consumed_at: now
  });
  const review: ReviewRecord = {
    schema: "review/v3",
    review_id: payload.review.reviewId,
    task_ref: `task/${payload.taskId}`,
    execution_ref: `execution/${payload.taskId}/${payload.executionId}`,
    reviewer_actor: context.actor,
    reviewer_session_ref: `session/${context.sessionId}`,
    findings: payload.review.findings,
    evidence_checked: payload.review.evidenceChecked,
    rationale: payload.review.rationale,
    verdict: "approved",
    archive_warnings_acknowledged: payload.review.archiveWarningsAcknowledged,
    approval_basis: {
      kind: "human-consent",
      consent_ref: `consent/${payload.taskId}/${payload.consentId}`,
      consent_snapshot: consentSnapshot(consumed)
    },
    reviewed_at: now
  };
  const mutations: RegistryMutationPlanInput["mutations"] = [
    ...(storedConsent ? [] : [{ entityKind: "consent", identity: { taskId: payload.taskId, consentId: payload.consentId }, action: "grant" }]),
    { entityKind: "consent", identity: { taskId: payload.taskId, consentId: payload.consentId }, action: "consume" },
    { entityKind: "review", identity: { taskId: payload.taskId, reviewId: payload.review.reviewId }, action: "record" }
  ];
  return {
    mutationPlan: plan(mutations),
    operation: consentDeclaredOperationV2(
      "review",
      payload.review.reviewId,
      reviewDeclaration,
      { taskId: payload.taskId, reviewId: payload.review.reviewId },
      reviewDeclaration.documentCodec.encode(review),
      [{ taskId: payload.taskId, path: `consents/${payload.consentId}.md`, body: consentDeclaration.documentCodec.encode(consumed) }],
      [
        consentPreconditionV2(payload.taskId, `executions/${payload.executionId}.md`, executionSnapshot.body),
        consentPreconditionV2(payload.taskId, "INDEX.md", taskIndexSnapshot.body),
        consentPreconditionV2(payload.taskId, `reviews/${payload.review.reviewId}.md`, null),
        consentPreconditionV2(payload.taskId, `consents/${payload.consentId}.md`, storedConsent?.body ?? null)
      ]
    ),
    requiredBaseRefs: [
      consentRefV2("execution", `execution/${payload.taskId}/${payload.executionId}`),
      consentRefV2("consent", `consent/${payload.taskId}/${payload.consentId}`),
      consentRefV2("review", `review/${payload.taskId}/${payload.review.reviewId}`)
    ],
    requiredPathSnapshots: [
      { path: executionPath, snapshot: executionSnapshot },
      { path: taskIndexPath, snapshot: taskIndexSnapshot },
      ...(storedConsent ? [{ path: consentPath, snapshot: storedConsent }] : [])
    ]
  };
}

function assertConsentReviewContextV2(
  payload: ConsentConsumePayloadV2,
  execution: ExecutionRecord,
  taskIndexBody: string
): void {
  try {
    assertExecutionTaskInReview([{ path: "INDEX.md", body: taskIndexBody }], payload.taskId);
  } catch {
    throw admission("REVIEW_TASK_NOT_IN_REVIEW");
  }
  if (executionHasArchiveWarnings(execution) && !payload.review.archiveWarningsAcknowledged) {
    throw admission("REVIEW_ARCHIVE_WARNING_ACK_REQUIRED");
  }
  const executionEvidence = new Set(execution.outputs.map((entry) => entry.evidence_id));
  if (payload.review.evidenceChecked.some((evidenceId) => !executionEvidence.has(evidenceId))) {
    throw admission("REVIEW_EVIDENCE_NOT_IN_EXECUTION");
  }
}

async function compileConsentExpireV2(
  state: ConsentAuthorityStateV2,
  payload: ConsentExpirePayloadV2,
  context: AuthoritySemanticCompilerContextV2
): Promise<CompiledConsentCommandV2> {
  const consentPath = consentStoragePathV2("consent", { taskId: payload.taskId, consentId: payload.consentId });
  const snapshot = await requiredConsentDocumentV2(state, consentPath, "CONSENT_DOCUMENT_NOT_FOUND");
  const open = decodeConsentDocumentV2(snapshot.body, payload.taskId, payload.consentId);
  if (open.state !== "open") throw admission("CONSENT_NOT_OPEN");
  const now = consentCompilerNowV2(context);
  if (Date.parse(now) < Date.parse(open.expires_at)) throw admission("CONSENT_NOT_EXPIRED");
  const expired = decodeConsentRecordV2({ ...open, state: "expired", consumed_by: null, consumed_at: null });
  return {
    mutationPlan: plan([{ entityKind: "consent", identity: { taskId: payload.taskId, consentId: payload.consentId }, action: "expire" }]),
    operation: consentDeclaredOperationV2(
      "consent",
      payload.consentId,
      consentDeclaration,
      { taskId: payload.taskId, consentId: payload.consentId },
      consentDeclaration.documentCodec.encode(expired),
      [],
      [consentPreconditionV2(payload.taskId, `consents/${payload.consentId}.md`, snapshot.body)]
    ),
    requiredBaseRefs: [consentRefV2("consent", `consent/${payload.taskId}/${payload.consentId}`)],
    requiredPathSnapshots: [{ path: consentPath, snapshot }]
  };
}

function existingConsentForConsumeV2(
  body: string,
  payload: ConsentConsumePayloadV2,
  execution: ExecutionRecord,
  context: AuthoritySemanticCompilerContextV2,
  now: string
): ConsentRecord {
  if (payload.utterance !== null || payload.actions.length !== 0) throw admission("CONSENT_EXISTING_INPUT_INVALID");
  const consent = decodeConsentDocumentV2(body, payload.taskId, payload.consentId);
  if (consent.state !== "open") throw admission("CONSENT_NOT_OPEN");
  if (consent.principal.personId !== context.actor.principal.personId) throw admission("CONSENT_PRINCIPAL_MISMATCH");
  if (consent.execution_ref !== `execution/${payload.taskId}/${payload.executionId}`) throw admission("CONSENT_EXECUTION_MISMATCH");
  if (Date.parse(now) >= Date.parse(consent.expires_at)) throw admission("CONSENT_EXPIRED");
  if (!consent.scope.actions.includes("approve_execution")) throw admission("CONSENT_APPROVAL_SCOPE_REQUIRED");
  if (consent.scope.content_pin.digest !== computeExecutionConsentPin(execution)) throw admission("CONSENT_CONTENT_PIN_MISMATCH");
  return consent;
}

function newConsentForConsumeV2(
  payload: ConsentConsumePayloadV2,
  execution: ExecutionRecord,
  context: AuthoritySemanticCompilerContextV2,
  now: string,
  ttlMs: number
): ConsentRecord {
  if (payload.utterance === null) throw admission("CONSENT_DOCUMENT_NOT_FOUND");
  requireConsentActionsV2(payload.actions);
  return createConsentRecord({
    consentId: payload.consentId,
    taskId: payload.taskId,
    execution,
    actor: context.actor,
    session: consentCompilerSessionV2(context, now),
    utterance: payload.utterance,
    actions: payload.actions,
    grantedAt: now,
    ttlMs
  });
}

function decodeConsentExecutionV2(body: string, taskId: string, executionId: string): ExecutionRecord {
  let execution: ExecutionRecord;
  try {
    execution = Schema.decodeUnknownSync(executionDeclaration.schema)(executionDeclaration.documentCodec.decode(body)) as ExecutionRecord;
  } catch {
    throw admission("EXECUTION_DOCUMENT_INVALID");
  }
  if (execution.task_ref !== `task/${taskId}` || execution.execution_id !== executionId
    || execution.state !== "submitted" || execution.submission === null) {
    throw admission("EXECUTION_NOT_SUBMITTED");
  }
  return execution;
}

function decodeConsentDocumentV2(body: string, taskId: string, consentId: string): ConsentRecord {
  const consent = decodeConsentRecordV2(consentDeclaration.documentCodec.decode(body));
  if (consent.task_ref !== `task/${taskId}` || consent.consent_id !== consentId) throw admission("CONSENT_IDENTITY_MISMATCH");
  return consent;
}

function decodeConsentRecordV2(value: unknown): ConsentRecord {
  try {
    return Schema.decodeUnknownSync(consentDeclaration.schema)(value) as ConsentRecord;
  } catch {
    throw admission("CONSENT_DOCUMENT_INVALID");
  }
}

function requireConsentActionsV2(actions: ReadonlyArray<ConsentRecord["scope"]["actions"][number]>): void {
  try {
    assertConsentActions(actions);
  } catch {
    throw admission("CONSENT_ACTION_SCOPE_INVALID");
  }
}

function consentDeclaredOperationV2(
  kind: "consent" | "review",
  id: string,
  declaration: { readonly storageForm: string; readonly rootResolver?: unknown },
  identity: Readonly<Record<string, string>>,
  body: string,
  companionWrites: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly body: string }>,
  preconditions: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly bodySha256: string | null }>
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
        body
      },
      companionWrites,
      preconditions
    }
  };
}

function consentPreconditionV2(taskId: string, path: string, body: string | null): {
  readonly taskId: string;
  readonly path: string;
  readonly bodySha256: string | null;
} {
  return { taskId, path, bodySha256: body === null ? null : sha256Text(body) };
}

async function requiredConsentDocumentV2(
  state: ConsentAuthorityStateV2,
  path: string,
  code: string
): Promise<HostedDocumentSnapshotV2> {
  const snapshot = await state.readHostedDocument(path);
  if (!snapshot) throw admission(code);
  return snapshot;
}

function consentStoragePathV2(
  kind: "execution" | "consent" | "review",
  identity: Readonly<Record<string, string>>
): string {
  const locator = entityRegistry[kind].storageLocator;
  if (locator.status !== "ready") throw admission("REGISTRY_FACET_NOT_WRITABLE");
  const target = locator.locator.locate(identity, {}).targets.find((candidate) => candidate.kind === "document");
  if (!target?.path) throw admission("ENTITY_STORAGE_TARGET_REQUIRED");
  return target.path;
}

function consentRefV2(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion, entityKind, canonicalRef };
}

function consentCompilerNowV2(context: AuthoritySemanticCompilerContextV2): string {
  const numeric = Number(context.nowMs);
  if (!Number.isSafeInteger(numeric)) throw admission("AUTHORITY_TIME_INVALID");
  const value = new Date(numeric).toISOString();
  if (Number.isNaN(Date.parse(value))) throw admission("AUTHORITY_TIME_INVALID");
  return value;
}

function consentCompilerSessionV2(
  context: AuthoritySemanticCompilerContextV2,
  detectedAt: string
): { readonly runtime: "human" | "codex"; readonly sessionId: string; readonly source: "runtime"; readonly detectedAt: string } {
  return {
    runtime: context.actor.executor ? "codex" : "human",
    sessionId: context.sessionId,
    source: "runtime",
    detectedAt
  };
}
