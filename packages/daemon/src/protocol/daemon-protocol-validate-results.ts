import { isReceiptDiagnostic, isReceiptGuidance } from "../../../kernel/src/index.ts";
import { daemonGuiActionMethods } from "./daemon-protocol-gui-actions.ts";
import { validateObserveTailResult, type DaemonProtocolErrorResult } from "./daemon-protocol-gui-types.ts";
import { DaemonProtocolContractError } from "./json-rpc-types.ts";
import {
  DAEMON_DOCUMENT_READ_SCHEMA,
  DAEMON_PROTOCOL_ERROR_SCHEMA,
  DAEMON_TASK_DOCUMENT_LIST_SCHEMA,
} from "./daemon-protocol-schema-ids.ts";
import {
  exactRecord,
  integer,
  nonEmpty,
  statusWord,
  stringArray,
  validationEntityId,
  validationError,
  recordShapeError,
} from "./daemon-protocol-validate-entities.ts";
import {
  validateDaemonAgenda,
  validateDaemonDecisionList,
  validateDaemonRelationGraph,
} from "./daemon-protocol-validate-projections.ts";
import {
  queryPageRow,
  validateDaemonTaskSnapshotList,
  validateDaemonWorkspaceSummary,
} from "./daemon-protocol-validate-task.ts";
import { receiptOutcomeWords } from "./daemon-protocol-vocabulary.ts";
import { isJsonObject, type JsonObject } from "./json-rpc-types.ts";

export type ValidScheduleListRow = {
  readonly scheduleId: string;
  readonly state: "armed" | "paused";
  readonly mode: "detect" | "remediate";
  readonly spec: {
    readonly trigger:
      | { readonly kind: "interval"; readonly everyMs: number; readonly anchorAt: string }
      | { readonly kind: "cron"; readonly expression: string; readonly timezone: string };
    readonly target:
      | { readonly kind: "agent"; readonly agentId: string; readonly runtimeInstanceId: string }
      | { readonly kind: "squad"; readonly squadId: string };
  };
  readonly status: {
    readonly automaticEvaluatedThrough: string;
    readonly activeRun: unknown;
  };
  readonly updatedAt: string;
  readonly definitionRevision: number;
  readonly nextRunAt: string | null;
};

export type InvalidScheduleListRow = {
  readonly scheduleId: string;
  readonly state: "invalid";
  readonly invalidReason: string;
  readonly definitionRevision: number;
};

export type ScheduleListRow = ValidScheduleListRow | InvalidScheduleListRow;

export function parseScheduleListReceipt(
  receipt: Readonly<Record<string, unknown>>,
): readonly ScheduleListRow[] | null {
  if (
    receipt.schema !== "command-receipt/v2" ||
    receipt.ok !== true ||
    receipt.command !== "schedule-list" ||
    receipt.outcome !== "applied" ||
    typeof receipt.evidence !== "string"
  )
    return null;
  const payload: unknown = JSON.parse(receipt.evidence);
  if (
    !exactRecord(payload, ["schema", "schedules"]) ||
    payload.schema !== "schedule-list/v1" ||
    !Array.isArray(payload.schedules) ||
    !payload.schedules.every(scheduleListRow)
  )
    return null;
  return payload.schedules;
}

export function makeDaemonCommandReceipt(command: string, receipt: object): JsonObject {
  const {
      schema: _schema,
      ok: _ok,
      command: _command,
      error: _error,
      // A write path that leaves a field unset owns it as `undefined`; the wire drops
      // exactly those keys, so the envelope handed to the result validators must too —
      // otherwise a receipt that serializes fine is rejected before it ever reaches JSON.
      ...declared
    } = receipt as Readonly<Record<string, unknown>>,
    fields = Object.fromEntries(Object.entries(declared).filter(([, value]) => value !== undefined)),
    ok = fields.outcome === "applied" || fields.outcome === "pending" || fields.outcome === "no_changes";
  return {
    schema: "command-receipt/v2",
    ok,
    command,
    ...fields,
    ...(!ok
      ? {
          error: {
            code: typeof fields.code === "string" ? fields.code : "write_rejected",
            hint: typeof fields.nextAction === "string" ? fields.nextAction : "Inspect the rejection.",
          },
        }
      : {}),
  } as JsonObject;
}

