import {
  consentActions as supportedConsentActions,
  type ConsentAction
} from "@harness-anything/kernel";
import type {
  TaskCompleteApproval,
  TaskCompleteConsentSource,
  TaskCompleteExternalCheckpointRef,
  TaskCompleteTransitionCommand
} from "./daemon-host-contract.ts";

export class TaskCompleteTransitionCommandDecodeError extends Error {
  constructor(path: string, expected: string) {
    super(`TASK_COMPLETE_TRANSITION_COMMAND_INVALID:${path}:${expected}`);
    this.name = "TaskCompleteTransitionCommandDecodeError";
  }
}

export function decodeTaskCompleteTransitionCommand(
  value: unknown,
  path = "$.action"
): TaskCompleteTransitionCommand {
  const action = taskCompleteRecord(value, path);
  taskCompleteExactKeys(action, [
    "kind", "taskId", "executionId", "ciGate", "reviewerId", "evidenceMode",
    "commitRef", "judgment", "approval", "externalCheckpointRefs",
    "callerIdempotencyKey", "dryRun"
  ], path);
  if (action.kind !== "task-complete") taskCompleteInvalid(`${path}.kind`, "task-complete");
  const executionId = taskCompleteNullableText(action.executionId, `${path}.executionId`);
  const ciGate = nullableCiGate(action.ciGate, `${path}.ciGate`);
  const evidenceMode = completionEvidenceMode(action.evidenceMode, `${path}.evidenceMode`);
  const commitRef = taskCompleteNullableText(action.commitRef, `${path}.commitRef`);
  const judgment = taskCompleteNullableText(action.judgment, `${path}.judgment`);
  const approval = action.approval === null
    ? null
    : decodeApproval(action.approval, `${path}.approval`);
  if (evidenceMode === "commit-anchor") {
    if (commitRef === null) taskCompleteInvalid(`${path}.commitRef`, "non-empty commit ref for commit-anchor evidence");
    if (judgment === null) taskCompleteInvalid(`${path}.judgment`, "non-empty judgment for commit-anchor evidence");
    if (approval !== null) taskCompleteInvalid(`${path}.approval`, "null for commit-anchor evidence");
  } else if (judgment !== null) {
    taskCompleteInvalid(`${path}.judgment`, "null for execution-review evidence");
  }
  if (approval !== null && approval.executionId !== executionId) {
    taskCompleteInvalid(`${path}.approval.executionId`, "the same execution id as $.action.executionId");
  }
  if (typeof action.dryRun !== "boolean") taskCompleteInvalid(`${path}.dryRun`, "boolean");
  return {
    kind: "task-complete",
    taskId: taskCompleteText(action.taskId, `${path}.taskId`),
    executionId,
    ciGate,
    reviewerId: taskCompleteText(action.reviewerId, `${path}.reviewerId`),
    evidenceMode,
    commitRef,
    judgment,
    approval,
    externalCheckpointRefs: checkpointRefs(
      action.externalCheckpointRefs,
      `${path}.externalCheckpointRefs`
    ),
    callerIdempotencyKey: taskCompleteText(
      action.callerIdempotencyKey,
      `${path}.callerIdempotencyKey`
    ),
    dryRun: action.dryRun
  };
}

function decodeApproval(value: unknown, path: string): TaskCompleteApproval {
  const approval = taskCompleteRecord(value, path);
  taskCompleteExactKeys(approval, [
    "executionId", "findings", "evidenceChecked", "rationale",
    "archiveWarningsAcknowledged", "consentSource", "consentActions", "paths", "prRef"
  ], path);
  if (typeof approval.archiveWarningsAcknowledged !== "boolean") {
    taskCompleteInvalid(`${path}.archiveWarningsAcknowledged`, "boolean");
  }
  const consentSource = decodeConsentSource(approval.consentSource, `${path}.consentSource`);
  const consentActions = approval.consentActions === null
    ? null
    : consentActionList(approval.consentActions, `${path}.consentActions`);
  if (consentSource.kind === "recorded-consent" && consentActions !== null) {
    taskCompleteInvalid(`${path}.consentActions`, "null when reusing recorded consent");
  }
  if (consentActions !== null && (!consentActions.includes("approve_execution")
    || !consentActions.includes("complete_task")
    || new Set(consentActions).size !== consentActions.length)) {
    taskCompleteInvalid(`${path}.consentActions`, "unique actions including approve_execution and complete_task");
  }
  return {
    executionId: taskCompleteNullableText(approval.executionId, `${path}.executionId`),
    findings: taskCompleteText(approval.findings, `${path}.findings`),
    evidenceChecked: stringList(approval.evidenceChecked, `${path}.evidenceChecked`),
    rationale: taskCompleteText(approval.rationale, `${path}.rationale`),
    archiveWarningsAcknowledged: approval.archiveWarningsAcknowledged,
    consentSource,
    consentActions,
    paths: stringList(approval.paths, `${path}.paths`),
    prRef: taskCompleteNullableText(approval.prRef, `${path}.prRef`)
  };
}

