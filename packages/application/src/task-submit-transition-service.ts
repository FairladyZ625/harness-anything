import {
  readSessionEntityDocument,
  validateOutputEvidence,
  type ExecutionRecord,
  type HarnessLayoutInput
} from "@harness-anything/kernel";
import type { TaskSubmitTransitionCommand } from "./authority/daemon-host-contract.ts";
import type { ExecutionSubmission } from "./execution-saga-service.ts";
import { isRuntimeTranscriptConfirmedUnavailable } from "./runtime-transcript-confirmation.ts";

export interface TaskSubmitTransitionSnapshot {
  readonly rootInput: HarnessLayoutInput;
  readonly taskId: string;
  readonly taskIndexBody: string;
  readonly execution: ExecutionRecord;
  readonly submittedAt: string;
}

export interface TaskSubmitTransitionPlanInput {
  readonly taskId: string;
  readonly executionId: string;
  readonly submission: ExecutionSubmission;
}

export interface TaskSubmitTransitionPlan {
  readonly schema: "task-submit-transition-plan/v1";
  readonly taskId: string;
  readonly executionId: string;
  readonly execution: ExecutionRecord;
  readonly taskIndexBody: string;
}

export class TaskSubmitTransitionService {
  static plan(
    snapshot: TaskSubmitTransitionSnapshot,
    command: TaskSubmitTransitionPlanInput
  ): TaskSubmitTransitionPlan {
    assertTaskSubmitIdentity(snapshot, command);
    if (snapshot.execution.state !== "active") {
      throw new Error(`execution is not active: ${command.executionId}`);
    }
    const sessionBindings = finalizeExecutionSessionBindings(
      snapshot.rootInput,
      snapshot.execution.session_bindings,
      snapshot.submittedAt
    );
    assertPrimarySession(sessionBindings);
    assertBindingsFinal(sessionBindings);
    const outputs = [...snapshot.execution.outputs, ...command.submission.evidence];
    validateOutputEvidence({
      rootInput: snapshot.rootInput,
      taskId: command.taskId,
      executionId: command.executionId,
      evidence: outputs
    });
    return {
      schema: "task-submit-transition-plan/v1",
      taskId: command.taskId,
      executionId: command.executionId,
      execution: {
        ...snapshot.execution,
        state: "submitted",
        submitted_at: snapshot.submittedAt,
        session_bindings: sessionBindings,
        outputs,
        submission: {
          completion_claim: command.submission.completionClaim,
          deliverables: command.submission.deliverables,
          evidence_refs: command.submission.evidence.map((evidence) => evidence.evidence_id),
          verification_notes: command.submission.verificationNotes,
          known_gaps: command.submission.knownGaps,
          residual_risks: command.submission.residualRisks
        }
      },
      taskIndexBody: taskSubmitIndex(snapshot.taskIndexBody, command.taskId)
    };
  }
}

export function taskSubmitPlanInput(
  command: TaskSubmitTransitionCommand
): TaskSubmitTransitionPlanInput {
  if (!command.executionId) {
    throw new Error("TASK_SUBMIT_EXECUTION_REQUIRED");
  }
  return {
    taskId: command.taskId,
    executionId: command.executionId,
    submission: {
      completionClaim: command.submission.completionClaim,
      deliverables: command.submission.deliverables,
      verificationNotes: command.submission.verificationNotes,
      knownGaps: command.submission.knownGaps,
      residualRisks: command.submission.residualRisks,
      evidence: command.submission.outputs.map((text, index) => ({
        evidence_id: `ev_cli_${index + 1}`,
        execution_ref: `execution/${command.taskId}/${command.executionId}`,
        locator: { substrate: "inline" as const, text }
      }))
    }
  };
}

export function finalizeExecutionSessionBindings(
  rootInput: HarnessLayoutInput,
  bindings: ExecutionRecord["session_bindings"],
  endedAt: string
): ExecutionRecord["session_bindings"] {
  return bindings.map((binding) => {
    if (typeof binding.session_ref !== "string" || !binding.session_ref.startsWith("session/")) return binding;
    const sessionId = binding.session_ref.slice("session/".length);
    if (binding.archive_status === "unavailable") {
      return finalizeUnavailableBinding(binding, endedAt);
    }
    try {
      const session = readSessionEntityDocument(rootInput, sessionId);
      return {
        ...binding,
        archive_status: session.manifest.archiveStatus,
        capture_range: binding.capture_range ? { ...binding.capture_range, end_at: endedAt } : null
      };
    } catch (error) {
      if (isMissingSessionSnapshotError(error)
          && binding.session?.source === "runtime"
          && binding.session.sessionId === sessionId
          && isRuntimeTranscriptConfirmedUnavailable(binding.session)) {
        return finalizeUnavailableBinding(binding, endedAt);
      }
      const prefix = binding.role === "primary" ? "primary Session" : "Session";
      throw new Error(`${prefix} ${sessionId} snapshot is not finalized: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function assertTaskSubmitIdentity(
  snapshot: TaskSubmitTransitionSnapshot,
  command: TaskSubmitTransitionPlanInput
): void {
  if (snapshot.taskId !== command.taskId
      || snapshot.execution.execution_id !== command.executionId
      || snapshot.execution.task_ref !== `task/${command.taskId}`) {
    throw new Error(`execution identity does not match its host path: ${command.executionId}`);
  }
}

function taskSubmitIndex(body: string, taskId: string): string {
  const status = body.match(/^  status:\s*(.+)$/mu)?.[1]?.trim();
  if (status !== "active" && status !== "in_review") {
    throw new Error(`task status ${status ?? "unknown"} cannot enter in_review`);
  }
  if (!/^  engine:\s*local$/mu.test(body)) throw new Error(`task is not local: ${taskId}`);
  return body.replace(/^(  status:\s*).+$/mu, "$1in_review");
}

function assertPrimarySession(bindings: ExecutionRecord["session_bindings"]): void {
  const primary = bindings.find((binding) => binding.role === "primary"
    && typeof binding.session_ref === "string");
  if (!primary) {
    throw new Error("primary Session binding is required; attach the current session through ExecutionSagaService.attachSession");
  }
}

function assertBindingsFinal(bindings: ExecutionRecord["session_bindings"]): void {
  for (const binding of bindings) {
    if (binding.archive_status !== "complete"
        && binding.archive_status !== "partial"
        && binding.archive_status !== "unavailable") {
      throw new Error("all execution session bindings require a final archive_status");
    }
  }
}

function finalizeUnavailableBinding(
  binding: ExecutionRecord["session_bindings"][number],
  endedAt: string
): ExecutionRecord["session_bindings"][number] {
  return {
    ...binding,
    archive_status: "unavailable",
    capture_range: binding.capture_range ? { ...binding.capture_range, end_at: endedAt } : null
  };
}

function isMissingSessionSnapshotError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