export function daemonCommandReceiptRejectionCode(receipt: Readonly<Record<string, unknown>>): string | null {
  return receipt.schema === "command-receipt/v2" &&
    receipt.ok === false &&
    receipt.outcome === "op_rejected" &&
    nonEmpty(receipt.code)
    ? receipt.code
    : null;
}

function scheduleListRow(value: unknown): value is ScheduleListRow {
  if (
    exactRecord(value, ["scheduleId", "state", "invalidReason", "definitionRevision"]) &&
    nonEmpty(value.scheduleId) &&
    value.state === "invalid" &&
    nonEmpty(value.invalidReason) &&
    integer(value.definitionRevision) &&
    Number(value.definitionRevision) >= 0
  )
    return true;
  if (!isJsonObject(value) || !isJsonObject(value.spec) || !isJsonObject(value.status)) return false;
  const trigger = value.spec.trigger,
    target = value.spec.target;
  return (
    isJsonObject(trigger) &&
    isJsonObject(target) &&
    nonEmpty(value.scheduleId) &&
    (value.state === "armed" || value.state === "paused") &&
    (value.mode === "detect" || value.mode === "remediate") &&
    ((trigger.kind === "interval" &&
      integer(trigger.everyMs) &&
      Number(trigger.everyMs) >= 60_000 &&
      nonEmpty(trigger.anchorAt)) ||
      (trigger.kind === "cron" && nonEmpty(trigger.expression) && nonEmpty(trigger.timezone))) &&
    ((target.kind === "agent" && nonEmpty(target.agentId) && nonEmpty(target.runtimeInstanceId)) ||
      (target.kind === "squad" && nonEmpty(target.squadId))) &&
    nonEmpty(value.status.automaticEvaluatedThrough) &&
    nonEmpty(value.updatedAt) &&
    integer(value.definitionRevision) &&
    Number(value.definitionRevision) >= 0 &&
    (value.nextRunAt === null || nonEmpty(value.nextRunAt))
  );
}

