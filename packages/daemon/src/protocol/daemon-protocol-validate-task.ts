import {
  generatedTaskActionProtocolDeclarations,
  type GeneratedTaskActionProtocolDeclaration,
} from "./daemon-protocol-commands-task.ts";
import type { artifactEntityImportActionInput } from "../../../kernel/src/index.ts";
import { DAEMON_TASK_SNAPSHOT_LIST_SCHEMA, DAEMON_WORKSPACE_SUMMARY_SCHEMA } from "./daemon-protocol-schema-ids.ts";
import {
  codeDocRecord,
  consent,
  exactRecord,
  execution,
  gate,
  integer,
  iteration,
  lease,
  nonEmpty,
  recordWith,
  review,
  sha,
  statusWord,
  stringArray,
  task,
  validationEntityId,
  validationError,
  validationValueAtPath,
  validationValueSummary,
  warningArray,
  recordShapeError,
} from "./daemon-protocol-validate-entities.ts";
import {
  decisionStateWords,
  packageDispositionWords,
  relationFreshnessWords,
  relationStateWords,
  taskBoardColumnWords,
  taskCapabilityIdWords,
  taskCapabilityReasonWords,
  relationStrengthWords,
  taskStatusWords,
} from "./daemon-protocol-vocabulary.ts";
import { isJsonObject, type JsonObject } from "./json-rpc-types.ts";
import type { DaemonTaskSnapshotInvalidRow } from "./daemon-protocol-gui-types.ts";

export const availabilityFields = ["consents", "codeDocWitnesses", "gateWitnesses"] as const,
  snapshotBaseFields = [
    "revision",
    "task",
    "executions",
    "reviews",
    "edgesTaken",
    "lease",
    "decisionRelations",
  ] as const;

const artifactEntityImportProtocolInput = Object.freeze({
  schema: "entity-action-input/v1",
  fields: Object.freeze([
    { field: "entityKind", type: "string", required: true },
    { field: "locator", type: "string", required: true },
    { field: "expectedVersion", type: "number", required: true },
    { field: "title", type: "string", required: false },
    { field: "entityId", type: "string", required: false },
    { field: "sourceIdentity", type: "string", required: false },
    { field: "idempotencyKey", type: "string", required: false },
    { field: "dryRun", type: "boolean", required: false },
  ]),
  exactlyOneOf: Object.freeze([]),
} as const satisfies typeof artifactEntityImportActionInput);

const adrMigrationProtocolInput = Object.freeze({
  schema: "entity-action-input/v1",
  fields: Object.freeze([
    { field: "registryRevision", type: "string" as const, required: true },
    { field: "migrationOpId", type: "string" as const, required: true },
    { field: "expectCount", type: "number" as const, required: false },
    { field: "dryRun", type: "boolean" as const, required: false },
  ]),
  exactlyOneOf: Object.freeze([]),
});

const taskActionProtocolByIngress: ReadonlyMap<string, GeneratedTaskActionProtocolDeclaration> = new Map(
  generatedTaskActionProtocolDeclarations.map((action) => [action.execution.ingress, action] as const),
);

export function validateCatalogActionPayload(value: JsonObject): readonly string[] {
  const action = (value.payload as JsonObject).action;
  if (!isJsonObject(action) || typeof action.kind !== "string") return [];
  const declaration = taskActionProtocolByIngress.get(action.kind);
  if (declaration) return validateProjectedTaskActionInput(action.kind, declaration.input, action);
  if (action.kind === "entity-import")
    return validateProjectedTaskActionInput(action.kind, artifactEntityImportProtocolInput, action);
  return action.kind === "entity-migrate-adrs"
    ? validateProjectedTaskActionInput(action.kind, adrMigrationProtocolInput, action)
    : [];
}

