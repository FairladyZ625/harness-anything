import {
  DAEMON_AGENDA_SCHEMA,
  DAEMON_DECISION_LIST_SCHEMA,
  DAEMON_RELATION_GRAPH_SCHEMA,
} from "./daemon-protocol-schema-ids.ts";
import {
  exactRecord,
  integer,
  nonEmpty,
  recordWith,
  sessionProvenance,
  sha,
  statusWord,
  stringArray,
  warningArray,
} from "./daemon-protocol-validate-entities.ts";
import { blockingAssessment, queryPageRow } from "./daemon-protocol-validate-task.ts";
import { decisionStateWords, taskStatusWords } from "./daemon-protocol-vocabulary.ts";
import { isJsonObject, type JsonObject } from "./json-rpc-types.ts";

export function agendaTask(value: unknown): boolean {
  return (
    exactRecord(value, [
      "taskId",
      "title",
      "status",
      "pinned",
      "updatedAt",
      "leaseExecutionId",
      "activeExecutionIds",
      "blockingAssessment",
    ]) &&
    [value.taskId, value.title, value.updatedAt].every(nonEmpty) &&
    statusWord(taskStatusWords, value.status) &&
    typeof value.pinned === "boolean" &&
    (value.leaseExecutionId === null || nonEmpty(value.leaseExecutionId)) &&
    stringArray(value.activeExecutionIds) &&
    blockingAssessment(value.blockingAssessment)
  );
}

export function agendaAwaiting(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  return value.kind === "execution"
    ? exactRecord(value, ["kind", "taskId", "title", "pinned", "executionId", "submittedAt", "blockingAssessment"]) &&
        [value.taskId, value.title, value.executionId, value.submittedAt].every(nonEmpty) &&
        typeof value.pinned === "boolean" &&
        blockingAssessment(value.blockingAssessment)
    : value.kind === "decision" &&
        exactRecord(value, ["kind", "decisionId", "title", "riskTier", "urgency", "proposedAt"]) &&
        [value.decisionId, value.title, value.proposedAt].every(nonEmpty) &&
        [value.riskTier, value.urgency].every((item) => ["low", "medium", "high"].includes(String(item)));
}

export function validateDaemonAgenda(value: unknown): readonly string[] {
  if (
    !exactRecord(value, DAEMON_AGENDA_SCHEMA.required) ||
    value.schema !== DAEMON_AGENDA_SCHEMA.id ||
    value.ok !== true ||
    value.command !== "agenda" ||
    (value.status !== "ready" && value.status !== "pending") ||
    !integer(value.watermark) ||
    !integer(value.sourceRevision) ||
    !warningArray(value.warnings) ||
    !nonEmpty(value.summary) ||
    !exactRecord(value.page, ["sourceLimit", "cursor", "nextCursor"]) ||
    !integer(value.page.sourceLimit) ||
    Number(value.page.sourceLimit) < 1 ||
    Number(value.page.sourceLimit) > 500 ||
    (value.page.cursor !== null && !nonEmpty(value.page.cursor)) ||
    (value.page.nextCursor !== null && !nonEmpty(value.page.nextCursor)) ||
    ![value.inFlight, value.waitingOnOthers, value.dispatchable].every(
      (rows) => Array.isArray(rows) && rows.every(agendaTask),
    ) ||
    !Array.isArray(value.awaitingDecision) ||
    !value.awaitingDecision.every(agendaAwaiting)
  )
    return ["daemon agenda is invalid"];
  return [];
}