function decodeConsentSource(value: unknown, path: string): TaskCompleteConsentSource {
  const source = taskCompleteRecord(value, path);
  if (source.kind === "recorded-consent") {
    taskCompleteExactKeys(source, ["kind", "consentId"], path);
    return { kind: "recorded-consent", consentId: taskCompleteText(source.consentId, `${path}.consentId`) };
  }
  if (source.kind === "utterance") {
    taskCompleteExactKeys(source, ["kind", "utterance"], path);
    return { kind: "utterance", utterance: taskCompleteText(source.utterance, `${path}.utterance`) };
  }
  if (source.kind === "standing-policy") {
    taskCompleteExactKeys(source, ["kind", "decisionId"], path);
    return { kind: "standing-policy", decisionId: taskCompleteText(source.decisionId, `${path}.decisionId`) };
  }
  if (source.kind === "asserted-rationale") {
    taskCompleteExactKeys(source, ["kind", "rationale"], path);
    return { kind: "asserted-rationale", rationale: taskCompleteText(source.rationale, `${path}.rationale`) };
  }
  taskCompleteInvalid(`${path}.kind`, "known consent source kind");
}

function checkpointRefs(value: unknown, path: string): ReadonlyArray<TaskCompleteExternalCheckpointRef> {
  if (!Array.isArray(value)) taskCompleteInvalid(path, "array");
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const checkpoint = taskCompleteRecord(entry, entryPath);
    taskCompleteExactKeys(checkpoint, ["kind", "ref"], entryPath);
    if (checkpoint.kind !== "document-publication"
      && checkpoint.kind !== "code-doc-reconciliation") {
      taskCompleteInvalid(`${entryPath}.kind`, "known external checkpoint kind");
    }
    return {
      kind: checkpoint.kind,
      ref: taskCompleteText(checkpoint.ref, `${entryPath}.ref`)
    };
  });
}

function consentActionList(value: unknown, path: string): ReadonlyArray<ConsentAction> {
  const actions = stringList(value, path);
  if (actions.some((action) => !(supportedConsentActions as ReadonlyArray<string>).includes(action))) {
    taskCompleteInvalid(path, `only ${supportedConsentActions.join(", ")}`);
  }
  return actions as ReadonlyArray<ConsentAction>;
}

function stringList(value: unknown, path: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) taskCompleteInvalid(path, "array of non-empty strings");
  return value.map((entry, index) => taskCompleteText(entry, `${path}[${index}]`));
}

function nullableCiGate(
  value: unknown,
  path: string
): TaskCompleteTransitionCommand["ciGate"] {
  if (value === null) return null;
  if (value !== "passed" && value !== "failed" && value !== "not-applicable") {
    taskCompleteInvalid(path, "passed, failed, not-applicable, or null");
  }
  return value;
}

function completionEvidenceMode(
  value: unknown,
  path: string
): TaskCompleteTransitionCommand["evidenceMode"] {
  if (value !== "execution-review" && value !== "commit-anchor") {
    taskCompleteInvalid(path, "execution-review or commit-anchor");
  }
  return value;
}

function taskCompleteNullableText(value: unknown, path: string): string | null {
  return value === null ? null : taskCompleteText(value, path);
}

function taskCompleteText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) taskCompleteInvalid(path, "non-empty string");
  return value;
}

function taskCompleteRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    taskCompleteInvalid(path, "plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) taskCompleteInvalid(path, "plain object");
  return value as Record<string, unknown>;
}

function taskCompleteExactKeys(recordValue: Record<string, unknown>, required: ReadonlyArray<string>, path: string): void {
  const actual = Object.keys(recordValue);
  const unknown = actual.find((key) => !required.includes(key));
  if (unknown) taskCompleteInvalid(`${path}.${unknown}`, "no unknown fields");
  const missing = required.find((key) => !Object.hasOwn(recordValue, key));
  if (missing) taskCompleteInvalid(`${path}.${missing}`, "required field");
}

function taskCompleteInvalid(path: string, expected: string): never {
  throw new TaskCompleteTransitionCommandDecodeError(path, expected);
}