function validateProjectedTaskActionInput(
  ingress: string,
  input: GeneratedTaskActionProtocolDeclaration["input"],
  record: Readonly<Record<string, unknown>>,
): readonly string[] {
  const allowed = new Set(["kind", "executor", ...input.fields.map(({ field }) => field)]),
    entityId = validationEntityId(record, ["taskId", "executionId"], `action:${ingress}`),
    errors = Object.keys(record)
      .filter((field) => !allowed.has(field))
      .map((field) =>
        validationError(entityId, `action.${field}`, record[field], "is not declared by the Action input schema"),
      );
  for (const field of input.fields) {
    const item = record[field.field];
    if (field.required && (item === undefined || item === "")) {
      errors.push(validationError(entityId, `action.${field.field}`, item, "field is required"));
      continue;
    }
    if (item === undefined) continue;
    const valid =
      (field.type === "string" && typeof item === "string" && item.length > 0) ||
      (field.type === "number" && Number.isSafeInteger(item) && Number(item) >= 0) ||
      (field.type === "boolean" && typeof item === "boolean") ||
      (field.type === "string-array" && Array.isArray(item) && item.every((entry) => typeof entry === "string")) ||
      (field.type === "fact-hold-array" &&
        Array.isArray(item) &&
        item.every(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { readonly factRef?: unknown }).factRef === "string" &&
            typeof (entry as { readonly rationale?: unknown }).rationale === "string",
        ));
    if (!valid) errors.push(validationError(entityId, `action.${field.field}`, item, `must be ${field.type}`));
    if (field.enum && !field.enum.includes(String(item)))
      errors.push(validationError(entityId, `action.${field.field}`, item, `must be one of ${field.enum.join(", ")}`));
    if (field.regex && typeof item === "string" && !new RegExp(field.regex, "u").test(item))
      errors.push(validationError(entityId, `action.${field.field}`, item, "does not match its Action input pattern"));
  }
  for (const group of input.exactlyOneOf) {
    const present = group.filter((field) => record[field] !== undefined);
    if (present.length !== 1)
      errors.push(
        validationError(
          entityId,
          `action.[${group.join("|")}]`,
          Object.fromEntries(group.map((field) => [field, record[field]])),
          "requires exactly one declared field",
        ),
      );
  }
  return errors;
}

