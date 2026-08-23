import {
  executionStateWords,
  executionV1StateWords,
  leasePhaseWords,
  packageDispositionWords,
  relationStateWords,
  reviewVerdictWords,
  taskStatusWords,
} from "./daemon-protocol-vocabulary.ts";
import { isJsonObject, type JsonObject } from "./json-rpc-types.ts";

export const recordWith = (value: unknown, fields: readonly string[]): value is JsonObject =>
    isJsonObject(value) && fields.every((field) => Object.hasOwn(value, field)),
  exactRecord = (value: unknown, fields: readonly string[]): value is JsonObject =>
    recordWith(value, fields) && Object.keys(value).length === fields.length;

export const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0,
  integer = (value: unknown): value is number => Number.isInteger(value);

export const stringArray = (value: unknown): value is readonly string[] =>
    Array.isArray(value) && value.every(nonEmpty),
  warningArray = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.every(
      (warning) =>
        recordWith(warning, ["code", "source", "severity", "message"]) &&
        nonEmpty(warning.code) &&
        nonEmpty(warning.source) &&
        nonEmpty(warning.severity) &&
        nonEmpty(warning.message),
    );

export const sha = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value),
  digest = (value: unknown): boolean => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value),
  iteration = (value: unknown): boolean => value === 0 || value === 1;

export const statusWord = (vocabulary: readonly string[], value: unknown): boolean =>
  vocabulary.includes(String(value));

export function actor(value: unknown): boolean {
  return (
    exactRecord(value, ["principal", "executor"]) &&
    exactRecord(value.principal, ["personId"]) &&
    nonEmpty(value.principal.personId) &&
    (value.executor === null ||
      (exactRecord(value.executor, ["kind", "id"]) && value.executor.kind === "agent" && nonEmpty(value.executor.id)))
  );
}

export function source(value: unknown): boolean {
  return (
    value === "local" ||
    value === "remote_direct" ||
    (exactRecord(value, ["kind", "nodeId", "assignmentId"]) &&
      value.kind === "assignment" &&
      nonEmpty(value.nodeId) &&
      nonEmpty(value.assignmentId))
  );
}

export function sessionProvenance(value: unknown): boolean {
  return (
    exactRecord(value, ["runtime", "sessionId", "transcriptReachability", "boundAt"]) &&
    nonEmpty(value.runtime) &&
    nonEmpty(value.boundAt) &&
    (value.sessionId === null
      ? value.transcriptReachability === "unavailable"
      : nonEmpty(value.sessionId) &&
        (value.transcriptReachability === "by_session_id" || value.transcriptReachability === "dispatch_stream_only"))
  );
}

export function validateGuiSubmission(value: unknown): readonly string[] {
  if (
    !exactRecord(value, [
      "completionClaim",
      "deliverables",
      "outputs",
      "verificationNotes",
      "knownGaps",
      "residualRisks",
      "commitSha",
    ])
  )
    return [
      [
        "SubmissionV1 requires exactly: completionClaim, deliverables, outputs, ",
        "verificationNotes, knownGaps, residualRisks, commitSha",
      ].join(""),
    ];
  const errors: string[] = [];
  if (!nonEmpty(value.completionClaim)) errors.push("completionClaim must be a non-empty string");
  for (const field of ["deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks"] as const)
    if (!stringArray(value[field])) errors.push(`${field} must be an array of non-empty strings`);
  if (!sha(value.commitSha)) errors.push("commitSha must be a native 40-character commit SHA");
  return errors;
}

// longRunning predates taskClass=long_running (dec_01KYRHP8ND); historical event payloads may
// still carry the retired boolean, so the wire validator tolerates it on read. Writers never emit it.
export function validTaskMetadata(value: unknown): boolean {
  const nullable = (item: unknown) => item === null || nonEmpty(item),
    fields = [
      "idempotencyKey",
      "parentTaskId",
      "workKind",
      "riskTier",
      "urgency",
      "verticalId",
      "presetId",
      "profileId",
      "moduleKey",
      "slug",
      "surfaces",
      "fromLegacyId",
    ];
  return (
    recordWith(value, fields) &&
    Object.keys(value).every((field) => fields.includes(field) || field === "longRunning") &&
    (value.longRunning === undefined || typeof value.longRunning === "boolean") &&
    [value.idempotencyKey, value.parentTaskId, value.moduleKey, value.fromLegacyId].every(nullable) &&
    (value.workKind === null ||
      ["feat", "fix", "refactor", "docs", "test", "chore"].includes(String(value.workKind))) &&
    [value.riskTier, value.urgency].every(
      (item) => item === null || ["low", "medium", "high"].includes(String(item)),
    ) &&
    [value.verticalId, value.presetId, value.profileId].every(nonEmpty) &&
    /^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$/u.test(String(value.slug)) &&
    stringArray(value.surfaces)
  );
}

