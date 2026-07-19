import { Effect, Schema } from "effect";
import {
  computeExecutionConsentPin,
  consentDeclaration,
  executionDeclaration,
  generateTaskId,
  reviewDeclaration,
  sha256Text,
  stablePayloadHash,
  writeDeclaredEntityTransaction,
  type ArtifactStore,
  type ConsentAction,
  type ConsentRecord,
  type CurrentSessionRef,
  type ExecutionRecord,
  type HarnessLayoutInput,
  type ReviewRecord,
  type ReviewVerdict,
  type TaskHolderPrincipal,
  type WriteCoordinator
} from "../../kernel/src/index.ts";
import { assertExecutionTaskReviewable, executionHasArchiveWarnings } from "./execution-review-helpers.ts";
import {
  DEFAULT_HUMAN_CONSENT_ACTIONS,
  DEFAULT_HUMAN_CONSENT_TTL_MS,
  approvalCard,
  consentSnapshot,
  createConsentRecord,
  decodeConsentDocument,
  decodeExecutionForConsent,
  generateConsentId
} from "./execution-consent-helpers.ts";
import { consentSourceRequest, resolveConsentAuthorization } from "./consent-source-resolution.ts";
import type { RuntimeLogOptions } from "./runtime-session-logs.ts";

export interface ReviewExecutionService {
  readonly reviewExecution: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly reviewer: TaskHolderPrincipal;
    readonly reviewerSession: CurrentSessionRef;
    readonly findings: string;
    readonly evidenceChecked: ReadonlyArray<string>;
    readonly rationale: string;
    readonly verdict: ReviewVerdict;
    readonly archiveWarningsAcknowledged: boolean;
    readonly consentId?: string;
    readonly consentUtterance?: string;
    readonly consentStandingPolicyDecisionId?: string;
    readonly consentAssertedRationale?: string;
    readonly consentActions?: ReadonlyArray<ConsentAction>;
  }) => Promise<{ readonly review: ReviewRecord }>;
}