export function validateDaemonDocumentRead(value: unknown): readonly string[] {
  const entityId = validationEntityId(value, ["taskId"], "task:<unknown>"),
    shapeError = recordShapeError(
      entityId,
      value,
      DAEMON_DOCUMENT_READ_SCHEMA.required,
      isJsonObject(value) ? Object.keys(value) : DAEMON_DOCUMENT_READ_SCHEMA.required,
    );
  if (shapeError) return [shapeError];
  if (!isJsonObject(value)) return [];
  for (const [field, actual, valid, expectation] of [
    ["ok", value.ok, value.ok === true, "must be true"],
    ["status", value.status, value.status === "ready" || value.status === "pending", "must be ready or pending"],
    ["taskId", value.taskId, nonEmpty(value.taskId), "must be a non-empty string"],
    ["path", value.path, nonEmpty(value.path), "must be a non-empty string"],
    ["body", value.body, typeof value.body === "string", "must be a string"],
    [
      "blobSha256",
      value.blobSha256,
      value.blobSha256 === null || (typeof value.blobSha256 === "string" && /^[0-9a-f]{64}$/u.test(value.blobSha256)),
      "must be null or a 64-character SHA-256",
    ],
    [
      "worktreeBody",
      value.worktreeBody,
      value.worktreeBody === null || typeof value.worktreeBody === "string",
      "must be null or a string",
    ],
    ["uncommitted", value.uncommitted, typeof value.uncommitted === "boolean", "must be a boolean"],
    ["watermark", value.watermark, integer(value.watermark), "must be an integer"],
    ["sourceRevision", value.sourceRevision, integer(value.sourceRevision), "must be an integer"],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  return [];
}

export function validateDaemonTaskDocumentList(value: unknown): readonly string[] {
  const entityId = validationEntityId(value, ["taskId"], "task:<unknown>"),
    shapeError = recordShapeError(
      entityId,
      value,
      DAEMON_TASK_DOCUMENT_LIST_SCHEMA.required,
      isJsonObject(value) ? Object.keys(value) : DAEMON_TASK_DOCUMENT_LIST_SCHEMA.required,
    );
  if (shapeError) return [shapeError];
  if (!isJsonObject(value)) return [];
  for (const [field, actual, valid, expectation] of [
    ["ok", value.ok, value.ok === true, "must be true"],
    ["status", value.status, value.status === "ready" || value.status === "pending", "must be ready or pending"],
    ["taskId", value.taskId, nonEmpty(value.taskId), "must be a non-empty string"],
    ["documents", value.documents, Array.isArray(value.documents), "must be an array"],
    ["watermark", value.watermark, integer(value.watermark), "must be an integer"],
    ["sourceRevision", value.sourceRevision, integer(value.sourceRevision), "must be an integer"],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  if (!Array.isArray(value.documents)) return [];
  const invalidIndex = value.documents.findIndex(
    (row) =>
      !exactRecord(row, ["path", "blobSha256", "size", "mediaType", "uncommitted"]) ||
      !nonEmpty(row.path) ||
      row.path.startsWith("/") ||
      row.path.split("/").includes("..") ||
      !/^[0-9a-f]{64}$/u.test(String(row.blobSha256)) ||
      !integer(row.size) ||
      !nonEmpty(row.mediaType) ||
      typeof row.uncommitted !== "boolean",
  );
  if (invalidIndex >= 0)
    return [
      validationError(
        entityId,
        `documents[${invalidIndex}]`,
        value.documents[invalidIndex],
        "must be a valid document row",
      ),
    ];
  return [];
}

export function validateDaemonTaskDispatches(value: unknown): readonly string[] {
  const entityId = validationEntityId(value, ["taskId"], "task-dispatches");
  if (!isJsonObject(value)) return [validationError(entityId, "$", value, "must be an object")];
  for (const [field, actual, valid, expectation] of [
    ["ok", value.ok, value.ok === true, "must be true"],
    ["status", value.status, value.status === "ready" || value.status === "pending", "must be ready or pending"],
    ["dispatches", value.dispatches, Array.isArray(value.dispatches), "must be an array"],
    ["watermark", value.watermark, integer(value.watermark), "must be an integer"],
    ["sourceRevision", value.sourceRevision, integer(value.sourceRevision), "must be an integer"],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  const taskIds = Array.isArray(value.taskIds) ? value.taskIds : [],
    unavailableTaskIds = Array.isArray(value.unavailableTaskIds) ? value.unavailableTaskIds : [],
    single =
      nonEmpty(value.taskId) &&
      exactRecord(value, ["ok", "status", "taskId", "dispatches", "watermark", "sourceRevision"]),
    batch =
      stringArray(taskIds) &&
      taskIds.length > 0 &&
      taskIds.length <= 500 &&
      new Set(taskIds).size === taskIds.length &&
      stringArray(unavailableTaskIds) &&
      unavailableTaskIds.every((taskId) => taskIds.includes(taskId)) &&
      queryPageRow(value.page) &&
      exactRecord(value, [
        "ok",
        "status",
        "taskIds",
        "unavailableTaskIds",
        "dispatches",
        "page",
        "watermark",
        "sourceRevision",
      ]);
  if (!single && !batch)
    return [
      validationError(
        validationEntityId(value, ["taskId"], validationEntityId({ taskId: taskIds[0] }, ["taskId"], entityId)),
        "taskId|taskIds",
        { taskId: value.taskId, taskIds: value.taskIds },
        "must select one valid single or batch task scope",
      ),
    ];
  if (!Array.isArray(value.dispatches)) return [];
  const invalidIndex = value.dispatches.findIndex(
    (row) =>
      !isJsonObject(row) ||
      !nonEmpty(row.dispatchId) ||
      !nonEmpty(row.taskId) ||
      !nonEmpty(row.executionId) ||
      !nonEmpty(row.runtimeSessionId) ||
      !nonEmpty(row.instanceId) ||
      !nonEmpty(row.attemptGroupId) ||
      !integer(row.attemptIndex) ||
      Number(row.attemptIndex) < 0 ||
      !isJsonObject(row.provider) ||
      !nonEmpty(row.provider.instance) ||
      (row.provider.model !== null && !nonEmpty(row.provider.model)) ||
      (row.classification !== null &&
        !["provider_fault", "worker_stop", "gate_red"].includes(String(row.classification))) ||
      (row.reason !== null && !nonEmpty(row.reason)) ||
      (row.fallbackState !== null && !["scheduled", "dispatched", "exhausted"].includes(String(row.fallbackState))) ||
      (row.nextDispatchId !== null && !nonEmpty(row.nextDispatchId)) ||
      (row.agentId !== undefined && !nonEmpty(row.agentId)) ||
      (row.agentName !== undefined && !nonEmpty(row.agentName)) ||
      (row.delegatedByAgentId !== undefined && !nonEmpty(row.delegatedByAgentId)) ||
      (row.delegatedByAgentName !== undefined && !nonEmpty(row.delegatedByAgentName)) ||
      (row.squadId !== undefined && !nonEmpty(row.squadId)) ||
      (row.parentRuntimeSessionId !== undefined && !nonEmpty(row.parentRuntimeSessionId)) ||
      (row.providerSessionId !== null && !nonEmpty(row.providerSessionId)) ||
      (row.eventStreamRef !== null && !nonEmpty(row.eventStreamRef)) ||
      !nonEmpty(row.startedAt) ||
      (row.endedAt !== null && !nonEmpty(row.endedAt)) ||
      ![null, "succeeded", "failed", "unknown", "cancelled"].includes(row.outcome as never) ||
      !["running", "succeeded", "failed", "unknown", "cancelled", "lost"].includes(String(row.status)) ||
      (row.resultRef !== undefined && row.resultRef !== null && !nonEmpty(row.resultRef)) ||
      (row.exitCode !== undefined && row.exitCode !== null && (!integer(row.exitCode) || Number(row.exitCode) < 0)) ||
      (row.dispatchPath !== undefined && row.dispatchPath !== null && !nonEmpty(row.dispatchPath)) ||
      (row.reportPath !== undefined && row.reportPath !== null && !nonEmpty(row.reportPath)),
  );
  return invalidIndex >= 0
    ? [
        validationError(
          validationEntityId(value.dispatches[invalidIndex], ["dispatchId", "taskId", "runtimeSessionId"], entityId),
          `dispatches[${invalidIndex}]`,
          value.dispatches[invalidIndex],
          "must be a valid dispatch row",
        ),
      ]
    : [];
}

export function validateDaemonProtocolError(value: unknown): readonly string[] {
  const entityId = validationEntityId(value, ["command", "opId"], "protocol-error"),
    shapeError = recordShapeError(entityId, value, DAEMON_PROTOCOL_ERROR_SCHEMA.required, [
      ...DAEMON_PROTOCOL_ERROR_SCHEMA.required,
      "diagnostic",
    ]);
  if (shapeError) return [shapeError];
  if (!isJsonObject(value)) return [];
  for (const [field, actual, valid, expectation] of [
    ["schema", value.schema, value.schema === "command-receipt/v2", "must match command-receipt/v2"],
    ["ok", value.ok, value.ok === false, "must be false"],
    ["outcome", value.outcome, value.outcome === "op_rejected", "must be op_rejected"],
    ["opId", value.opId, value.opId === "N/A", "must be N/A"],
    ["origin", value.origin, value.origin === "daemon", "must be daemon"],
    ["command", value.command, nonEmpty(value.command), "must be a non-empty string"],
    ["code", value.code, nonEmpty(value.code), "must be a non-empty string"],
    ["evidence", value.evidence, nonEmpty(value.evidence), "must be a non-empty string"],
    ["nextAction", value.nextAction, nonEmpty(value.nextAction), "must be a non-empty string"],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  const errorShapeError = recordShapeError(entityId, value.error, ["code", "hint"], undefined, "error");
  if (errorShapeError) return [errorShapeError];
  if (!isJsonObject(value.error)) return [];
  if (!nonEmpty(value.error.code))
    return [validationError(entityId, "error.code", value.error.code, "must be a non-empty string")];
  if (!nonEmpty(value.error.hint))
    return [validationError(entityId, "error.hint", value.error.hint, "must be a non-empty string")];
  if (value.code !== value.error.code)
    return [validationError(entityId, "error.code", value.error.code, "must equal code")];
  if (value.diagnostic !== undefined && !isReceiptDiagnostic(value.diagnostic))
    return [validationError(entityId, "diagnostic", value.diagnostic, "must be a structured receipt diagnostic")];
  return [];
}

export const writeReceiptFields = [
    "outcome",
    "opId",
    "revision",
    "code",
    "origin",
    "nextAction",
    "evidence",
    "visibility",
    "proof",
    "detail",
    "commitSha",
    "authorizationDecision",
    "unmetCriteria",
    "effects",
    "updatedProjection",
    "rejectionExplanation",
    "nextActions",
    "guidance",
    "diagnostic",
    "cut",
  ],
  guiReceiptExtensions = [
    "error",
    "summary",
    "taskId",
    "status",
    "packagePath",
    "generatedPaths",
    "presetDigest",
    "scaffoldDigest",
    "completionGates",
    "dryRun",
    "executionId",
    "progressPath",
    "eventId",
    "reviewId",
    "reviewDigest",
    "contentDigest",
    "transition",
    "gateChecks",
    "next",
    "changedPaths",
    "steps",
    "stoppedAt",
    "path",
    "documentSha256",
    "worktreeVisible",
    "consentId",
    "factId",
    "settlement",
    "receiptId",
    "runtimeSessionId",
    "dispatchId",
    "scheduleId",
    "schedule",
    "claimFence",
    // Task surface writes (release/amend/archive/supersede/delete/reopen/relate) already
    // return these on the CLI channel; repo.task.pin/unpin are named ingress onto the same
    // write, so the GUI envelope accepts exactly what that write path produces.
    "mode",
    "report",
  ];

export function writeReceipt(value: JsonObject): string[] {
  const outcome = value.outcome,
    entityId = validationEntityId(value, ["opId", "taskId", "decisionId", "command"], "receipt:<unknown>"),
    proof = isJsonObject(value.proof) ? value.proof : {},
    applied = outcome === "applied",
    pending = outcome === "pending",
    noChanges = outcome === "no_changes",
    failed = outcome === "op_rejected" || outcome === "indeterminate",
    validProof =
      exactRecord(proof, ["committedRevision", "appliedCut", "durable", "canonicalVisible", "worktreeVisible"]) &&
      integer(proof.committedRevision) &&
      integer(proof.appliedCut) &&
      typeof proof.durable === "boolean" &&
      typeof proof.canonicalVisible === "boolean" &&
      (proof.worktreeVisible === null || typeof proof.worktreeVisible === "boolean");
  if (!statusWord(receiptOutcomeWords, outcome))
    return [validationError(entityId, "outcome", outcome, "must be a declared receipt outcome")];
  if (!nonEmpty(value.opId)) return [validationError(entityId, "opId", value.opId, "must be a non-empty string")];
  if (value.revision !== undefined && (!integer(value.revision) || Number(value.revision) < 0))
    return [validationError(entityId, "revision", value.revision, "must be a non-negative integer")];
  if ((applied || pending || noChanges) && !validProof)
    return [validationError(entityId, "proof", value.proof, "must be a valid committed proof")];
  if ((applied || pending || noChanges) && value.visibility !== "center")
    return [validationError(entityId, "visibility", value.visibility, "must be center")];
  if ((applied || pending || noChanges) && !integer(value.revision))
    return [validationError(entityId, "revision", value.revision, "must be an integer")];
  if ((applied || pending || noChanges) && !nonEmpty(value.evidence))
    return [validationError(entityId, "evidence", value.evidence, "must be a non-empty string")];
  if (applied && (!proof.durable || !proof.canonicalVisible || proof.committedRevision !== proof.appliedCut))
    return [validationError(entityId, "proof", value.proof, "must prove durable canonical visibility at one cut")];
  if (pending && !nonEmpty(value.nextAction) && (!Array.isArray(value.guidance) || value.guidance.length === 0))
    return [validationError(entityId, "guidance", value.guidance, "must include nextAction or structured guidance")];
  if (value.guidance !== undefined && (!Array.isArray(value.guidance) || !value.guidance.every(isReceiptGuidance)))
    return [validationError(entityId, "guidance", value.guidance, "must be structured receipt guidance")];
  if (value.diagnostic !== undefined && !isReceiptDiagnostic(value.diagnostic))
    return [validationError(entityId, "diagnostic", value.diagnostic, "must be a structured receipt diagnostic")];
  if (noChanges) {
    for (const field of ["code", "origin", "nextAction"] as const)
      if (!nonEmpty(value[field]))
        return [validationError(entityId, field, value[field], "must be a non-empty string")];
    if (value.code !== "no_changes") return [validationError(entityId, "code", value.code, "must be no_changes")];
  }
  if (failed) {
    for (const field of ["code", "origin", "nextAction"] as const)
      if (!nonEmpty(value[field]))
        return [validationError(entityId, field, value[field], "must be a non-empty string")];
    if (value.evidence !== undefined && !nonEmpty(value.evidence))
      return [validationError(entityId, "evidence", value.evidence, "must be absent or non-empty")];
  }
  return [];
}

export function validateDaemonGuiCommandReceipt(value: unknown): readonly string[] {
  const entityId = validationEntityId(
    value,
    ["opId", "taskId", "decisionId", "runtimeSessionId", "command"],
    "receipt:<unknown>",
  );
  if (!isJsonObject(value)) return [validationError(entityId, "$", value, "must be an object")];
  const allowed = ["schema", "ok", "command", ...writeReceiptFields, ...guiReceiptExtensions],
    receipt = Object.fromEntries(
      writeReceiptFields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]),
    ) as JsonObject,
    ok = value.outcome === "applied" || value.outcome === "pending" || value.outcome === "no_changes",
    unknown = Object.keys(value).find((field) => !allowed.includes(field)),
    errors: string[] = [];
  if (unknown) errors.push(validationError(entityId, unknown, value[unknown], "field is not declared"));
  else if (value.schema !== "command-receipt/v2")
    errors.push(validationError(entityId, "schema", value.schema, "must match command-receipt/v2"));
  else if (typeof value.ok !== "boolean") errors.push(validationError(entityId, "ok", value.ok, "must be a boolean"));
  else if (value.ok !== ok) errors.push(validationError(entityId, "ok", value.ok, `must be ${ok}`));
  else if (!nonEmpty(value.command))
    errors.push(validationError(entityId, "command", value.command, "must be a non-empty string"));
  else if (!daemonGuiActionMethods.some(({ actionKind }) => actionKind === value.command))
    errors.push(validationError(entityId, "command", value.command, "must name a declared GUI action"));
  else errors.push(...writeReceipt(receipt));
  if (
    (value.ok === false &&
      (!exactRecord(value.error, ["code", "hint"]) ||
        !nonEmpty(value.error.code) ||
        !nonEmpty(value.error.hint) ||
        value.error.code !== value.code)) ||
    (value.ok === true && value.error !== undefined)
  )
    errors.push(validationError(entityId, "error", value.error, "must match the rejected receipt code"));
  const decisionFields = ["path", "commitSha", "documentSha256", "worktreeVisible", "consentId"],
    decision =
      (["decision-propose", "decision-accept", "decision-reject", "decision-defer"].includes(String(value.command)) &&
        value.outcome === "applied") ||
      Object.hasOwn(value, "documentSha256") ||
      Object.hasOwn(value, "consentId");
  if (
    decision &&
    (!decisionFields.every((field) => Object.hasOwn(value, field)) ||
      !nonEmpty(value.path) ||
      (value.commitSha !== null && !/^[0-9a-f]{40}$/u.test(String(value.commitSha))) ||
      (!/^sha256:[0-9a-f]{64}$/u.test(String(value.documentSha256)) &&
        !/^[0-9a-f]{64}$/u.test(String(value.documentSha256))) ||
      value.worktreeVisible !== true ||
      (value.consentId !== null && !nonEmpty(value.consentId)))
  )
    errors.push(validationError(entityId, "decisionReceipt", value, "must carry complete decision fidelity fields"));
  return errors;
}

export function serializeSchema(value: unknown, validate: (value: unknown) => readonly string[]): string {
  const errors = validate(value);
  if (errors.length) throw new DaemonProtocolContractError("invalid_result", errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}

export const serializeDaemonTaskSnapshotList = (value: unknown): string =>
    serializeSchema(value, validateDaemonTaskSnapshotList),
  serializeDaemonGuiCommandReceipt = (value: unknown): string =>
    serializeSchema(value, validateDaemonGuiCommandReceipt),
  serializeObserveTailResult = (value: unknown): string => serializeSchema(value, validateObserveTailResult),
  serializeDaemonWorkspaceSummary = (value: unknown): string => serializeSchema(value, validateDaemonWorkspaceSummary),
  serializeDaemonAgenda = (value: unknown): string => serializeSchema(value, validateDaemonAgenda),
  serializeDaemonRelationGraph = (value: unknown): string => serializeSchema(value, validateDaemonRelationGraph),
  serializeDaemonDecisionList = (value: unknown): string => serializeSchema(value, validateDaemonDecisionList),
  serializeDaemonDocumentRead = (value: unknown): string => serializeSchema(value, validateDaemonDocumentRead),
  serializeDaemonTaskDocumentList = (value: unknown): string => serializeSchema(value, validateDaemonTaskDocumentList),
  serializeDaemonTaskDispatches = (value: unknown): string => serializeSchema(value, validateDaemonTaskDispatches),
  serializeDaemonProtocolError = (value: unknown): string => serializeSchema(value, validateDaemonProtocolError);

export function daemonProtocolError(
  command: string,
  code: string,
  hint: string,
  explicitDiagnostic?: DaemonProtocolErrorResult["diagnostic"],
): DaemonProtocolErrorResult {
  const diagnostic = explicitDiagnostic ?? validationDiagnostic(hint);
  return {
    schema: "command-receipt/v2",
    ok: false,
    command,
    outcome: "op_rejected",
    opId: "N/A",
    origin: "daemon",
    code,
    evidence: `rejection:${code}`,
    error: { code, hint },
    nextAction: hint,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function validationDiagnostic(hint: string) {
  const match = hint.match(/^entity=(.+?) field=(\S+) (.+); actual=(.*)$/u);
  return match
    ? {
        kind: "validation" as const,
        entity: match[1]!,
        field: match[2]!,
        expectation: match[3]!,
        actual: match[4]!,
      }
    : null;
}
