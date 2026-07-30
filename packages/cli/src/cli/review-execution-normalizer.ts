import { Effect, Schema } from "effect";
import {
  executionDeclaration,
  generateTaskId,
  type ArtifactStore,
  type ExecutionRecord
} from "@harness-anything/kernel";
import type { ParsedCommand } from "./types.ts";

export async function normalizeReviewExecutionSelection(
  command: ParsedCommand,
  artifactStore?: Pick<ArtifactStore, "readTaskPackage">
): Promise<ParsedCommand> {
  const action = command.action;
  if (action.kind !== "task-review-execution" || action.executionId || action.executionSelectionError || !artifactStore) return command;
  try {
    const task = await Effect.runPromise(artifactStore.readTaskPackage(action.taskId));
    const executions = task.documents
      .filter((document) => /^executions\/[^/]+\.md$/u.test(document.path))
      .map((document) => Schema.decodeUnknownSync(executionDeclaration.schema)(
        executionDeclaration.documentCodec.decode(document.body)
      ) as ExecutionRecord);
    const submitted = executions.filter((execution) => execution.state === "submitted");
    const acceptedReplay = action.verdict === "approved" && submitted.length === 0
      ? executions.filter((execution) => execution.state === "accepted")
      : [];
    const candidates = submitted.length > 0 ? submitted : acceptedReplay;
    if (candidates.length === 1) {
      return { ...command, action: { ...action, executionId: candidates[0]!.execution_id } };
    }
    const ids = candidates.map((execution) => execution.execution_id).join(", ") || "none";
    return {
      ...command,
      action: {
        ...action,
        executionSelectionError: `task review-execution requires exactly one submitted Execution${action.verdict === "approved" ? " or one accepted replay candidate" : ""} when executionId is omitted; found ${candidates.length}: ${ids}. Run \`ha execution list --task ${action.taskId}\`, then set executionId in the review packet.`
      }
    };
  } catch (error) {
    return {
      ...command,
      action: {
        ...action,
        executionSelectionError: `Could not resolve the submitted Execution for Task ${action.taskId}: ${error instanceof Error ? error.message : String(error)}. Run \`ha execution list --task ${action.taskId}\`, then set executionId in the review packet.`
      }
    };
  }
}

export function normalizeReviewConsentIdentity(command: ParsedCommand): ParsedCommand {
  const action = command.action;
  if (action.kind !== "task-review-execution"
      || action.verdict !== "approved"
      || (!action.consentUtterance && !action.consentStandingPolicyDecisionId && !action.consentAssertedRationale)
      || action.consentId
      || action.generatedConsentId) return command;
  return {
    ...command,
    action: {
      ...action,
      generatedConsentId: `cns_${generateTaskId().slice("task_".length)}`
    }
  };
}
