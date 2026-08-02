import { createHash } from "node:crypto";
import {
  decodeTaskCompleteTransitionCommand,
  type TaskCompleteApproval,
  type TaskCompleteConsentSource,
  type TaskCompleteTransitionCommand
} from "@harness-anything/application";
import { stableStringify } from "@harness-anything/kernel";
import type { CliTaskCompleteAction } from "./types.ts";

export function makeTaskCompleteTransitionCommand(
  command: Omit<TaskCompleteTransitionCommand, "callerIdempotencyKey">,
  providedKey?: string
): TaskCompleteTransitionCommand {
  return decodeTaskCompleteTransitionCommand({
    ...command,
    callerIdempotencyKey: providedKey ?? `task-complete-${createHash("sha256")
      .update(stableStringify(command))
      .digest("hex")}`
  });
}

/** Project the CLI grammar shape into the exact daemon-host command contract. */
export function taskCompleteTransitionCommandFromCliAction(
  value: unknown
): TaskCompleteTransitionCommand {
  const action = cliTaskCompleteRecord(value, "$.action");
  if (isTypedTransitionShape(action)) return decodeTaskCompleteTransitionCommand(action);
  cliTaskCompleteExactKeys(action, [
    "kind", "taskId", "reviewerId", "evidenceMode"
  ], [
    "executionId", "ciGate", "commitRef", "judgment", "approval",
    "externalCheckpointRefs", "dryRun"
  ], "$.action");
  if (action.kind !== "task-complete") cliTaskCompleteInvalid("$.action.kind", "task-complete");
  const cliAction = action as unknown as CliTaskCompleteAction;
  const executionId = cliAction.approval?.executionId ?? cliAction.executionId ?? null;
  return makeTaskCompleteTransitionCommand({
    kind: "task-complete",
    taskId: cliAction.taskId,
    executionId,
    ciGate: cliAction.ciGate ?? null,
    reviewerId: cliAction.reviewerId,
    evidenceMode: cliAction.evidenceMode,
    commitRef: cliAction.commitRef ?? null,
    judgment: cliAction.judgment ?? null,
    approval: cliAction.approval
      ? approvalFromCli(cliAction.approval, executionId)
      : null,
    externalCheckpointRefs: cliAction.externalCheckpointRefs ?? [],
    dryRun: cliAction.dryRun === true
  });
}

function approvalFromCli(
  value: NonNullable<CliTaskCompleteAction["approval"]>,
  executionId: string | null
): TaskCompleteApproval {
  const approval = cliTaskCompleteRecord(value, "$.action.approval");
  cliTaskCompleteExactKeys(approval, [
    "findings", "evidenceChecked", "rationale", "archiveWarningsAcknowledged", "paths"
  ], [
    "executionId", "consentId", "consentUtterance", "consentStandingPolicyDecisionId",
    "consentAssertedRationale", "consentActions", "prRef"
  ], "$.action.approval");
  return {
    executionId,
    findings: value.findings,
    evidenceChecked: value.evidenceChecked,
    rationale: value.rationale,
    archiveWarningsAcknowledged: value.archiveWarningsAcknowledged,
    consentSource: consentSourceFromCli(value),
    consentActions: value.consentActions ?? null,
    paths: value.paths,
    prRef: value.prRef ?? null
  };
}

function consentSourceFromCli(
  approval: NonNullable<CliTaskCompleteAction["approval"]>
): TaskCompleteConsentSource {
  const sources = [
    approval.consentId,
    approval.consentUtterance,
    approval.consentStandingPolicyDecisionId,
    approval.consentAssertedRationale
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (sources.length !== 1) cliTaskCompleteInvalid("$.action.approval", "exactly one consent source");
  if (approval.consentId) return { kind: "recorded-consent", consentId: approval.consentId };
  if (approval.consentUtterance) return { kind: "utterance", utterance: approval.consentUtterance };
  if (approval.consentStandingPolicyDecisionId) {
    return { kind: "standing-policy", decisionId: approval.consentStandingPolicyDecisionId };
  }
  return { kind: "asserted-rationale", rationale: approval.consentAssertedRationale! };
}

function isTypedTransitionShape(action: Record<string, unknown>): boolean {
  return action.approval === null
    || (typeof action.approval === "object" && action.approval !== null
      && Object.hasOwn(action.approval, "consentSource"));
}

function cliTaskCompleteRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) cliTaskCompleteInvalid(path, "plain object");
  return value as Record<string, unknown>;
}

function cliTaskCompleteExactKeys(
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
  path: string
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) cliTaskCompleteInvalid(`${path}.${unknown}`, "no unknown fields");
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) cliTaskCompleteInvalid(`${path}.${missing}`, "required field");
}

function cliTaskCompleteInvalid(path: string, expected: string): never {
  throw new Error(`TASK_COMPLETE_TRANSITION_COMMAND_INVALID:${path}:${expected}`);
}