export function validateDaemonRelationGraph(value: unknown): readonly string[] {
  if (
    !recordWith(value, DAEMON_RELATION_GRAPH_SCHEMA.required) ||
    value.ok !== true ||
    !warningArray(value.warnings) ||
    (value.page !== undefined && !queryPageRow(value.page)) ||
    !Array.isArray(value.edges) ||
    value.edges.some(
      (edge) =>
        !recordWith(edge, [
          "relationId",
          "sourceRef",
          "targetRef",
          "relationType",
          "direction",
          "strength",
          "origin",
          "state",
          "rationale",
          "ownerRef",
          "sourcePath",
          "recordIndex",
        ]) ||
        !integer(edge.recordIndex) ||
        [
          "relationId",
          "sourceRef",
          "targetRef",
          "relationType",
          "direction",
          "strength",
          "origin",
          "state",
          "rationale",
          "ownerRef",
          "sourcePath",
        ].some((field) => !nonEmpty(edge[field])),
    ) ||
    !Array.isArray(value.coverageRows) ||
    value.coverageRows.some(
      (row) =>
        !recordWith(row, ["decisionRef", "claimRef", "status", "fulfillment", "relationPath"]) ||
        !nonEmpty(row.decisionRef) ||
        !nonEmpty(row.claimRef) ||
        (row.status !== "covered" && row.status !== "uncovered") ||
        (row.fulfillment !== null &&
          !["evidenced", "delivered", "standing-policy"].includes(String(row.fulfillment))) ||
        (row.refutingFactRefs !== undefined && !stringArray(row.refutingFactRefs)) ||
        !stringArray(row.relationPath) ||
        (row.basisRevision !== undefined && !integer(row.basisRevision)) ||
        (row.coveringFactRef !== undefined && !nonEmpty(row.coveringFactRef)),
    ) ||
    !Array.isArray(value.factAnchors) ||
    value.factAnchors.some(
      (row) =>
        !recordWith(row, ["factRef", "taskId", "factId", "sourcePath"]) ||
        ["factRef", "taskId", "factId", "sourcePath"].some((field) => !nonEmpty(row[field])),
    ) ||
    !Array.isArray(value.facts) ||
    value.facts.some(
      (row) =>
        !recordWith(row, [
          "schema",
          "ref",
          "taskId",
          "factId",
          "statement",
          "source",
          "observedAt",
          "confidence",
          "memoryClass",
          "memoryTags",
          "provenance",
          "liveness",
        ]) ||
        row.schema !== "task-fact-row/v1" ||
        !["standing", "superseded_fact"].includes(String(row.liveness)) ||
        !["low", "medium", "high"].includes(String(row.confidence)) ||
        !["semantic", "episodic", "procedural"].includes(String(row.memoryClass)) ||
        !stringArray(row.memoryTags) ||
        !Array.isArray(row.provenance) ||
        row.provenance.some(
          (entry) =>
            !recordWith(entry, ["runtime", "sessionId", "boundAt"]) ||
            !nonEmpty(entry.runtime) ||
            !nonEmpty(entry.sessionId) ||
            !nonEmpty(entry.boundAt),
        ) ||
        ["ref", "taskId", "factId", "statement", "source", "observedAt"].some((field) => !nonEmpty(row[field])),
    )
  )
    return ["daemon relation graph is invalid"];
  return [];
}

export function readiness(value: unknown): boolean {
  if (
    !exactRecord(value, ["schema", "basisCommitSha", "appliesToDrift", "conflictMarker"]) ||
    value.schema !== "decision-readiness/v1" ||
    !exactRecord(value.appliesToDrift, ["state", "paths", "lastCommitAt", "summary"]) ||
    !["clear", "drift", "unknown"].includes(String(value.appliesToDrift.state)) ||
    !stringArray(value.appliesToDrift.paths) ||
    (value.appliesToDrift.lastCommitAt !== null && !nonEmpty(value.appliesToDrift.lastCommitAt)) ||
    !nonEmpty(value.appliesToDrift.summary) ||
    !exactRecord(value.conflictMarker, ["state", "paths", "summary"]) ||
    !["clear", "conflict", "unknown"].includes(String(value.conflictMarker.state)) ||
    !stringArray(value.conflictMarker.paths) ||
    !nonEmpty(value.conflictMarker.summary) ||
    !(
      sha(value.basisCommitSha) ||
      (value.basisCommitSha === "" &&
        value.appliesToDrift.state === "unknown" &&
        value.conflictMarker.state === "unknown")
    )
  )
    return false;
  return true;
}

