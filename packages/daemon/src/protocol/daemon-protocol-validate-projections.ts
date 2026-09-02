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
  validationEntityId,
  validationError,
  warningArray,
  recordShapeError,
} from "./daemon-protocol-validate-entities.ts";
import { blockingAssessment, queryPageRow } from "./daemon-protocol-validate-task.ts";
import { decisionStateWords, factLivenessWords, taskStatusWords } from "./daemon-protocol-vocabulary.ts";
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
  const entityId = validationEntityId(value, ["command"], "agenda"),
    shapeError = recordShapeError(entityId, value, DAEMON_AGENDA_SCHEMA.required);
  if (shapeError) return [shapeError];
  if (!isJsonObject(value)) return [];
  for (const [field, actual, valid, expectation] of [
    ["schema", value.schema, value.schema === DAEMON_AGENDA_SCHEMA.id, "must match the agenda schema"],
    ["ok", value.ok, value.ok === true, "must be true"],
    ["command", value.command, value.command === "agenda", "must be agenda"],
    ["status", value.status, value.status === "ready" || value.status === "pending", "must be ready or pending"],
    ["watermark", value.watermark, integer(value.watermark), "must be an integer"],
    ["sourceRevision", value.sourceRevision, integer(value.sourceRevision), "must be an integer"],
    ["warnings", value.warnings, warningArray(value.warnings), "must contain valid warnings"],
    ["summary", value.summary, nonEmpty(value.summary), "must be a non-empty string"],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  const pageShapeError = recordShapeError(
    entityId,
    value.page,
    ["sourceLimit", "cursor", "nextCursor"],
    undefined,
    "page",
  );
  if (pageShapeError) return [pageShapeError];
  if (!isJsonObject(value.page)) return [];
  for (const [field, actual, valid, expectation] of [
    [
      "page.sourceLimit",
      value.page.sourceLimit,
      integer(value.page.sourceLimit) && Number(value.page.sourceLimit) >= 1 && Number(value.page.sourceLimit) <= 500,
      "must be an integer from 1 through 500",
    ],
    [
      "page.cursor",
      value.page.cursor,
      value.page.cursor === null || nonEmpty(value.page.cursor),
      "must be null or non-empty",
    ],
    [
      "page.nextCursor",
      value.page.nextCursor,
      value.page.nextCursor === null || nonEmpty(value.page.nextCursor),
      "must be null or non-empty",
    ],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  for (const field of ["inFlight", "waitingOnOthers", "dispatchable"] as const) {
    if (!Array.isArray(value[field])) return [validationError(entityId, field, value[field], "must be an array")];
    const invalidIndex = value[field].findIndex((row) => !agendaTask(row));
    if (invalidIndex >= 0)
      return [
        validationError(
          validationEntityId(value[field][invalidIndex], ["taskId"], entityId),
          `${field}[${invalidIndex}]`,
          value[field][invalidIndex],
          "must be a valid agenda task",
        ),
      ];
  }
  if (!Array.isArray(value.awaitingDecision))
    return [validationError(entityId, "awaitingDecision", value.awaitingDecision, "must be an array")];
  const awaitingIndex = value.awaitingDecision.findIndex((row) => !agendaAwaiting(row));
  if (awaitingIndex >= 0)
    return [
      validationError(
        validationEntityId(value.awaitingDecision[awaitingIndex], ["taskId", "decisionId", "executionId"], entityId),
        `awaitingDecision[${awaitingIndex}]`,
        value.awaitingDecision[awaitingIndex],
        "must be a valid awaiting item",
      ),
    ];
  return [];
}

export function validateDaemonRelationGraph(value: unknown): readonly string[] {
  const entityId = `relation-graph:${isJsonObject(value) && nonEmpty(value.facet) ? value.facet : "full"}`,
    requiredShapeError = recordShapeError(
      entityId,
      value,
      DAEMON_RELATION_GRAPH_SCHEMA.required,
      isJsonObject(value) ? Object.keys(value) : DAEMON_RELATION_GRAPH_SCHEMA.required,
    );
  if (requiredShapeError) return [requiredShapeError];
  if (!isJsonObject(value)) return [];
  const full = value.facet === undefined,
    canonicalCut = full || value.facet !== "runtimeEdges",
    topFields = [
      ...DAEMON_RELATION_GRAPH_SCHEMA.required,
      ...(canonicalCut ? DAEMON_RELATION_GRAPH_SCHEMA.canonicalCut : []),
      ...(full && value.page !== undefined ? ["page"] : []),
      ...(full ? [] : ["facet"]),
    ];
  const shapeError = recordShapeError(entityId, value, topFields);
  if (shapeError) return [shapeError];
  for (const [field, actual, valid, expectation] of [
    ["ok", value.ok, value.ok === true, "must be true"],
    [
      "status",
      value.status,
      !canonicalCut || value.status === "ready" || value.status === "pending",
      "must be ready or pending",
    ],
    ["watermark", value.watermark, !canonicalCut || integer(value.watermark), "must be an integer"],
    ["sourceRevision", value.sourceRevision, !canonicalCut || integer(value.sourceRevision), "must be an integer"],
    ["warnings", value.warnings, warningArray(value.warnings), "must contain valid warnings"],
    ["page", value.page, !full || value.page === undefined || queryPageRow(value.page), "must be a valid query page"],
    ["edges", value.edges, Array.isArray(value.edges), "must be an array"],
    ["coverageRows", value.coverageRows, Array.isArray(value.coverageRows), "must be an array"],
    ["factAnchors", value.factAnchors, Array.isArray(value.factAnchors), "must be an array"],
    ["facts", value.facts, Array.isArray(value.facts), "must be an array"],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  if (
    !Array.isArray(value.edges) ||
    !Array.isArray(value.coverageRows) ||
    !Array.isArray(value.factAnchors) ||
    !Array.isArray(value.facts)
  )
    return [];
  if (full) {
    for (const [field, rows, invalid] of [
      ["edges", value.edges, relationEdgeInvalid],
      ["coverageRows", value.coverageRows, coverageRowInvalid],
      ["factAnchors", value.factAnchors, factAnchorInvalid],
      ["facts", value.facts, fullFactInvalid],
    ] as const) {
      const index = rows.findIndex(invalid);
      if (index >= 0)
        return [
          validationError(
            validationEntityId(rows[index], ["relationId", "decisionRef", "factRef", "factId", "ref"], entityId),
            `${field}[${index}]`,
            rows[index],
            "must be a valid relation-graph row",
          ),
        ];
    }
    return [];
  }
  if (!["edges", "facts", "coverageRows", "factAnchors", "runtimeEdges"].includes(String(value.facet)))
    return [validationError(entityId, "facet", value.facet, "must name a supported relation-graph facet")];
  // `runtimeEdges` 与 `edges` 同为边切面:选中的数组是 edges,其余必须为空。
  const edgesFacet = value.facet === "edges" || value.facet === "runtimeEdges";
  const populatedUnselected = [
    ["edges", value.edges, edgesFacet],
    ["coverageRows", value.coverageRows, value.facet === "coverageRows"],
    ["factAnchors", value.factAnchors, value.facet === "factAnchors"],
    ["facts", value.facts, value.facet === "facts"],
  ] as const;
  const unexpected = populatedUnselected.find(([, rows, selected]) => !selected && rows.length !== 0);
  if (unexpected)
    return [validationError(entityId, unexpected[0], unexpected[1], "must be empty when its facet is not selected")];
  const selected = edgesFacet
    ? (["edges", value.edges, relationEdgeInvalid] as const)
    : value.facet === "coverageRows"
      ? (["coverageRows", value.coverageRows, coverageRowInvalid] as const)
      : value.facet === "factAnchors"
        ? (["factAnchors", value.factAnchors, factAnchorInvalid] as const)
        : (["facts", value.facts, factSummaryInvalid] as const);
  const invalidIndex = selected[1].findIndex(selected[2]);
  if (invalidIndex >= 0)
    return [
      validationError(
        validationEntityId(
          selected[1][invalidIndex],
          ["relationId", "decisionRef", "factRef", "factId", "anchor"],
          entityId,
        ),
        `${selected[0]}[${invalidIndex}]`,
        selected[1][invalidIndex],
        "must be a valid selected-facet row",
      ),
    ];
  return [];
}

function relationEdgeInvalid(edge: unknown): boolean {
  return (
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
    ].some((field) => !nonEmpty(edge[field]))
  );
}

function coverageRowInvalid(row: unknown): boolean {
  return (
    !recordWith(row, ["decisionRef", "claimRef", "status", "fulfillment", "relationPath"]) ||
    !nonEmpty(row.decisionRef) ||
    !nonEmpty(row.claimRef) ||
    (row.status !== "covered" && row.status !== "uncovered") ||
    (row.fulfillment !== null && !["evidenced", "delivered", "standing-policy"].includes(String(row.fulfillment))) ||
    (row.refutingFactRefs !== undefined && !stringArray(row.refutingFactRefs)) ||
    !stringArray(row.relationPath) ||
    (row.basisRevision !== undefined && !integer(row.basisRevision)) ||
    (row.coveringFactRef !== undefined && !nonEmpty(row.coveringFactRef)) ||
    (row.freshnessReason !== undefined &&
      !["refuted", "no-live-evidence", "fulfillment-undeclared"].includes(String(row.freshnessReason)))
  );
}

function factAnchorInvalid(row: unknown): boolean {
  return (
    !recordWith(row, ["factRef", "factId", "sourcePath"]) ||
    ["factRef", "factId", "sourcePath"].some((field) => !nonEmpty(row[field])) ||
    (row.taskId !== undefined && !nonEmpty(row.taskId))
  );
}

function fullFactInvalid(row: unknown): boolean {
  return (
    !recordWith(row, [
      "schema",
      "ref",
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
    !statusWord(factLivenessWords, row.liveness) ||
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
    ["ref", "factId", "statement", "source", "observedAt"].some((field) => !nonEmpty(row[field])) ||
    (row.taskId !== undefined && !nonEmpty(row.taskId))
  );
}

function factSummaryInvalid(row: unknown): boolean {
  return (
    !recordWith(row, ["anchor", "text", "category"]) ||
    Object.keys(row).some((field) => !["anchor", "text", "category", "taskId"].includes(field)) ||
    !nonEmpty(row.anchor) ||
    !nonEmpty(row.text) ||
    !["lesson", "finding", "progress"].includes(String(row.category)) ||
    (row.taskId !== undefined && !nonEmpty(row.taskId))
  );
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
  if (isJsonObject(value) && value.projection === "summary") {
    const firstDecision = Array.isArray(value.decisions) ? value.decisions[0] : undefined,
      entityId = validationEntityId(firstDecision, ["decisionId"], "decision-list:summary"),
      shapeError = recordShapeError(entityId, value, ["ok", "projection", "decisions", "warnings"]);
    if (shapeError) return [shapeError];
    if (value.ok !== true) return [validationError(entityId, "ok", value.ok, "must be true")];
    if (!warningArray(value.warnings))
      return [validationError(entityId, "warnings", value.warnings, "must contain valid warnings")];
    if (!Array.isArray(value.decisions))
      return [validationError(entityId, "decisions", value.decisions, "must be an array")];
    const invalidIndex = value.decisions.findIndex(
      (row) =>
        !exactRecord(row, ["decisionId", "title", "state", "appliesTo"]) ||
        !nonEmpty(row.decisionId) ||
        !nonEmpty(row.title) ||
        !statusWord(decisionStateWords, row.state) ||
        !exactRecord(row.appliesTo, ["modules", "productLines"]) ||
        !stringArray(row.appliesTo.modules) ||
        !stringArray(row.appliesTo.productLines),
    );
    if (invalidIndex >= 0)
      return [
        validationError(
          validationEntityId(value.decisions[invalidIndex], ["decisionId"], entityId),
          `decisions[${invalidIndex}]`,
          value.decisions[invalidIndex],
          "must be a valid decision summary",
        ),
      ];
    return [];
  }
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
  const topFields = [
    ...DAEMON_DECISION_LIST_SCHEMA.required,
    ...(isJsonObject(value) && value.projection === "full" ? ["projection"] : []),
  ];
  const entityId =
      isJsonObject(value) && Array.isArray(value.decisions)
        ? validationEntityId(value.decisions[0], ["decisionId"], "decision-list:full")
        : "decision-list:full",
    shapeError = recordShapeError(entityId, value, topFields);
  if (shapeError) return [shapeError];
  if (!isJsonObject(value)) return [];
  for (const [field, actual, valid, expectation] of [
    ["projection", value.projection, value.projection === undefined || value.projection === "full", "must be full"],
    ["ok", value.ok, value.ok === true, "must be true"],
    ["warnings", value.warnings, warningArray(value.warnings), "must contain valid warnings"],
    ["decisions", value.decisions, Array.isArray(value.decisions), "must be an array"],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  if (!Array.isArray(value.decisions)) return [];
  const invalidIndex = value.decisions.findIndex(
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
  );
  if (invalidIndex >= 0)
    return [
      validationError(
        validationEntityId(value.decisions[invalidIndex], ["decisionId"], entityId),
        `decisions[${invalidIndex}]`,
        value.decisions[invalidIndex],
        "must be a valid decision row",
      ),
    ];
  return [];
}
