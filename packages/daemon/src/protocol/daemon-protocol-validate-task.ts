import { DAEMON_TASK_SNAPSHOT_LIST_SCHEMA, DAEMON_WORKSPACE_SUMMARY_SCHEMA } from "./daemon-protocol-schema-ids.ts";
import {
  codeDoc,
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
  warningArray,
} from "./daemon-protocol-validate-entities.ts";
import {
  decisionStateWords,
  packageDispositionWords,
  relationStateWords,
  taskStatusWords,
} from "./daemon-protocol-vocabulary.ts";
import { isJsonObject } from "./json-rpc-types.ts";

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

export function snapshot(value: unknown, availability: unknown): boolean {
  if (
    !exactRecord(availability, availabilityFields) ||
    availabilityFields.some((field) => availability[field] !== "known" && availability[field] !== "unknown") ||
    !isJsonObject(value)
  )
    return false;
  const known = availabilityFields.filter((field) => availability[field] === "known"),
    expected = [...snapshotBaseFields, ...known];
  if (
    !exactRecord(value, expected) ||
    !integer(value.revision) ||
    (value.task !== null && !task(value.task)) ||
    !Array.isArray(value.executions) ||
    value.executions.some((item) => !execution(item)) ||
    !Array.isArray(value.reviews) ||
    value.reviews.some((item) => !review(item)) ||
    !Array.isArray(value.edgesTaken) ||
    value.edgesTaken.some(
      (edge) =>
        !exactRecord(edge, ["edgeId", "from", "to", "on", "actorRole", "reason", "commitSha", "iteration"]) ||
        !nonEmpty(edge.edgeId) ||
        !nonEmpty(edge.reason) ||
        !sha(edge.commitSha) ||
        !iteration(edge.iteration),
    ) ||
    (value.lease !== null && !lease(value.lease)) ||
    !Array.isArray(value.decisionRelations) ||
    value.decisionRelations.some(
      (relation) =>
        !exactRecord(relation, ["relationId", "sourceRef", "targetRef", "relationType", "state"]) ||
        ![relation.relationId, relation.sourceRef, relation.targetRef, relation.relationType].every(nonEmpty) ||
        !statusWord(relationStateWords, relation.state),
    )
  )
    return false;
  const validators = {
    consents: consent,
    codeDocWitnesses: codeDoc,
    gateWitnesses: gate,
  };
  return known.every((field) => Array.isArray(value[field]) && value[field].every(validators[field]));
}

export function placement(value: unknown): boolean {
  return (
    exactRecord(value, [
      "moduleKeys",
      "productLines",
      "parentTaskId",
      "origin",
      "engine",
      "packageDisposition",
      "provenance",
    ]) &&
    stringArray(value.moduleKeys) &&
    stringArray(value.productLines) &&
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
  const rowFields = [
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
  ];
  if (
    !recordWith(value, DAEMON_TASK_SNAPSHOT_LIST_SCHEMA.required) ||
    (isJsonObject(value) &&
      Object.keys(value).some((field) => ![...DAEMON_TASK_SNAPSHOT_LIST_SCHEMA.required, "page"].includes(field))) ||
    value.ok !== true ||
    (value.status !== "ready" && value.status !== "pending") ||
    !integer(value.watermark) ||
    !integer(value.sourceRevision) ||
    !warningArray(value.warnings) ||
    (value.page !== undefined && !queryPageRow(value.page)) ||
    !Array.isArray(value.rows) ||
    value.rows.some(
      (row) =>
        !exactRecord(row, rowFields) ||
        !nonEmpty(row.taskId) ||
        (row.packagePath !== null && !nonEmpty(row.packagePath)) ||
        (row.generation !== "v0" && row.generation !== "v1") ||
        !integer(row.workspaceRevision) ||
        (row.createdAt !== null && !nonEmpty(row.createdAt)) ||
        !nonEmpty(row.updatedAt) ||
        !statusWord([...taskStatusWords, "unknown"], row.coordinationStatus) ||
        !snapshot(row.snapshot, row.snapshotAvailability) ||
        !closeoutAssessment(row.closeoutAssessment) ||
        !blockingAssessment(row.blockingAssessment) ||
        !placement(row.placement) ||
        !Array.isArray(row.executionEvidence) ||
        row.executionEvidence.some((item) => !executionEvidence(item)),
    )
  )
    return ["daemon task snapshot list is invalid"];
  return [];
}

export function validateDaemonWorkspaceSummary(value: unknown): readonly string[] {
  if (
    !exactRecord(value, DAEMON_WORKSPACE_SUMMARY_SCHEMA.required) ||
    value.schema !== DAEMON_WORKSPACE_SUMMARY_SCHEMA.id ||
    value.ok !== true ||
    (value.status !== "ready" && value.status !== "pending") ||
    !integer(value.watermark) ||
    !integer(value.sourceRevision) ||
    !warningArray(value.warnings)
  )
    return ["daemon workspace summary is invalid"];
  const taskStatuses = [...taskStatusWords, "unknown"],
    tasks = value.tasks,
    decisions = value.decisions;
  if (!exactRecord(tasks, ["total", "byStatus"]) || !integer(tasks.total) || Number(tasks.total) < 0)
    return ["daemon workspace task summary is invalid"];
  const byStatus = tasks.byStatus;
  if (
    !exactRecord(byStatus, taskStatuses) ||
    taskStatuses.some((status) => !integer(byStatus[status]) || Number(byStatus[status]) < 0) ||
    taskStatuses.reduce((sum, status) => sum + Number(byStatus[status]), 0) !== tasks.total
  )
    return ["daemon workspace task summary is invalid"];
  if (
    !exactRecord(decisions, ["total", "inboxCount", "byState", "groups"]) ||
    !integer(decisions.total) ||
    Number(decisions.total) < 0 ||
    !integer(decisions.inboxCount) ||
    Number(decisions.inboxCount) < 0 ||
    !Array.isArray(decisions.groups)
  )
    return ["daemon workspace decision summary is invalid"];
  const byDecisionState = decisions.byState;
  if (
    !exactRecord(byDecisionState, decisionStateWords) ||
    decisionStateWords.some((state) => !integer(byDecisionState[state]) || Number(byDecisionState[state]) < 0) ||
    decisionStateWords.reduce((sum, state) => sum + Number(byDecisionState[state]), 0) !== decisions.total
  )
    return ["daemon workspace decision summary is invalid"];
  const groupIds = ["proposed", "in_effect", "rejected", "deferred", "retired"],
    decisionIds: string[] = [],
    states: string[] = [];
  if (decisions.groups.length !== groupIds.length) return ["daemon workspace decision groups are invalid"];
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
      return ["daemon workspace decision groups are invalid"];
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
    return ["daemon workspace decision totals are invalid"];
  return [];
}
