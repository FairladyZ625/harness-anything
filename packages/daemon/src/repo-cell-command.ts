import { createHash } from "node:crypto";
import {
  canonicalCodeDocPaths,
  currentExecutionCuts,
  currentSubmittedExecutions,
  heldLeaseForExecutionActor,
  getExecutableEntityAction,
  isDomainStatus,
  makeTaskEventStore,
  normalizeTaskLifecycleCommand,
  reviewDigest,
  type TaskLifecycleCommand,
} from "../../kernel/src/index.ts";
import { consentJsonFields } from "../../preset/src/index.ts";
import { type DaemonGuiReadResultMap } from "./protocol/daemon-protocol.contract.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import {
  explicitExecutionId,
  reviewExecutionSelection,
  reviewConsentSelection,
  uniqueDerivedExecutionId,
} from "./repo-cell-execution-selection.ts";
import { packetRecord, reviewPacket, reviewQualificationFields, submissionPacket } from "./repo-cell-packets.ts";
import { actorHint, operationId } from "./repo-cell-proof.ts";
import { digest, reviewVerdict } from "./repo-cell-review-lint.ts";
import { cellStringList, requiredCellText } from "./repo-cell-settlement.ts";
import type {
  DaemonGuiReadHandlers,
  RepoCellBinding,
  RepoCellReadMethod,
  RepoTaskAction,
  Snapshot,
} from "./repo-cell-types.ts";

const CODE_DOC_REPOINT_FIELDS = ["kind", "taskId", "record", "paths", "reason"];
export function dispatchRead<M extends RepoCellReadMethod>(
  handlers: DaemonGuiReadHandlers,
  method: M,
  payload: Readonly<Record<string, unknown>>,
): DaemonGuiReadResultMap[M] {
  return handlers[method](payload);
}

function submittedExecutionWitness(
  action: RepoTaskAction,
  snapshot: Snapshot,
  taskId: string,
  allowed: string[],
  paths: readonly string[],
) {
  const unsupported = Object.keys(action).filter((field) => !allowed.includes(field));
  if (unsupported.length)
    throw cellCodedError(
      "invalid_command",
      `Run ha task code-doc ${action.kind.split("-").at(-1)} ${taskId} without ${unsupported.join(", ")}; ` +
        "the submitted execution supplies the witness cut.",
    );
  const executions = currentExecutionCuts(snapshot),
    found = executions.map((value) => value.executionId).join(", ") || "none",
    witnessError = `Expected one code-doc witness; found ${found}. Run ha task show ${taskId}.`;
  if (executions.length !== 1) throw cellCodedError("invalid_command", witnessError);
  const execution = executions[0]!;
  return {
    executionId: execution.executionId,
    commitSha: execution.submission!.commitSha,
    iteration: execution.iteration,
    paths,
  };
}