export function taskRelation(value: unknown, taskId: string): boolean {
  return (
    exactRecord(value, [
      "relation_id",
      "source",
      "target",
      "type",
      "strength",
      "direction",
      "origin",
      "rationale",
      "state",
    ]) &&
    /^rel_[0-9a-f]{16}$/u.test(String(value.relation_id)) &&
    value.source === `task/${taskId}` &&
    [value.target, value.rationale].every(nonEmpty) &&
    [
      "supports",
      "supersedes",
      "refines",
      "narrows",
      "derives",
      "blocks",
      "relates",
      "implements",
      "depends-on",
      "produces",
      "evidences",
      "evidenced-by",
      "refuted-by",
      "invalidated-by",
      "supersedes-fact",
    ].includes(String(value.type)) &&
    ["strong", "weak"].includes(String(value.strength)) &&
    ["directed", "undirected"].includes(String(value.direction)) &&
    ["declared", "imported_snapshot", "generated", "inferred"].includes(String(value.origin)) &&
    statusWord(relationStateWords, value.state)
  );
}

export function task(value: unknown): boolean {
  const required = [
      "schema",
      "taskId",
      "title",
      "taskClass",
      "status",
      "graph",
      "currentNode",
      "iteration",
      "createdBy",
      "completionGateIds",
      "presetSnapshotDigest",
    ],
    optional = [
      "provenance",
      "pinned",
      "metadata",
      "relations",
      "packageDisposition",
      "supersededBy",
      "contractVersion",
    ];
  return (
    recordWith(value, required) &&
    Object.keys(value).every((field) => required.includes(field) || optional.includes(field)) &&
    value.schema === "task/v1" &&
    [value.taskId, value.title].every(nonEmpty) &&
    ["standard", "milestone", "epic", "long_running"].includes(String(value.taskClass)) &&
    statusWord(taskStatusWords, value.status) &&
    ["implementation", "review"].includes(String(value.currentNode)) &&
    iteration(value.iteration) &&
    actor(value.createdBy) &&
    stringArray(value.completionGateIds) &&
    (value.presetSnapshotDigest === null || digest(value.presetSnapshotDigest)) &&
    (value.provenance === undefined ||
      (Array.isArray(value.provenance) && value.provenance.length > 0 && value.provenance.every(sessionProvenance))) &&
    (value.pinned === undefined || typeof value.pinned === "boolean") &&
    isJsonObject(value.graph) &&
    (value.metadata === undefined || validTaskMetadata(value.metadata)) &&
    (value.relations === undefined ||
      (Array.isArray(value.relations) &&
        value.relations.every((relation) => taskRelation(relation, String(value.taskId))))) &&
    (value.packageDisposition === undefined || statusWord(packageDispositionWords, value.packageDisposition)) &&
    (value.supersededBy === undefined || value.supersededBy === null || nonEmpty(value.supersededBy)) &&
    (value.contractVersion === undefined || (integer(value.contractVersion) && Number(value.contractVersion) > 0))
  );
}

export function execution(value: unknown): boolean {
  if (
    exactRecord(value, [
      "schema",
      "executionId",
      "taskId",
      "nodeId",
      "iteration",
      "state",
      "actor",
      "claimedAt",
      "submittedAt",
      "closedAt",
      "submission",
    ])
  )
    return (
      value.schema === "execution/v1" &&
      [value.executionId, value.taskId, value.claimedAt].every(nonEmpty) &&
      value.nodeId === "implementation" &&
      iteration(value.iteration) &&
      statusWord(executionV1StateWords, value.state) &&
      actor(value.actor) &&
      (value.submittedAt === null || nonEmpty(value.submittedAt)) &&
      (value.closedAt === null || nonEmpty(value.closedAt)) &&
      (value.submission === null || validateGuiSubmission(value.submission).length === 0)
    );
  const fields = [
    "schema",
    "generation",
    "migratedFrom",
    "executionId",
    "taskId",
    "nodeId",
    "iteration",
    "state",
    "actor",
    "claimedAt",
    "submittedAt",
    "closedAt",
    "sessionBindings",
    "outputs",
    "submission",
    "archivedSubmission",
  ];
  return (
    exactRecord(value, fields) &&
    value.schema === "archived-execution/v1" &&
    value.generation === "v0" &&
    [value.migratedFrom, value.executionId, value.taskId, value.claimedAt].every(nonEmpty) &&
    value.nodeId === "implementation" &&
    iteration(value.iteration) &&
    statusWord(executionStateWords, value.state) &&
    actor(value.actor) &&
    (value.submittedAt === null || nonEmpty(value.submittedAt)) &&
    (value.closedAt === null || nonEmpty(value.closedAt)) &&
    Array.isArray(value.sessionBindings) &&
    Array.isArray(value.outputs) &&
    value.outputs.every(
      (output) =>
        exactRecord(output, ["migratedFrom", "locator", "substrate", "checkerReceiptRef", "checkerResult"]) &&
        [output.migratedFrom, output.locator].every(nonEmpty),
    ) &&
    value.submission === null &&
    (value.archivedSubmission === null ||
      exactRecord(value.archivedSubmission, [
        "completionClaim",
        "deliverables",
        "evidenceRefs",
        "verificationNotes",
        "knownGaps",
        "residualRisks",
      ]))
  );
}