export function validateSessionEnvironment(value: unknown): string[] {
  if (value === undefined) return [];
  const entityId = validationEntityId(
    value,
    ["HARNESS_ACTOR", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_SESSION_ID"],
    "session:<unknown>",
  );
  if (!isJsonObject(value)) return [validationError(entityId, "sessionEnvironment", value, "must be an object")];
  const allowed = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HARNESS_ACTOR"],
    unknown = Object.keys(value).find((field) => !allowed.includes(field));
  if (unknown)
    return [validationError(entityId, `sessionEnvironment.${unknown}`, value[unknown], "field is not declared")];
  const invalidValue = Object.entries(value).find(([, item]) => typeof item !== "string" || item.trim().length === 0);
  if (invalidValue)
    return [
      validationError(entityId, `sessionEnvironment.${invalidValue[0]}`, invalidValue[1], "must be a non-empty string"),
    ];
  if (
    typeof value.HARNESS_ACTOR === "string" &&
    !/^agent:[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.HARNESS_ACTOR.trim())
  )
    return [validationError(entityId, "sessionEnvironment.HARNESS_ACTOR", value.HARNESS_ACTOR, "must use agent:<id>")];
  return [];
}

export function snapshot(value: unknown, availability: unknown): boolean {
  return snapshotFailurePaths(value, availability).length === 0;
}

export function placement(value: unknown): boolean {
  return (
    exactRecord(value, [
      "moduleKeys",
      "productLines",
      "spawningDecisionIds",
      "parentTaskId",
      "origin",
      "engine",
      "packageDisposition",
      "provenance",
    ]) &&
    stringArray(value.moduleKeys) &&
    stringArray(value.productLines) &&
    stringArray(value.spawningDecisionIds) &&
    (value.parentTaskId === null || nonEmpty(value.parentTaskId)) &&
    ["native", "archival", "external"].includes(String(value.origin)) &&
    nonEmpty(value.engine) &&
    statusWord(packageDispositionWords, value.packageDisposition) &&
    Array.isArray(value.provenance) &&
    value.provenance.every(
      (row) =>
        exactRecord(row, ["kind", "ref"]) &&
        ["l2", "decision-relation", "canonical-event"].includes(String(row.kind)) &&
        nonEmpty(row.ref),
    )
  );
}

export function executionEvidence(value: unknown): boolean {
  return (
    exactRecord(value, ["executionId", "origin", "outputs"]) &&
    nonEmpty(value.executionId) &&
    (value.origin === "native" || value.origin === "archival") &&
    Array.isArray(value.outputs) &&
    value.outputs.every(
      (output) =>
        exactRecord(output, ["evidenceId", "locator", "substrate", "checkerReceiptRef", "checkerResult"]) &&
        /^evidence_[0-9a-f]{24}$/u.test(String(output.evidenceId)) &&
        nonEmpty(output.locator) &&
        ["repository-path", "uri", "canonical-event", "opaque"].includes(String(output.substrate)) &&
        (output.checkerReceiptRef === null || nonEmpty(output.checkerReceiptRef)) &&
        ["pass", "fail", "unknown"].includes(String(output.checkerResult)) &&
        (output.checkerResult === "unknown" || output.checkerReceiptRef !== null),
    )
  );
}

export function closeoutAssessment(value: unknown): boolean {
  if (
    !recordWith(value, ["readiness", "gates"]) ||
    Object.keys(value).some((key) => !["readiness", "executionId", "blocker", "gates"].includes(key)) ||
    !["not_required", "missing", "incomplete", "ready", "passed", "failed"].includes(String(value.readiness)) ||
    (value.executionId !== undefined && !nonEmpty(value.executionId)) ||
    (value.blocker !== undefined &&
      !["execution", "review", "consent", "gate", "lineage", "projection_unknown"].includes(String(value.blocker))) ||
    !Array.isArray(value.gates)
  )
    return false;
  return value.gates.every(
    (gate) =>
      recordWith(gate, ["gateId", "status"]) &&
      Object.keys(gate).every((key) => ["gateId", "status", "detail"].includes(key)) &&
      nonEmpty(gate.gateId) &&
      ["passed", "failed", "missing", "unknown"].includes(String(gate.status)) &&
      (gate.detail === undefined || nonEmpty(gate.detail)),
  );
}

export function blockingAssessment(value: unknown): boolean {
  if (
    !exactRecord(value, ["taskId", "state", "blockers", "warnings"]) ||
    !nonEmpty(value.taskId) ||
    !["blocked", "clear", "unknown"].includes(String(value.state)) ||
    !stringArray(value.warnings) ||
    !Array.isArray(value.blockers)
  )
    return false;
  return value.blockers.every(
    (blocker) =>
      recordWith(blocker, ["relationId", "kind", "sourceTaskId", "targetTaskId"]) &&
      Object.keys(blocker).every((key) =>
        ["relationId", "kind", "sourceTaskId", "targetTaskId", "rationale"].includes(key),
      ) &&
      blocker.kind === "depends-on" &&
      [blocker.relationId, blocker.sourceTaskId, blocker.targetTaskId].every(nonEmpty) &&
      (blocker.rationale === undefined || nonEmpty(blocker.rationale)),
  );
}

/**
 * The `task-board-rows` projection on the wire. Column, capability id and rejection reason are all
 * closed word sets mirrored from the kernel judgment, so a row carrying free-text prose in `reason`
 * or an invented column is rejected at the boundary rather than rendered.
 */
export function boardPlacement(value: unknown): boolean {
  return (
    exactRecord(value, ["columnId", "rank"]) &&
    (value.columnId === null || statusWord(taskBoardColumnWords, value.columnId)) &&
    integer(value.rank) &&
    Number(value.rank) >= 0
  );
}

export function capabilityList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== taskCapabilityIdWords.length) return false;
  return value.every(
    (capability, index) =>
      exactRecord(capability, ["id", "available", "reason"]) &&
      capability.id === taskCapabilityIdWords[index] &&
      typeof capability.available === "boolean" &&
      (capability.reason === null
        ? capability.available
        : !capability.available && statusWord(taskCapabilityReasonWords, capability.reason)),
  );
}