export function makeReviewExecutionService(options: {
  readonly rootInput: HarnessLayoutInput;
  readonly coordinator: WriteCoordinator;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
  readonly generateReviewId?: () => string;
  readonly generateConsentId?: () => string;
  readonly now?: () => string;
  readonly consentTtlMs?: number;
  readonly runtimeLogOptions?: RuntimeLogOptions;
}): ReviewExecutionService {
  const generateReviewId = options.generateReviewId ?? (() => `rev_${generateTaskId().slice("task_".length)}`);
  const nextConsentId = options.generateConsentId ?? generateConsentId;
  const now = options.now ?? (() => new Date().toISOString());
  const consentTtlMs = options.consentTtlMs ?? DEFAULT_HUMAN_CONSENT_TTL_MS;
  return {
    reviewExecution: async (input) => {
      const task = await Effect.runPromise(options.artifactStore.readTaskPackage(input.taskId));
      const executionDocument = task.documents.find((document) => document.path === `executions/${input.executionId}.md`);
      if (!executionDocument) throw new Error(`execution not found: ${input.executionId}`);
      const execution = decodeExecutionForConsent(executionDocument, input.taskId, input.executionId);
      if (execution.state !== "submitted") throw new Error(`execution is not submitted: ${input.executionId}`);
      assertExecutionTaskReviewable(task.documents, input.taskId);
      if (executionHasArchiveWarnings(execution) && !input.archiveWarningsAcknowledged) {
        throw new Error("execution archive warnings must be explicitly acknowledged by the reviewer");
      }
      const evidenceIds = new Set(execution.outputs.map((evidence) => evidence.evidence_id));
      const unknownEvidence = input.evidenceChecked.find((evidenceId) => !evidenceIds.has(evidenceId));
      if (unknownEvidence) throw new Error(`review evidence does not belong to execution ${input.executionId}: ${unknownEvidence}`);
      assertConsentInputShape(input, execution);

      const reviewId = generateReviewId();
      if (task.documents.some((document) => document.path === `reviews/${reviewId}.md`)) {
        throw new Error(`review already exists: ${reviewId}`);
      }
      const reviewedAt = now();
      const consent = input.verdict === "approved"
        ? await resolveApprovalConsent({
            rootInput: options.rootInput,
            taskId: input.taskId,
            execution,
            executionDocument,
            documents: task.documents,
            reviewer: input.reviewer,
            reviewerSession: input.reviewerSession,
            reviewId,
            reviewedAt,
            consentId: input.consentId,
            consentUtterance: input.consentUtterance,
            consentStandingPolicyDecisionId: input.consentStandingPolicyDecisionId,
            consentAssertedRationale: input.consentAssertedRationale,
            consentActions: input.consentActions,
            consentTtlMs,
            nextConsentId,
            coordinator: options.coordinator,
            runtimeLogOptions: options.runtimeLogOptions
          })
        : rejectUnexpectedConsent(input);
      const review: ReviewRecord = {
        schema: "review/v3",
        review_id: reviewId,
        task_ref: `task/${input.taskId}`,
        execution_ref: `execution/${input.taskId}/${input.executionId}`,
        reviewer_actor: input.reviewer,
        reviewer_session_ref: `session/${input.reviewerSession.sessionId}`,
        findings: input.findings,
        evidence_checked: input.evidenceChecked,
        rationale: input.rationale,
        verdict: input.verdict,
        archive_warnings_acknowledged: input.archiveWarningsAcknowledged,
        approval_basis: consent === null ? null : {
          kind: "human-consent",
          consent_ref: `consent/${input.taskId}/${consent.consumed.consent_id}`,
          consent_snapshot: consentSnapshot(consent.consumed)
        },
        reviewed_at: reviewedAt
      };
      const companionWrites = [
        ...(consent === null ? [] : [{
          taskId: input.taskId,
          path: `consents/${consent.consumed.consent_id}.md`,
          body: consentDeclaration.documentCodec.encode(consent.consumed)
        }]),
        ...(input.verdict === "changes_requested" ? [
            {
              taskId: input.taskId,
              path: `executions/${input.executionId}.md`,
              body: executionDeclaration.documentCodec.encode({ ...execution, state: "changes_requested", closed_at: reviewedAt })
            }
          ] : []),
        {
          taskId: input.taskId,
          path: "INDEX.md",
          body: reviewedTaskIndex(task.documents, input.taskId, input.executionId, input.verdict)
        }
      ];
      await Effect.runPromise(writeDeclaredEntityTransaction(
        options.coordinator,
        stablePayloadHash,
        reviewDeclaration,
        { taskId: input.taskId, reviewId },
        review,
        companionWrites,
        [
          { taskId: input.taskId, path: `executions/${input.executionId}.md`, bodySha256: sha256Text(executionDocument.body) },
          { taskId: input.taskId, path: `reviews/${reviewId}.md`, bodySha256: null },
          {
            taskId: input.taskId,
            path: "INDEX.md",
            bodySha256: sha256Text(requiredDocumentBody(task.documents, "INDEX.md", input.taskId))
          },
          ...(consent === null ? [] : [{
            taskId: input.taskId,
            path: `consents/${consent.consumed.consent_id}.md`,
            bodySha256: consent.openDocumentSha256
          }])
        ]
      ));
      return { review };
    }
  };
}