export const reviewAuthorityRefKey = "capab" + "ilityRef";

export function review(value: unknown): boolean {
  return (
    exactRecord(value, [
      "schema",
      "reviewId",
      "taskId",
      "executionId",
      "verdict",
      "actor",
      reviewAuthorityRefKey,
      "reason",
      "evidenceChecked",
      "commitSha",
      "iteration",
      "contentDigest",
      "reviewedAt",
    ]) &&
    value.schema === "review/v1" &&
    [
      value.reviewId,
      value.taskId,
      value.executionId,
      value[reviewAuthorityRefKey],
      value.reason,
      value.reviewedAt,
    ].every(nonEmpty) &&
    statusWord(reviewVerdictWords, value.verdict) &&
    actor(value.actor) &&
    stringArray(value.evidenceChecked) &&
    sha(value.commitSha) &&
    iteration(value.iteration) &&
    digest(value.contentDigest)
  );
}

export function consent(value: unknown): boolean {
  return (
    exactRecord(value, [
      "schema",
      "consentId",
      "taskId",
      "executionId",
      "reviewId",
      "reviewDigest",
      "contentDigest",
      "actor",
      "source",
      "consentedAt",
    ]) &&
    value.schema === "review-consent/v1" &&
    [value.consentId, value.taskId, value.executionId, value.reviewId, value.consentedAt].every(nonEmpty) &&
    digest(value.reviewDigest) &&
    digest(value.contentDigest) &&
    actor(value.actor) &&
    source(value.source)
  );
}

export function codeDoc(value: unknown): boolean {
  return (
    exactRecord(value, [
      "schema",
      "witnessId",
      "taskId",
      "executionId",
      "commitSha",
      "iteration",
      "paths",
      "actor",
      "source",
      "reconciledAt",
    ]) &&
    value.schema === "code-doc-witness/v1" &&
    [value.witnessId, value.taskId, value.executionId, value.reconciledAt].every(nonEmpty) &&
    sha(value.commitSha) &&
    iteration(value.iteration) &&
    stringArray(value.paths) &&
    value.paths.length > 0 &&
    actor(value.actor) &&
    source(value.source)
  );
}

export function gate(value: unknown): boolean {
  return (
    exactRecord(value, [
      "schema",
      "witnessId",
      "receiptId",
      "checkerId",
      "gateId",
      "result",
      "taskId",
      "executionId",
      "commitSha",
      "iteration",
      "actor",
      "source",
      "verifiedAt",
    ]) &&
    value.schema === "completion-gate-witness/v1" &&
    [
      value.witnessId,
      value.receiptId,
      value.checkerId,
      value.gateId,
      value.taskId,
      value.executionId,
      value.verifiedAt,
    ].every(nonEmpty) &&
    value.result === "pass" &&
    sha(value.commitSha) &&
    iteration(value.iteration) &&
    actor(value.actor) &&
    source(value.source)
  );
}

export function lease(value: unknown): boolean {
  return (
    exactRecord(value, [
      "schema",
      "taskId",
      "executionId",
      "actor",
      "source",
      "phase",
      "expiresAt",
      "ttlMs",
      "version",
    ]) &&
    value.schema === "lease/v1" &&
    [value.taskId, value.executionId, value.expiresAt].every(nonEmpty) &&
    actor(value.actor) &&
    source(value.source) &&
    statusWord(leasePhaseWords, value.phase) &&
    integer(value.ttlMs) &&
    Number(value.ttlMs) > 0 &&
    integer(value.version) &&
    Number(value.version) >= 0
  );
}