export function queryPageRow(value: unknown): boolean {
  return (
    exactRecord(value, ["limit", "cursor", "nextCursor"]) &&
    integer(value.limit) &&
    Number(value.limit) > 0 &&
    Number(value.limit) <= 500 &&
    (value.cursor === null || nonEmpty(value.cursor)) &&
    (value.nextCursor === null || nonEmpty(value.nextCursor))
  );
}

export function validateDaemonTaskSnapshotList(value: unknown): readonly string[] {
  const entityId = taskSnapshotListEntityId(value),
    shapeError = recordShapeError(entityId, value, DAEMON_TASK_SNAPSHOT_LIST_SCHEMA.required, [
      ...DAEMON_TASK_SNAPSHOT_LIST_SCHEMA.required,
      "page",
    ]);
  if (shapeError) return [shapeError];
  if (!isJsonObject(value)) return [];
  for (const [field, actual, valid, expectation] of [
    ["ok", value.ok, value.ok === true, "must be true"],
    ["status", value.status, value.status === "ready" || value.status === "pending", "must be ready or pending"],
    ["watermark", value.watermark, integer(value.watermark), "must be an integer"],
    ["sourceRevision", value.sourceRevision, integer(value.sourceRevision), "must be an integer"],
    ["warnings", value.warnings, warningArray(value.warnings), "must contain valid warnings"],
    ["page", value.page, value.page === undefined || queryPageRow(value.page), "must be a valid query page"],
    ["rows", value.rows, Array.isArray(value.rows), "must be an array"],
    ["invalidRows", value.invalidRows, Array.isArray(value.invalidRows), "must be an array"],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  if (!Array.isArray(value.invalidRows) || !Array.isArray(value.rows)) return [];
  const invalidRowIndex = value.invalidRows.findIndex((row) => !invalidTaskSnapshotRow(row));
  if (invalidRowIndex >= 0)
    return [
      validationError(
        validationEntityId(value.invalidRows[invalidRowIndex], ["taskId"], entityId),
        `invalidRows[${invalidRowIndex}]`,
        value.invalidRows[invalidRowIndex],
        "must be a valid isolated-row diagnostic",
      ),
    ];
  const unisolated = isolateDaemonTaskSnapshotRows(value.rows).invalidRows[0];
  return unisolated
    ? [`entity=${validationValueSummary(unisolated.taskId)} field=${unisolated.field} ${unisolated.message}`]
    : [];
}

export function isolateDaemonTaskSnapshotRows<T>(values: readonly T[]): {
  readonly rows: readonly T[];
  readonly invalidRows: readonly DaemonTaskSnapshotInvalidRow[];
} {
  const rows: T[] = [],
    invalidRows: DaemonTaskSnapshotInvalidRow[] = [];
  values.forEach((row, index) => {
    const errors = taskSnapshotRowErrors(row, index);
    if (errors.length === 0) rows.push(row);
    else invalidRows.push(...errors);
  });
  return { rows, invalidRows };
}

const taskSnapshotListRowFields = [
  "taskId",
  "packagePath",
  "generation",
  "workspaceRevision",
  "createdAt",
  "updatedAt",
  "snapshot",
  "coordinationStatus",
  "snapshotAvailability",
  "closeoutAssessment",
  "blockingAssessment",
  "placement",
  "executionEvidence",
  "board",
  "visibility",
  "capabilities",
] as const;

function taskSnapshotRowErrors(value: unknown, index: number): readonly DaemonTaskSnapshotInvalidRow[] {
  const taskId = isJsonObject(value) && nonEmpty(value.taskId) ? value.taskId : "<unknown>",
    error = (field: string): DaemonTaskSnapshotInvalidRow => ({
      rowIndex: index,
      taskId,
      field: `rows[${index}]${field ? `.${field}` : ""}`,
      message:
        `actual=${validationValueSummary(field ? validationValueAtPath(value, field) : value)}: ` +
        "Task snapshot field is invalid.",
    });
  if (!isJsonObject(value)) return [error("")];
  const missing = taskSnapshotListRowFields.find((field) => !Object.hasOwn(value, field));
  if (missing) return [error(missing)];
  const unknown = Object.keys(value).find((field) => !taskSnapshotListRowFields.includes(field as never));
  if (unknown) return [error(unknown)];
  const errors: DaemonTaskSnapshotInvalidRow[] = [];
  if (!nonEmpty(value.taskId)) errors.push(error("taskId"));
  if (value.packagePath !== null && !nonEmpty(value.packagePath)) errors.push(error("packagePath"));
  if (value.generation !== "v0" && value.generation !== "v1") errors.push(error("generation"));
  if (!integer(value.workspaceRevision)) errors.push(error("workspaceRevision"));
  if (value.createdAt !== null && !nonEmpty(value.createdAt)) errors.push(error("createdAt"));
  if (!nonEmpty(value.updatedAt)) errors.push(error("updatedAt"));
  if (!statusWord([...taskStatusWords, "unknown"], value.coordinationStatus)) errors.push(error("coordinationStatus"));
  if (!snapshot(value.snapshot, value.snapshotAvailability))
    errors.push(...snapshotFailurePaths(value.snapshot, value.snapshotAvailability).map(error));
  if (!closeoutAssessment(value.closeoutAssessment)) errors.push(error("closeoutAssessment"));
  if (!blockingAssessment(value.blockingAssessment)) errors.push(error("blockingAssessment"));
  if (!placement(value.placement)) errors.push(error("placement"));
  if (!boardPlacement(value.board)) errors.push(error("board"));
  if (!exactRecord(value.visibility, ["archived"]) || typeof value.visibility.archived !== "boolean")
    errors.push(error("visibility"));
  if (!capabilityList(value.capabilities)) errors.push(error("capabilities"));
  if (!Array.isArray(value.executionEvidence)) errors.push(error("executionEvidence"));
  else
    value.executionEvidence.forEach((item, evidenceIndex) => {
      if (!executionEvidence(item)) errors.push(error(`executionEvidence[${evidenceIndex}]`));
    });
  return errors;
}

function invalidTaskSnapshotRow(value: unknown): boolean {
  if (
    !exactRecord(value, ["rowIndex", "taskId", "field", "message"]) ||
    !integer(value.rowIndex) ||
    Number(value.rowIndex) < 0 ||
    !nonEmpty(value.taskId) ||
    !nonEmpty(value.field) ||
    !nonEmpty(value.message) ||
    !value.message.startsWith("actual=")
  )
    return false;
  const rowPath = `rows[${value.rowIndex}]`;
  return value.field === rowPath || value.field.startsWith(`${rowPath}.`);
}

function snapshotFailurePaths(value: unknown, availability: unknown): readonly string[] {
  if (
    !exactRecord(availability, availabilityFields) ||
    availabilityFields.some((field) => availability[field] !== "known" && availability[field] !== "unknown")
  )
    return ["snapshotAvailability"];
  if (!isJsonObject(value)) return ["snapshot"];
  const known = availabilityFields.filter((field) => availability[field] === "known"),
    paths: string[] = [];
  if (!exactRecord(value, [...snapshotBaseFields, ...known])) paths.push("snapshot");
  if (!integer(value.revision)) paths.push("snapshot.revision");
  if (value.task !== null && !task(value.task)) paths.push("snapshot.task");
  for (const [field, validate] of [
    ["executions", execution],
    ["reviews", review],
  ] as const) {
    const rows = value[field];
    if (!Array.isArray(rows)) paths.push(`snapshot.${field}`);
    else rows.forEach((row, index) => !validate(row) && paths.push(`snapshot.${field}[${index}]`));
  }
  if (
    !Array.isArray(value.edgesTaken) ||
    value.edgesTaken.some(
      (edge) =>
        !exactRecord(edge, ["edgeId", "from", "to", "on", "actorRole", "reason", "commitSha", "iteration"]) ||
        !nonEmpty(edge.edgeId) ||
        !nonEmpty(edge.reason) ||
        !sha(edge.commitSha) ||
        !iteration(edge.iteration),
    )
  )
    paths.push("snapshot.edgesTaken");
  if (value.lease !== null && !lease(value.lease)) paths.push("snapshot.lease");
  if (
    !Array.isArray(value.decisionRelations) ||
    value.decisionRelations.some(
      (relation) =>
        !exactRecord(relation, [
          "relationId",
          "sourceRef",
          "targetRef",
          "relationType",
          "state",
          "strength",
          "freshness",
        ]) ||
        ![relation.relationId, relation.sourceRef, relation.targetRef, relation.relationType].every(nonEmpty) ||
        !statusWord(relationStateWords, relation.state) ||
        !statusWord(relationStrengthWords, relation.strength) ||
        !statusWord(relationFreshnessWords, relation.freshness),
    )
  )
    paths.push("snapshot.decisionRelations");
  const validators = { consents: consent, codeDocWitnesses: codeDocRecord, gateWitnesses: gate };
  for (const field of known) {
    const rows = value[field];
    if (!Array.isArray(rows)) paths.push(`snapshot.${field}`);
    else rows.forEach((row, index) => !validators[field](row) && paths.push(`snapshot.${field}[${index}]`));
  }
  return [...new Set(paths)];
}

export function validateDaemonWorkspaceSummary(value: unknown): readonly string[] {
  const entityId = "workspace",
    shapeError = recordShapeError(entityId, value, DAEMON_WORKSPACE_SUMMARY_SCHEMA.required);
  if (shapeError) return [shapeError];
  if (!isJsonObject(value)) return [];
  for (const [field, actual, valid, expectation] of [
    ["schema", value.schema, value.schema === DAEMON_WORKSPACE_SUMMARY_SCHEMA.id, "must match the workspace schema"],
    ["ok", value.ok, value.ok === true, "must be true"],
    ["status", value.status, value.status === "ready" || value.status === "pending", "must be ready or pending"],
    ["watermark", value.watermark, integer(value.watermark), "must be an integer"],
    ["sourceRevision", value.sourceRevision, integer(value.sourceRevision), "must be an integer"],
    ["warnings", value.warnings, warningArray(value.warnings), "must contain valid warnings"],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  const taskStatuses = [...taskStatusWords, "unknown"],
    tasks = value.tasks,
    decisions = value.decisions;
  const tasksShapeError = recordShapeError(entityId, tasks, ["total", "byStatus"], undefined, "tasks");
  if (tasksShapeError) return [tasksShapeError];
  if (!isJsonObject(tasks)) return [];
  if (!integer(tasks.total) || Number(tasks.total) < 0)
    return [validationError(entityId, "tasks.total", tasks.total, "must be a non-negative integer")];
  const byStatus = tasks.byStatus;
  const statusShapeError = recordShapeError(entityId, byStatus, taskStatuses, undefined, "tasks.byStatus");
  if (statusShapeError) return [statusShapeError];
  if (!isJsonObject(byStatus)) return [];
  const invalidTaskStatus = taskStatuses.find((status) => !integer(byStatus[status]) || Number(byStatus[status]) < 0);
  if (invalidTaskStatus)
    return [
      validationError(
        entityId,
        `tasks.byStatus.${invalidTaskStatus}`,
        byStatus[invalidTaskStatus],
        "must be a non-negative integer",
      ),
    ];
  if (taskStatuses.reduce((sum, status) => sum + Number(byStatus[status]), 0) !== tasks.total)
    return [validationError(entityId, "tasks.total", tasks.total, "must equal the by-status sum")];
  const decisionsShapeError = recordShapeError(
    entityId,
    decisions,
    ["total", "inboxCount", "byState", "groups"],
    undefined,
    "decisions",
  );
  if (decisionsShapeError) return [decisionsShapeError];
  if (!isJsonObject(decisions)) return [];
  if (!integer(decisions.total) || Number(decisions.total) < 0)
    return [validationError(entityId, "decisions.total", decisions.total, "must be a non-negative integer")];
  if (!integer(decisions.inboxCount) || Number(decisions.inboxCount) < 0)
    return [validationError(entityId, "decisions.inboxCount", decisions.inboxCount, "must be a non-negative integer")];
  if (!Array.isArray(decisions.groups))
    return [validationError(entityId, "decisions.groups", decisions.groups, "must be an array")];
  const byDecisionState = decisions.byState;
  const stateShapeError = recordShapeError(
    entityId,
    byDecisionState,
    decisionStateWords,
    undefined,
    "decisions.byState",
  );
  if (stateShapeError) return [stateShapeError];
  if (!isJsonObject(byDecisionState)) return [];
  const invalidDecisionState = decisionStateWords.find(
    (state) => !integer(byDecisionState[state]) || Number(byDecisionState[state]) < 0,
  );
  if (invalidDecisionState)
    return [
      validationError(
        entityId,
        `decisions.byState.${invalidDecisionState}`,
        byDecisionState[invalidDecisionState],
        "must be a non-negative integer",
      ),
    ];
  if (decisionStateWords.reduce((sum, state) => sum + Number(byDecisionState[state]), 0) !== decisions.total)
    return [validationError(entityId, "decisions.total", decisions.total, "must equal the by-state sum")];
  const groupIds = ["proposed", "in_effect", "rejected", "deferred", "retired"],
    decisionIds: string[] = [],
    states: string[] = [];
  if (decisions.groups.length !== groupIds.length)
    return [
      validationError(entityId, "decisions.groups.length", decisions.groups.length, `must be ${groupIds.length}`),
    ];
  for (const [index, group] of decisions.groups.entries()) {
    if (
      !exactRecord(group, ["id", "states", "count", "decisionIds"]) ||
      group.id !== groupIds[index] ||
      !Array.isArray(group.states) ||
      group.states.some((state) => !statusWord(decisionStateWords, state)) ||
      new Set(group.states).size !== group.states.length ||
      !integer(group.count) ||
      Number(group.count) < 0 ||
      !stringArray(group.decisionIds) ||
      new Set(group.decisionIds).size !== group.decisionIds.length ||
      group.count !== group.decisionIds.length
    )
      return [
        validationError(
          validationEntityId(group, ["id"], `decision-group:${index}`),
          `decisions.groups[${index}]`,
          group,
          "must be a valid decision group",
        ),
      ];
    states.push(...group.states.map(String));
    decisionIds.push(...group.decisionIds.map(String));
  }
  if (
    states.length !== decisionStateWords.length ||
    !decisionStateWords.every((state) => states.includes(state)) ||
    new Set(decisionIds).size !== decisionIds.length ||
    decisions.total !== decisionIds.length ||
    decisions.inboxCount !== decisions.groups[0].count
  )
    return [
      validationError(entityId, "decisions.total", decisions.total, "must match unique grouped decisions and inbox"),
    ];
  return [];
}

function taskSnapshotListEntityId(value: unknown): string {
  if (isJsonObject(value) && Array.isArray(value.rows)) {
    const rowId = validationEntityId(value.rows[0], ["taskId"], "");
    if (rowId) return rowId;
  }
  return "task-snapshot-list";
}