function assertConsentInputShape(input: {
  readonly verdict: ReviewVerdict;
  readonly consentId?: string;
  readonly consentUtterance?: string;
  readonly consentStandingPolicyDecisionId?: string;
  readonly consentAssertedRationale?: string;
  readonly consentActions?: ReadonlyArray<ConsentAction>;
}, execution: ExecutionRecord): void {
  if (input.verdict !== "approved") {
    rejectUnexpectedConsent(input);
    return;
  }
  const createSourceCount = [input.consentUtterance, input.consentStandingPolicyDecisionId, input.consentAssertedRationale]
    .filter(Boolean).length;
  if ((input.consentId ? 1 : 0) + createSourceCount > 1) {
    throw new Error("approved review accepts either --consent or exactly one consent source declaration");
  }
  if (!input.consentId && createSourceCount === 0) {
    throw new Error([
      approvalCard(execution),
      `After the human replies, rerun with --consent-utterance "<their exact words>", --consent-standing-policy <active-decision-id>, or --consent-asserted "<why the external approval is being asserted>"; an existing consent id may also be passed with --consent.`,
      "Do not invent a second reviewer identity. No Review was written."
    ].join("\n"));
  }
}

interface ResolvedApprovalConsent {
  readonly consumed: ConsentRecord;
  readonly openDocumentSha256: string | null;
}

async function resolveApprovalConsent(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly taskId: string;
  readonly execution: ExecutionRecord;
  readonly executionDocument: { readonly path: string; readonly body: string };
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly reviewer: TaskHolderPrincipal;
  readonly reviewerSession: CurrentSessionRef;
  readonly reviewId: string;
  readonly reviewedAt: string;
  readonly consentId?: string;
  readonly consentUtterance?: string;
  readonly consentStandingPolicyDecisionId?: string;
  readonly consentAssertedRationale?: string;
  readonly consentActions?: ReadonlyArray<ConsentAction>;
  readonly consentTtlMs: number;
  readonly nextConsentId: () => string;
  readonly coordinator: WriteCoordinator;
  readonly runtimeLogOptions?: RuntimeLogOptions;
}): Promise<ResolvedApprovalConsent> {
  if (input.consentUtterance || input.consentStandingPolicyDecisionId || input.consentAssertedRationale) {
    const consentId = input.nextConsentId();
    if (input.documents.some((document) => document.path === `consents/${consentId}.md`)) {
      throw new Error(`consent already exists: ${consentId}`);
    }
    const authorization = await resolveConsentAuthorization({
      rootInput: input.rootInput,
      execution: input.execution,
      request: consentSourceRequest({
        utterance: input.consentUtterance,
        standingPolicyDecisionId: input.consentStandingPolicyDecisionId,
        assertedRationale: input.consentAssertedRationale
      }),
      runtimeLogOptions: input.runtimeLogOptions
    });
    const consumed = createConsentRecord({
      consentId,
      taskId: input.taskId,
      execution: input.execution,
      actor: input.reviewer,
      authorization,
      actions: input.consentActions ?? DEFAULT_HUMAN_CONSENT_ACTIONS,
      grantedAt: input.reviewedAt,
      ttlMs: input.consentTtlMs,
      state: "consumed",
      consumedBy: `review/${input.taskId}/${input.reviewId}`,
      consumedAt: input.reviewedAt
    });
    return {
      consumed: Schema.decodeUnknownSync(consentDeclaration.schema)(consumed) as ConsentRecord,
      openDocumentSha256: null
    };
  }

  if (input.consentActions !== undefined) {
    throw new Error("--consent-action is only valid when creating consent with an explicit source declaration");
  }
  const consentId = input.consentId;
  if (!consentId) throw new Error("approved review requires consent");
  const consentDocument = input.documents.find((document) => document.path === `consents/${consentId}.md`);
  if (!consentDocument) throw new Error(`consent not found: ${consentId}`);
  const consent = decodeConsentDocument(consentDocument, input.taskId, consentId);
  if (consent.state !== "open") {
    throw new Error(`consent ${consent.consent_id} is ${consent.state} and cannot be replayed; ask the human again`);
  }
  const reviewedMs = Date.parse(input.reviewedAt);
  const expiresMs = Date.parse(consent.expires_at);
  if (!Number.isFinite(reviewedMs) || !Number.isFinite(expiresMs)) throw new Error(`consent ${consent.consent_id} has invalid timestamps`);
  if (reviewedMs >= expiresMs) {
    const expired = Schema.decodeUnknownSync(consentDeclaration.schema)({ ...consent, state: "expired" }) as ConsentRecord;
    await Effect.runPromise(writeDeclaredEntityTransaction(
      input.coordinator,
      stablePayloadHash,
      consentDeclaration,
      { taskId: input.taskId, consentId: consent.consent_id },
      expired,
      [],
      [
        { taskId: input.taskId, path: input.executionDocument.path, bodySha256: sha256Text(input.executionDocument.body) },
        { taskId: input.taskId, path: consentDocument.path, bodySha256: sha256Text(consentDocument.body) }
      ]
    ));
    throw new Error(`consent ${consent.consent_id} expired at ${consent.expires_at}; ask the human again`);
  }
  if (consent.execution_ref !== `execution/${input.taskId}/${input.execution.execution_id}`) {
    throw new Error(`consent ${consent.consent_id} is bound to a different execution`);
  }
  if (consent.principal.personId !== input.reviewer.principal.personId) {
    throw new Error(`consent ${consent.consent_id} belongs to a different principal`);
  }
  if (!consent.scope.actions.includes("approve_execution")) {
    throw new Error(`consent ${consent.consent_id} does not grant approve_execution`);
  }
  const currentPin = computeExecutionConsentPin(input.execution);
  if (consent.scope.content_pin.digest !== currentPin) {
    throw new Error([
      `consent ${consent.consent_id} is bound to ${consent.scope.content_pin.digest}, but the current Execution is ${currentPin}`,
      "Delivery changed after consent. Ask the human again; do not reuse the old consent or change HARNESS_ACTOR."
    ].join("\n"));
  }
  const consumed = Schema.decodeUnknownSync(consentDeclaration.schema)({
    ...consent,
    state: "consumed",
    consumed_by: `review/${input.taskId}/${input.reviewId}`,
    consumed_at: input.reviewedAt
  }) as ConsentRecord;
  return { consumed, openDocumentSha256: sha256Text(consentDocument.body) };
}

