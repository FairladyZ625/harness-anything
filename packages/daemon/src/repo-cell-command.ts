import { createHash } from "node:crypto";
import {
  currentExecutionCuts,
  currentSubmittedExecutions,
  heldLeaseForExecutionActor,
  isDomainStatus,
  makeTaskEventStore,
  normalizeTaskLifecycleCommand,
  repositoryDeliverablePaths,
  reviewDigest,
  type TaskLifecycleCommand,
} from "../../kernel/src/index.ts";
import { consentJsonFields } from "../../preset/src/index.ts";
import { type DaemonGuiReadResultMap } from "./protocol/daemon-protocol.contract.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import {
  explicitExecutionId,
  reviewConsentSelection,
  uniqueDerivedExecutionId,
} from "./repo-cell-execution-selection.ts";
import { packetFile, reviewPacket, submissionPacket } from "./repo-cell-packets.ts";
import { actorHint, operationId } from "./repo-cell-proof.ts";
import { resolveLifecycleAction } from "./repo-cell-lifecycle-action.ts";
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

function submittedExecutionWitness(action: RepoTaskAction, snapshot: Snapshot, taskId: string, allowed: string[]) {
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
    paths: repositoryDeliverablePaths(execution.submission),
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
    lifecycleAction = resolveLifecycleAction(action);
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
    const suppliedReason = typeof action.reason === "string" && action.reason.trim() ? action.reason.trim() : null,
      reason = suppliedReason ?? (status === "cancelled" ? "" : `Explicit lifecycle transition to ${status}`);
    return normalizeTaskLifecycleCommand(bound, {
      type: "TransitionTask",
      taskId,
      status,
      reason,
      force: action.force === true,
    });
  }
  if (action.kind === "task-submit") {
    const held = heldLeaseForExecutionActor(snapshot, undefined, binding.actor),
      executionId =
        explicitExecutionId(action) ??
        uniqueDerivedExecutionId(
          held ? [held] : [],
          "Authenticated active-lease execution",
          snapshot.lease
            ? [
                "The authenticated holder (",
                `${actorHint(snapshot.lease.actor)}`,
                ") must run ha task submit ",
                `${taskId}`,
                " --json-input '<submission-json>', or ha task release ",
                `${taskId}`,
                ".",
              ].join("")
            : `Run ha task start ${taskId}, then retry ha task submit ${taskId} --json-input '<submission-json>'.`,
          () => `ha task submit ${taskId} --json-input '<submission-json>'`,
        );
    return normalizeTaskLifecycleCommand(bound, {
      type: "SubmitExecution",
      taskId,
      executionId,
      submission: submissionPacket(action, rootDir),
    });
  }
  if (action.kind === "task-review-execution") {
    const packet = reviewPacket(rootDir, action),
      executionId =
        explicitExecutionId(action) ??
        uniqueDerivedExecutionId(
          currentSubmittedExecutions(snapshot),
          "Current submitted execution",
          [
            "Run ha task show ",
            `${taskId}`,
            "; if the task is active, run ha task submit ",
            `${taskId}`,
            " --json-input '<submission-json>'.",
          ].join(""),
          (candidate) =>
            [
              "ha task review-execution ",
              `${taskId}`,
              " --execution-id ",
              `${candidate}`,
              " --review-id <review-id> --from-file <review.json>",
            ].join(""),
        ),
      submitted = snapshot.executions.find(
        (candidate) => candidate.executionId === executionId && candidate.iteration === snapshot.task?.iteration,
      );
    if (!submitted?.submission)
      throw cellCodedError(
        "invalid_transition",
        [
          "Execution Review requires a submitted execution on the current ",
          "iteration; submit ",
          `${executionId}`,
          " before review.",
        ].join(""),
      );
    return normalizeTaskLifecycleCommand(bound, {
      type: "RecordReview",
      taskId,
      executionId,
      reviewId: requiredCellText(action.reviewId, "reviewId"),
      verdict: reviewVerdict(packet.value.verdict),
      reason: requiredCellText(packet.value.reason, "reason"),
      evidenceChecked: cellStringList(packet.value.evidenceChecked),
      commitSha: submitted.submission.commitSha,
      iteration: submitted.iteration,
      contentDigest: packet.digest,
    });
  }
  if (action.kind === "task-review-consent") {
    const consentId = requiredCellText(action.consentId, "consentId"),
      selected = reviewConsentSelection(action, snapshot, taskId, consentId),
      executionId = selected.executionId,
      reviewId = selected.reviewId;
    if (action.fromFile !== undefined) {
      const packet = packetFile(rootDir, action.fromFile, consentJsonFields);
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
    // Without a packet the daemon derives both digests from the explicitly selected recorded Review,
    // read from the same revision-pinned projection snapshot the kernel validates against. The
    // operator cannot compute reviewDigest by hand (actor and capabilityRef never appear in the
    // task package), and the kernel-side binding check still runs on the derived command.
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
    const witness = submittedExecutionWitness(action, snapshot, taskId, ["kind", "taskId"]);
    if (!witness.paths.length)
      throw cellCodedError(
        "invalid_command",
        "The submitted execution names no repository deliverable paths; " +
          "task-package-only submissions do not need a code-doc witness.",
      );
    return normalizeTaskLifecycleCommand(bound, {
      type: "ReconcileCodeDoc",
      taskId,
      ...witness,
      witnessId: `code-doc-${createHash("sha256").update(JSON.stringify(witness)).digest("hex").slice(0, 16)}`,
    });
  }
  if (action.kind === "task-code-doc-repoint") {
    const witness = submittedExecutionWitness(action, snapshot, taskId, CODE_DOC_REPOINT_FIELDS);
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
  if (action.kind === "task-complete")
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