export function buildCommand(
  action: RepoTaskAction,
  taskId: string,
  binding: RepoCellBinding,
  workspaceId: string,
  expectedRevision: number,
  rootDir: string,
  snapshot: Snapshot,
): Omit<TaskLifecycleCommand, "eventId" | "workspaceRevision" | "occurredAt"> {
  const bound = {
      workspaceId,
      actor: binding.actor,
      source: binding.source,
      expectedRevision,
    },
    lifecycleAction = getExecutableEntityAction(action.kind)?.execution?.lifecycle;
  if (lifecycleAction?.coordination === "reserve") {
    const executionId =
      typeof action.executionId === "string" && action.executionId
        ? action.executionId
        : (snapshot.executions.find((value) => value.iteration === snapshot.task?.iteration && value.state === "active")
            ?.executionId ?? `exe_${operationId(action, binding, workspaceId, expectedRevision).slice(-26)}`);
    return normalizeTaskLifecycleCommand(bound, {
      type: lifecycleAction.commandType,
      taskId,
      [lifecycleAction.targetIdField]: executionId,
      ...(Number.isSafeInteger(action.ttlMs) ? { ttlMs: action.ttlMs as number } : {}),
    } as Parameters<typeof normalizeTaskLifecycleCommand>[1]);
  }
  if (action.kind === "task-transition") {
    const status = String(action.status);
    if (!isDomainStatus(status))
      throw cellCodedError(
        "invalid_transition",
        "Use planned, active, blocked, in_review, done, or cancelled as the target status.",
      );
    const reason = typeof action.reason === "string" && action.reason.trim() ? action.reason.trim() : "";
    return normalizeTaskLifecycleCommand(bound, {
      type: "TransitionTask",
      taskId,
      status,
      reason,
      force: action.force === true,
    });
  }
  if (lifecycleAction?.commandType === "SubmitExecution") {
    const amendment = action.amend === true,
      held = heldLeaseForExecutionActor(snapshot, undefined, binding.actor),
      flags = `${amendment ? " --amend" : ""} --json-input '<submission-json>'`,
      executionId =
        explicitExecutionId(action) ??
        uniqueDerivedExecutionId(
          amendment ? currentSubmittedExecutions(snapshot) : held ? [held] : [],
          amendment ? "Current submitted execution" : "Authenticated active-lease execution",
          amendment
            ? `Run ha task show ${taskId}; only a current submitted execution can be amended.`
            : snapshot.lease
              ? `The authenticated holder (${actorHint(snapshot.lease.actor)}) must run ` +
                `ha task submit ${taskId} --json-input '<submission-json>', or ha task release ${taskId}.`
              : `Run ha task start ${taskId}, then retry ha task submit ${taskId} --json-input '<submission-json>'.`,
          (candidate) => `ha task submit ${taskId} --execution-id ${candidate}${flags}`,
        );
    return normalizeTaskLifecycleCommand(bound, {
      type: "SubmitExecution",
      taskId,
      executionId,
      submission: submissionPacket(action, rootDir),
      ...(amendment ? { amend: true as const } : {}),
    });
  }
  if (lifecycleAction?.commandType === "RecordReview") {
    const packet = reviewPacket(rootDir, action),
      selection = reviewExecutionSelection(action, snapshot, taskId);
    return normalizeTaskLifecycleCommand(bound, {
      type: "RecordReview",
      taskId,
      executionId: selection.executionId,
      reviewId: requiredCellText(action.reviewId, "reviewId"),
      verdict: reviewVerdict(packet.value.verdict),
      reason: requiredCellText(packet.value.reason, "reason"),
      evidenceChecked: cellStringList(packet.value.evidenceChecked),
      ...reviewQualificationFields(packet.value),
      commitSha: selection.commitSha,
      iteration: selection.iteration,
      contentDigest: packet.digest,
      submissionDigest: selection.submissionDigest,
    });
  }
  if (action.kind === "task-review-consent") {
    const consentId = requiredCellText(action.consentId, "consentId"),
      selected = reviewConsentSelection(action, snapshot, taskId, consentId),
      executionId = selected.executionId,
      reviewId = selected.reviewId;
    if (action.fromFile !== undefined || action.jsonInput !== undefined) {
      const packet = packetRecord(rootDir, action, consentJsonFields);
      return normalizeTaskLifecycleCommand(bound, {
        type: "RecordReviewConsent",
        taskId,
        executionId,
        reviewId,
        consentId,
        reviewDigest: digest(packet.value.reviewDigest, "reviewDigest"),
        contentDigest: digest(packet.value.contentDigest, "contentDigest"),
      });
    }
    // Derive both digests from the revision-pinned Review; kernel binding validation still runs.
    const executionReviews = snapshot.reviews.filter((value) => value.executionId === executionId),
      recorded = executionReviews.find((value) => value.reviewId === reviewId);
    if (!executionReviews.length)
      throw cellCodedError(
        "invalid_transition",
        [
          "Execution ",
          `${executionId}`,
          " has no recorded Review; run ha task review-execution ",
          `${taskId}`,
          " --execution-id ",
          `${executionId}`,
          " --review-id <id> --from-file <review.json> first.",
        ].join(""),
      );
    if (!recorded)
      throw cellCodedError(
        "invalid_command",
        [
          "Review ",
          `${reviewId}`,
          " is not recorded for execution ",
          `${executionId}`,
          "; choose one of ",
          `${executionReviews.map((value) => value.reviewId).join(", ")}`,
          ".",
        ].join(""),
      );
    return normalizeTaskLifecycleCommand(bound, {
      type: "RecordReviewConsent",
      taskId,
      executionId,
      reviewId,
      consentId,
      reviewDigest: reviewDigest(recorded),
      contentDigest: recorded.contentDigest,
    });
  }
  if (action.kind === "task-code-doc-reconcile") {
    if (!canonicalCodeDocPaths(action.paths, true))
      throw cellCodedError("invalid_command", "Pass explicit canonical completion.codeDocPaths to code-doc reconcile.");
    const witness = submittedExecutionWitness(action, snapshot, taskId, ["kind", "taskId", "paths"], action.paths);
    return normalizeTaskLifecycleCommand(bound, {
      type: "ReconcileCodeDoc",
      taskId,
      ...witness,
      witnessId: `code-doc-${createHash("sha256").update(JSON.stringify(witness)).digest("hex").slice(0, 16)}`,
    });
  }
  if (action.kind === "task-code-doc-repoint") {
    const witness = submittedExecutionWitness(action, snapshot, taskId, CODE_DOC_REPOINT_FIELDS, []);
    return normalizeTaskLifecycleCommand(bound, {
      type: "RepointCodeDoc",
      taskId,
      record: requiredCellText(action.record, "record"),
      repointId: `code-doc-repoint-${createHash("sha256").update(JSON.stringify(action)).digest("hex").slice(0, 16)}`,
      commitSha: witness.commitSha,
      paths: cellStringList(action.paths),
      reason: requiredCellText(action.reason, "reason"),
    });
  }
  if (lifecycleAction?.commandType === "CompleteTask")
    return normalizeTaskLifecycleCommand(bound, {
      type: "CompleteTask",
      taskId,
      executionId: requiredCellText(action.executionId, "executionId"),
      ...(Array.isArray(action.factRetirementAttestations) && action.factRetirementAttestations.length
        ? {
            factRetirementAttestations: action.factRetirementAttestations as unknown as Extract<
              TaskLifecycleCommand,
              { readonly type: "CompleteTask" }
            >["factRetirementAttestations"],
          }
        : {}),
    });
  throw cellCodedError(
    "unsupported_command",
    "No domain contract exists for this write command; run the leaf --help and select a supported repair command.",
  );
}

export function withServerMeta(
  command: Omit<TaskLifecycleCommand, "eventId" | "workspaceRevision" | "occurredAt">,
  existing: ReturnType<ReturnType<typeof makeTaskEventStore>["readTaskEvent"]>,
  revision: number,
  occurredAt: string,
): TaskLifecycleCommand {
  return {
    ...command,
    eventId: existing?.eventId ?? `event-${createHash("sha256").update(command.opId).digest("hex")}`,
    workspaceRevision: existing?.workspaceRevision ?? revision + 1,
    occurredAt: existing?.occurredAt ?? occurredAt,
  } as TaskLifecycleCommand;
}