function rejectUnexpectedConsent(input: {
  readonly verdict: ReviewVerdict;
  readonly consentId?: string;
  readonly consentUtterance?: string;
  readonly consentStandingPolicyDecisionId?: string;
  readonly consentAssertedRationale?: string;
  readonly consentActions?: ReadonlyArray<ConsentAction>;
}): null {
  if (input.consentId || input.consentUtterance || input.consentStandingPolicyDecisionId || input.consentAssertedRationale || input.consentActions !== undefined) {
    throw new Error(`${input.verdict} review does not accept or consume human consent`);
  }
  return null;
}

function reviewedTaskIndex(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string,
  reviewedExecutionId: string,
  verdict: ReviewVerdict
): string {
  const body = documents.find((document) => document.path === "INDEX.md")?.body;
  if (!body) throw new Error(`task INDEX.md missing: ${taskId}`);
  if (!/^  engine:\s*local$/mu.test(body)) throw new Error(`task is not local: ${taskId}`);
  const submittedOthers = documents
    .filter((document) => /^executions\/[^/]+\.md$/u.test(document.path)
      && document.path !== `executions/${reviewedExecutionId}.md`)
    .map((document) => Schema.decodeUnknownSync(executionDeclaration.schema)(
      executionDeclaration.documentCodec.decode(document.body)
    ) as ExecutionRecord)
    .filter((execution) => execution.state === "submitted");
  const next = verdict === "changes_requested" && submittedOthers.length === 0 ? "active" : "in_review";
  return body.replace(/^(  status:\s*).+$/mu, `$1${next}`);
}

function requiredDocumentBody(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  path: string,
  taskId: string
): string {
  const body = documents.find((document) => document.path === path)?.body;
  if (!body) throw new Error(`task document missing for ${taskId}: ${path}`);
  return body;
}