export function validateDaemonDecisionList(value: unknown): readonly string[] {
  const fields = [
      "schema",
      "decisionId",
      "path",
      "state",
      "title",
      "question",
      "riskTier",
      "urgency",
      "vertical",
      "preset",
      "decisionClass",
      "appliesTo",
      "proposer",
      "arbiter",
      "proposedAt",
      "decidedAt",
      "workspaceRevision",
      "chosen",
      "rejected",
      "claims",
      "judgmentConsents",
      "body",
    ],
    allowed = [...fields, "provenance", "legacyId", "readiness", "amendments", "contentPins"],
    history = (row: JsonObject) =>
      (row.amendments !== undefined &&
        (!Array.isArray(row.amendments) ||
          row.amendments.some(
            (entry) =>
              !exactRecord(entry, ["schema", "amendmentId", "fields", "actor", "amendedAt"]) ||
              entry.schema !== "decision-amendment/v1" ||
              !/^dam_[0-9a-f]{26}$/u.test(String(entry.amendmentId)) ||
              !stringArray(entry.fields) ||
              !isJsonObject(entry.actor) ||
              !nonEmpty(entry.amendedAt),
          ))) ||
      (row.contentPins !== undefined &&
        (!Array.isArray(row.contentPins) ||
          row.contentPins.some(
            (entry) =>
              !exactRecord(entry, ["schema", "pinId", "action", "state", "pinnedAt", "evidence", "actor", "digest"]) ||
              entry.schema !== "decision-content-pin/v1" ||
              !/^dcp_[0-9a-f]{26}$/u.test(String(entry.pinId)) ||
              !["accept", "reject", "defer", "supersede", "retire", "amend", "repin"].includes(String(entry.action)) ||
              !statusWord(decisionStateWords, entry.state) ||
              !nonEmpty(entry.pinnedAt) ||
              !nonEmpty(entry.evidence) ||
              !isJsonObject(entry.actor) ||
              !/^sha256:[0-9a-f]{64}$/u.test(String(entry.digest)),
          )));
  if (
    !recordWith(value, DAEMON_DECISION_LIST_SCHEMA.required) ||
    Object.keys(value).some((key) => !DAEMON_DECISION_LIST_SCHEMA.required.includes(key as never)) ||
    value.ok !== true ||
    !warningArray(value.warnings) ||
    !Array.isArray(value.decisions) ||
    value.decisions.some(
      (row) =>
        !recordWith(row, fields) ||
        Object.keys(row).some((key) => !allowed.includes(key)) ||
        history(row) ||
        row.schema !== "decision-row/v1" ||
        !integer(row.workspaceRevision) ||
        [
          "decisionId",
          "path",
          "state",
          "title",
          "question",
          "riskTier",
          "urgency",
          "vertical",
          "preset",
          "decisionClass",
          "proposedAt",
        ].some((field) => !nonEmpty(row[field])) ||
        (row.legacyId !== undefined && !/^E[1-9][0-9]*$/u.test(String(row.legacyId))) ||
        (row.readiness !== undefined && !readiness(row.readiness)) ||
        !Array.isArray(row.chosen) ||
        !Array.isArray(row.rejected) ||
        !Array.isArray(row.claims) ||
        (row.provenance !== undefined &&
          (!Array.isArray(row.provenance) || row.provenance.some((entry) => !sessionProvenance(entry)))) ||
        !Array.isArray(row.judgmentConsents) ||
        !isJsonObject(row.appliesTo) ||
        !isJsonObject(row.proposer) ||
        (row.arbiter !== null && !isJsonObject(row.arbiter)) ||
        (row.body !== null && !isJsonObject(row.body)),
    )
  )
    return ["daemon decision list is invalid"];
  return [];
}
