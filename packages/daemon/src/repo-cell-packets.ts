import { createHash } from "node:crypto";
import {
  approvedReviewsForCut,
  consentedApprovedReview,
  makeTaskEventStore,
  reviewDigest,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { validateGuiSubmission, type GuiSubmissionV1 } from "./protocol/daemon-protocol.contract.ts";
import { reviewJsonFields, taskSubmissionJsonFields } from "./protocol/daemon-protocol-commands-task.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { gateChecks } from "./repo-cell-proof.ts";
import { requiredCellText } from "./repo-cell-settlement.ts";
import type { PublicPublication, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { readWorkspaceText } from "./workspace-text-port.ts";

export function packetJson(value: unknown, fields: readonly string[]): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredCellText(value, "jsonInput"));
  } catch {
    throw cellCodedError(
      "invalid_command",
      `Structured input must be one UTF-8 JSON object with exactly these required fields: ${fields.join(", ")}.`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join("\0") !== [...fields].sort().join("\0")
  )
    throw cellCodedError("invalid_command", `JSON packet requires exactly: ${fields.join(", ")}.`);
  return parsed as Record<string, unknown>;
}

export function workspaceText(rootDir: string, requestedValue: unknown, field: string): string {
  return readWorkspaceText(rootDir, requiredCellText(requestedValue, field), field);
}

export function packetFile(
  rootDir: string,
  value: unknown,
  fields: readonly string[],
): {
  readonly value: Record<string, unknown>;
  readonly digest: `sha256:${string}`;
} {
  const body = workspaceText(rootDir, value, "fromFile"),
    parsed = packetJson(body, fields);
  return {
    value: parsed,
    digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  };
}

export function reviewPacket(
  rootDir: string,
  action: RepoTaskAction,
): {
  readonly value: Record<string, unknown>;
  readonly digest: `sha256:${string}`;
} {
  if (action.jsonInput !== undefined && action.fromFile !== undefined)
    throw cellCodedError(
      "invalid_command",
      "Review accepts either the public fromFile packet or one daemon-internal JSON packet, not both.",
    );
  const body =
    action.jsonInput === undefined
      ? workspaceText(rootDir, action.fromFile, "fromFile")
      : requiredCellText(action.jsonInput, "jsonInput");
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
    digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  };
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
  const fromFile = action.fromFile !== undefined,
    jsonInput = action.jsonInput !== undefined;
  if (action.submission !== undefined && (fromFile || jsonInput))
    throw cellCodedError(
      "invalid_command",
      "Submit accepts either its RPC submission or one CLI JSON source, not both.",
    );
  if (action.submission === undefined && fromFile === jsonInput)
    throw cellCodedError(
      "invalid_command",
      "Use exactly one submission source: --json-input <json> or workspace-local --from-file <path>.",
    );
  const value =
      action.submission ??
      (jsonInput
        ? packetJson(action.jsonInput, taskSubmissionJsonFields)
        : packetFile(rootDir, action.fromFile, taskSubmissionJsonFields).value),
    issues = validateGuiSubmission(value);
  if (issues.length) throw cellCodedError("invalid_submission", issues.join("; "));
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
    reviews = execution?.submission
      ? snapshot.reviews.filter(
          (value) =>
            value.executionId === executionId &&
            value.commitSha === execution.submission?.commitSha &&
            value.iteration === execution.iteration,
        )
      : [],
    approved = execution?.submission
      ? approvedReviewsForCut(snapshot.reviews, executionId ?? "", execution.submission.commitSha, execution.iteration)
      : [],
    selected = execution?.submission
      ? consentedApprovedReview(
          snapshot.reviews,
          snapshot.consents,
          executionId ?? "",
          execution.submission.commitSha,
          execution.iteration,
        )
      : undefined,
    eventReview =
      event.type === "review_recorded" || event.type === "review_consent_recorded" ? event.payload.review : undefined,
    receiptReview = eventReview ?? selected?.review ?? (reviews.length === 1 ? reviews[0] : undefined),
    reviewId = receiptReview?.reviewId ?? null,
    declarationNeeded = undeclared && reviews.length === 0,
    consentReviewId = approved.length === 1 ? approved[0]!.reviewId : "<review-id>",
    from =
      event.type === "execution_started"
        ? "planned/implementation"
        : event.type === "execution_submitted"
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
              : !approved.length
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
      event.type === "execution_started" && undeclared
        ? [
            "Execution declared no executor; a same-person review will require an ",
            "audited agent executor declaration before review.",
          ].join("")
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
