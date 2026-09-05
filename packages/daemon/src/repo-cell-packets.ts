import { createHash } from "node:crypto";
import {
  approvedReviewHistoryForExecution,
  approvedReviewsForExecution,
  consentedApprovedReviewForExecution,
  makeTaskEventStore,
  reviewDigest,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { validateGuiSubmission, type GuiSubmissionV1 } from "./protocol/daemon-protocol.contract.ts";
import { reviewJsonFields, taskSubmissionJsonFields } from "./protocol/daemon-protocol-commands-task.ts";
import { validationDiagnostic } from "./protocol/daemon-protocol-validate-entities.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { gateChecks } from "./repo-cell-proof.ts";
import { requiredCellText } from "./repo-cell-settlement.ts";
import type { PublicPublication, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { readWorkspaceText } from "./workspace-text-port.ts";

export function packetJson(
  value: unknown,
  fields: readonly string[],
  entity = "JSON packet",
  defaults: Readonly<Record<string, unknown>> = {},
  allowedFields = fields,
): { readonly value: Record<string, unknown>; readonly defaultedFields: readonly string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredCellText(value, "jsonInput"));
  } catch {
    throw cellCodedError(
      "invalid_command",
      `Structured input must be one UTF-8 JSON object with required fields: ${fields.join(", ")}.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw cellCodedError(
      "invalid_command",
      `JSON packet requires an object with required fields: ${fields.join(", ")}.`,
    );
  const packet = parsed as Record<string, unknown>,
    present = Object.keys(packet),
    missing = fields.filter((field) => !present.includes(field)),
    defaultedDescription = Object.keys(defaults).join(", ") || "none";
  if (missing.length)
    throw cellCodedError("missing_field", `JSON packet is missing required fields: ${missing.join(", ")}.`, {
      kind: "validation",
      entity,
      field: missing[0]!,
      actual: "missing",
      expectation: `Required fields: ${fields.join(", ")}; defaulted when omitted: ${defaultedDescription}`,
    });
  const allowed = [...allowedFields, ...Object.keys(defaults)];
  if (present.some((field) => !allowed.includes(field)))
    throw cellCodedError("invalid_command", `JSON packet accepts only: ${allowed.join(", ")}.`);
  const defaultedFields = Object.keys(defaults).filter((field) => !Object.hasOwn(packet, field));
  return { value: { ...defaults, ...packet }, defaultedFields };
}

export function workspaceText(rootDir: string, requestedValue: unknown, field: string): string {
  return readWorkspaceText(rootDir, requiredCellText(requestedValue, field), field);
}

export function readPacketSource(rootDir: string, action: Readonly<Record<string, unknown>>): string {
  const fromFile = action.fromFile !== undefined,
    jsonInput = action.jsonInput !== undefined;
  if (fromFile === jsonInput)
    throw cellCodedError(
      "invalid_command",
      "Use exactly one structured input source: --from-file <path> or --json-input <json>.",
    );
  return fromFile
    ? workspaceText(rootDir, action.fromFile, "fromFile")
    : requiredCellText(action.jsonInput, "jsonInput");
}

export function packetRecord(
  rootDir: string,
  action: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  entity?: string,
  defaults?: Readonly<Record<string, unknown>>,
  allowedFields?: readonly string[],
): {
  readonly value: Record<string, unknown>;
  readonly digest: `sha256:${string}`;
  readonly defaultedFields: readonly string[];
} {
  const body = readPacketSource(rootDir, action);
  const parsed = packetJson(body, fields, entity, defaults, allowedFields);
  return {
    value: parsed.value,
    digest: packetDigest(body),
    defaultedFields: parsed.defaultedFields,
  };
}

export function reviewPacket(
  rootDir: string,
  action: RepoTaskAction,
): {
  readonly value: Record<string, unknown>;
  readonly digest: `sha256:${string}`;
} {
  const body = readPacketSource(rootDir, action);
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body) as unknown,
      standardFields = [...reviewJsonFields].sort().join("\0"),
      externalFields = [...reviewJsonFields, "externalCompletionAnchor", "noDispatchReason"].sort().join("\0"),
      noIndependentReviewFields = [...reviewJsonFields, "noIndependentReview", "noIndependentReviewReason"]
        .sort()
        .join("\0");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const fields = Object.keys(parsed).sort().join("\0");
    if (fields !== standardFields && fields !== externalFields && fields !== noIndependentReviewFields)
      throw new Error("unexpected fields");
    value = parsed as Record<string, unknown>;
  } catch {
    throw cellCodedError(
      "invalid_command",
      `Review JSON requires exactly ${reviewJsonFields.join(", ")}, or those fields plus ` +
        "externalCompletionAnchor and noDispatchReason, or noIndependentReview and noIndependentReviewReason.",
    );
  }
  return {
    value,
    digest: packetDigest(body),
  };
}

function packetDigest(body: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/**
 * The optional review-qualification fields a RecordReview command carries when a same-person
 * review is justified without a dispatch: an external completion anchor, or an explicit
 * no-independent-review weak mark. Kept beside the packet field-set validation so the two field
 * families stay described in one place.
 */
export function reviewQualificationFields(value: Record<string, unknown>): {
  readonly externalCompletionAnchor?: string;
  readonly noDispatchReason?: string;
  readonly noIndependentReview?: boolean;
  readonly noIndependentReviewReason?: string;
} {
  return {
    ...(value.externalCompletionAnchor === undefined
      ? {}
      : {
          externalCompletionAnchor: requiredCellText(value.externalCompletionAnchor, "externalCompletionAnchor"),
          noDispatchReason: requiredCellText(value.noDispatchReason, "noDispatchReason"),
        }),
    ...(value.noIndependentReview === undefined
      ? {}
      : {
          noIndependentReview: value.noIndependentReview === true,
          noIndependentReviewReason: requiredCellText(value.noIndependentReviewReason, "noIndependentReviewReason"),
        }),
  };
}

export function submissionPacket(action: RepoTaskAction, rootDir: string): GuiSubmissionV1 {
  const hasPacketSource = action.fromFile !== undefined || action.jsonInput !== undefined;
  if (action.submission !== undefined && hasPacketSource)
    throw cellCodedError(
      "invalid_command",
      "Submit accepts either its RPC submission or one CLI JSON source, not both.",
    );
  const value = action.submission ?? packetRecord(rootDir, action, taskSubmissionJsonFields, "task submission").value,
    issues = validateGuiSubmission(value);
  if (issues.length) {
    const first = validationDiagnostic(issues[0]!);
    throw cellCodedError(
      "invalid_submission",
      issues.join("; "),
      first
        ? {
            ...first,
            entity: "task submission",
            expectation:
              `${first.expectation}; fix the packet, then retry ha task submit ${String(action.taskId)} ` +
              `--execution-id ${String(action.executionId)} --from-file <submission.json>`,
          }
        : undefined,
    );
  }
  return value as unknown as GuiSubmissionV1;
}

export function lifecycleReceipt(
  event: Extract<ReturnType<ReturnType<typeof makeTaskEventStore>["readEvent"]>, { readonly schema: "task-event/v1" }>,
  snapshot: Snapshot,
  publication: PublicPublication,
  proof: NonNullable<WriteReceipt["proof"]>,
  authorizationDecision: WriteReceipt["authorizationDecision"] = undefined,
): WriteReceipt {
  const executionId = "execution" in event.payload ? event.payload.execution.executionId : null,
    execution = snapshot.executions.find((value) => value.executionId === executionId),
    undeclared = execution?.actor.executor === null,
    reviews = execution?.submission ? approvedReviewsForExecution(snapshot.reviews, execution) : [],
    approved = reviews,
    approvedHistory = execution?.submission ? approvedReviewHistoryForExecution(snapshot.reviews, execution) : [],
    selected = execution?.submission
      ? consentedApprovedReviewForExecution(snapshot.reviews, snapshot.consents, execution)
      : undefined,
    eventReview =
      event.type === "review_recorded" || event.type === "review_consent_recorded" ? event.payload.review : undefined,
    receiptReview = eventReview ?? selected?.review ?? (reviews.length === 1 ? reviews[0] : undefined),
    reviewId = receiptReview?.reviewId ?? null,
    declarationNeeded = snapshot.task?.status === "in_review" && undeclared && reviews.length === 0,
    consentCandidates = approved.length ? approved : approvedHistory,
    consentReviewId = consentCandidates.length === 1 ? consentCandidates[0]!.reviewId : "<review-id>",
    from =
      event.type === "execution_started"
        ? "planned/implementation"
        : event.type === "execution_submitted" && event.payload.supersedesSubmissionId === undefined
          ? "active/implementation"
          : "in_review/review",
    to = `${snapshot.task?.status ?? "missing"}/${snapshot.task?.currentNode ?? "missing"}`,
    checks = gateChecks(snapshot, executionId ?? ""),
    missingGate = checks.find((value) => value.status === "blocked")?.gate,
    nextCommand =
      event.type === "lease_released" && snapshot.task?.status === "active"
        ? `ha task transition ${event.taskId} planned --reason <why-work-is-returning-to-planning>`
        : snapshot.task?.status === "active" && executionId
          ? `ha task submit ${event.taskId} --json-input '<submission-json>'`
          : snapshot.task?.status === "active"
            ? `ha task start ${event.taskId} --execution-id <id>`
            : snapshot.task?.status !== "in_review"
              ? null
              : !approved.length && !approvedHistory.length
                ? declarationNeeded
                  ? [
                      "ha task declare-executor ",
                      `${event.taskId}`,
                      " --execution-id ",
                      `${executionId}`,
                      " --reason <auditable-recovery-reason>",
                    ].join("")
                  : [
                      "ha task review-execution ",
                      `${event.taskId}`,
                      " --execution-id ",
                      `${executionId}`,
                      " --review-id <id> --from-file <review.json>",
                    ].join("")
                : !selected
                  ? [
                      "ha task review-consent ",
                      `${event.taskId}`,
                      " --execution-id ",
                      `${executionId}`,
                      " --review-id ",
                      `${consentReviewId}`,
                      " --consent-id <id>",
                    ].join("")
                  : missingGate === "ci"
                    ? `ha task complete ${event.taskId} --execution-id ${executionId} --ci passed`
                    : missingGate === "code-doc-reconciliation"
                      ? `ha task closeout ${event.taskId} --from-file <packet.json>`
                      : `ha task complete ${event.taskId} --execution-id ${executionId}`,
    next = nextCommand
      ? [
          {
            command: nextCommand,
            reason: declarationNeeded
              ? [
                  "This Execution declared no executor; record an auditable executor ",
                  "declaration before same-person review.",
                ].join("")
              : "Run the canonical next command for this lifecycle state.",
          },
        ]
      : [],
    changedPaths = (event.payload.documentClaims ?? []).map((claim) => claim.path),
    summary =
      event.type === "execution_submitted" && event.payload.supersedesSubmissionId !== undefined
        ? "Submission amended; prior Review and consent pins are stale until reviewed or explicitly consented again."
        : undefined;
  return {
    outcome: "applied",
    opId: event.opId,
    revision: event.workspaceRevision,
    evidence: `event-object:${event.opId};files:${changedPaths.join(",")}`,
    visibility: "center",
    proof,
    authorizationDecision,
    taskId: event.taskId,
    executionId,
    reviewId,
    reviewDigest: receiptReview ? reviewDigest(receiptReview) : null,
    contentDigest: receiptReview?.contentDigest ?? null,
    transition: { from, to },
    gateChecks: checks,
    next,
    changedPaths,
    eventId: event.eventId,
    ...publication,
    worktreeVisible: true,
    ...(summary ? { summary } : {}),
  } as WriteReceipt;
}
