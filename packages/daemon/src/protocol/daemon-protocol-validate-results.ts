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
  recordWith,
  statusWord,
  stringArray,
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

export function validateDaemonDocumentRead(value: unknown): readonly string[] {
  if (
    !recordWith(value, DAEMON_DOCUMENT_READ_SCHEMA.required) ||
    value.ok !== true ||
    (value.status !== "ready" && value.status !== "pending") ||
    !nonEmpty(value.taskId) ||
    !nonEmpty(value.path) ||
    typeof value.body !== "string" ||
    (value.blobSha256 !== null &&
      (typeof value.blobSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.blobSha256))) ||
    !integer(value.watermark) ||
    !integer(value.sourceRevision)
  )
    return ["daemon document read is invalid"];
  return [];
}

export function validateDaemonTaskDocumentList(value: unknown): readonly string[] {
  if (
    !recordWith(value, DAEMON_TASK_DOCUMENT_LIST_SCHEMA.required) ||
    value.ok !== true ||
    (value.status !== "ready" && value.status !== "pending") ||
    !nonEmpty(value.taskId) ||
    !Array.isArray(value.documents) ||
    value.documents.some(
      (row) =>
        !exactRecord(row, ["path", "blobSha256", "size", "mediaType"]) ||
        !nonEmpty(row.path) ||
        row.path.startsWith("/") ||
        row.path.split("/").includes("..") ||
        !/^[0-9a-f]{64}$/u.test(String(row.blobSha256)) ||
        !integer(row.size) ||
        !nonEmpty(row.mediaType),
    ) ||
    !integer(value.watermark) ||
    !integer(value.sourceRevision)
  )
    return ["daemon task document list is invalid"];
  return [];
}

export function validateDaemonTaskDispatches(value: unknown): readonly string[] {
  if (
    !isJsonObject(value) ||
    value.ok !== true ||
    !["ready", "pending"].includes(String(value.status)) ||
    !Array.isArray(value.dispatches) ||
    !integer(value.watermark) ||
    !integer(value.sourceRevision)
  )
    return ["daemon task dispatches is invalid"];
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
  if (!single && !batch) return ["daemon task dispatches is invalid"];
  return value.dispatches.some(
    (row) =>
      !isJsonObject(row) ||
      !nonEmpty(row.dispatchId) ||
      !nonEmpty(row.taskId) ||
      !nonEmpty(row.executionId) ||
      !nonEmpty(row.runtimeSessionId) ||
      !nonEmpty(row.instanceId) ||
      (row.agentId !== undefined && !nonEmpty(row.agentId)) ||
      (row.agentName !== undefined && !nonEmpty(row.agentName)) ||
      (row.delegatedByAgentId !== undefined && !nonEmpty(row.delegatedByAgentId)) ||
      (row.delegatedByAgentName !== undefined && !nonEmpty(row.delegatedByAgentName)) ||
      (row.squadId !== undefined && !nonEmpty(row.squadId)) ||
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
  )
    ? ["daemon task dispatch row is invalid"]
    : [];
}

export function validateDaemonProtocolError(value: unknown): readonly string[] {
  if (
    !recordWith(value, DAEMON_PROTOCOL_ERROR_SCHEMA.required) ||
    value.schema !== "command-receipt/v2" ||
    value.ok !== false ||
    value.outcome !== "op_rejected" ||
    value.opId !== "N/A" ||
    value.origin !== "daemon" ||
    !recordWith(value.error, ["code", "hint"]) ||
    [value.command, value.code, value.evidence, value.nextAction, value.error.code, value.error.hint].some(
      (item) => !nonEmpty(item),
    ) ||
    value.code !== value.error.code
  )
    return ["daemon protocol error is invalid"];
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
  ];

export function writeReceipt(value: JsonObject): string[] {
  const outcome = value.outcome,
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
  return !statusWord(receiptOutcomeWords, outcome) ||
    !nonEmpty(value.opId) ||
    (value.revision !== undefined && (!integer(value.revision) || Number(value.revision) < 0)) ||
    ((applied || pending || noChanges) &&
      (!validProof || value.visibility !== "center" || !integer(value.revision) || !nonEmpty(value.evidence))) ||
    (applied && (!proof.durable || !proof.canonicalVisible || proof.committedRevision !== proof.appliedCut)) ||
    (pending && !nonEmpty(value.nextAction)) ||
    (noChanges && (![value.code, value.origin, value.nextAction].every(nonEmpty) || value.code !== "no_changes")) ||
    (failed &&
      (![value.code, value.origin, value.nextAction].every(nonEmpty) ||
        (value.evidence !== undefined && !nonEmpty(value.evidence))))
    ? ["write receipt is invalid"]
    : [];
}

export function validateDaemonGuiCommandReceipt(value: unknown): readonly string[] {
  if (!isJsonObject(value)) return ["GUI command receipt must be an object"];
  const allowed = ["schema", "ok", "command", ...writeReceiptFields, ...guiReceiptExtensions],
    receipt = Object.fromEntries(
      writeReceiptFields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]),
    ) as JsonObject,
    ok = value.outcome === "applied" || value.outcome === "pending" || value.outcome === "no_changes",
    errors =
      Object.keys(value).some((field) => !allowed.includes(field)) ||
      value.schema !== "command-receipt/v2" ||
      typeof value.ok !== "boolean" ||
      value.ok !== ok ||
      !nonEmpty(value.command) ||
      !daemonGuiActionMethods.some(({ actionKind }) => actionKind === value.command)
        ? ["GUI command receipt envelope is invalid"]
        : writeReceipt(receipt);
  if (
    (value.ok === false &&
      (!exactRecord(value.error, ["code", "hint"]) ||
        !nonEmpty(value.error.code) ||
        !nonEmpty(value.error.hint) ||
        value.error.code !== value.code)) ||
    (value.ok === true && value.error !== undefined)
  )
    errors.push("GUI command receipt error is invalid");
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
    errors.push("decision receipt fidelity is invalid");
  return errors;
}

export type ResultValidator = (value: unknown) => readonly string[];

export function serializeSchema(value: unknown, validate: ResultValidator): string {
  const errors = validate(value);
  if (errors.length) throw new DaemonProtocolContractError("invalid_result", errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}

export const serializeDaemonTaskSnapshotList = (value: unknown): string =>
    serializeSchema(value, validateDaemonTaskSnapshotList),
  serializeObserveTailResult = (value: unknown): string => serializeSchema(value, validateObserveTailResult),
  serializeDaemonWorkspaceSummary = (value: unknown): string => serializeSchema(value, validateDaemonWorkspaceSummary),
  serializeDaemonAgenda = (value: unknown): string => serializeSchema(value, validateDaemonAgenda),
  serializeDaemonRelationGraph = (value: unknown): string => serializeSchema(value, validateDaemonRelationGraph),
  serializeDaemonDecisionList = (value: unknown): string => serializeSchema(value, validateDaemonDecisionList),
  serializeDaemonDocumentRead = (value: unknown): string => serializeSchema(value, validateDaemonDocumentRead),
  serializeDaemonTaskDocumentList = (value: unknown): string => serializeSchema(value, validateDaemonTaskDocumentList),
  serializeDaemonTaskDispatches = (value: unknown): string => serializeSchema(value, validateDaemonTaskDispatches),
  serializeDaemonProtocolError = (value: unknown): string => serializeSchema(value, validateDaemonProtocolError);

export function daemonProtocolError(command: string, code: string, hint: string): DaemonProtocolErrorResult {
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
  };
}
