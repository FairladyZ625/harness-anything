import { inspect } from "node:util";
import {
  executionStateWords,
  executionV1StateWords,
  leasePhaseWords,
  packageDispositionWords,
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

const validationValueLimit = 120;

export function validationValueSummary(value: unknown): string {
  const rendered = inspect(value, {
    breakLength: Infinity,
    compact: true,
    depth: 3,
    maxArrayLength: 20,
    maxStringLength: 100,
  });
  const characters = [...rendered];
  return characters.length <= validationValueLimit
    ? rendered
    : `${characters.slice(0, validationValueLimit - 1).join("")}…`;
}

export function validationError(entityId: string, field: string, actual: unknown, expectation: string): string {
  return (
    `entity=${validationValueSummary(entityId)} field=${field} ${expectation}; ` +
    `actual=${validationValueSummary(actual)}`
  );
}

export function validationDiagnostic(hint: string) {
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

export function validationEntityId(value: unknown, fields: readonly string[], fallback: string): string {
  if (isJsonObject(value)) {
    for (const field of fields) if (nonEmpty(value[field])) return value[field];
  }
  return fallback;
}

export function recordShapeError(
  entityId: string,
  value: unknown,
  required: readonly string[],
  allowed: readonly string[] = required,
  prefix = "",
): string | null {
  const root = prefix || "$";
  if (!isJsonObject(value)) return validationError(entityId, root, value, "must be an object");
  const missing = required.find((field) => !Object.hasOwn(value, field));
  if (missing) return validationError(entityId, joinValidationPath(prefix, missing), undefined, "field is required");
  const unknown = Object.keys(value).find((field) => !allowed.includes(field));
  return unknown
    ? validationError(entityId, joinValidationPath(prefix, unknown), value[unknown], "field is not declared")
    : null;
}

export function validationValueAtPath(value: unknown, field: string): unknown {
  let current = value;
  for (const segment of field.match(/[^.[\]]+/gu) ?? []) {
    if (!isJsonObject(current) && !Array.isArray(current)) return undefined;
    current = (current as unknown as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
}

function joinValidationPath(prefix: string, field: string): string {
  return prefix ? `${prefix}.${field}` : field;
}

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
  const fields = [
      "completionClaim",
      "deliverables",
      "outputs",
      "verificationNotes",
      "knownGaps",
      "residualRisks",
      "commitSha",
    ],
    entityId = validationEntityId(value, ["commitSha"], "submission:<unknown>"),
    shapeError = recordShapeError(entityId, value, fields);
  if (shapeError) return [shapeError];
  if (!isJsonObject(value)) return [];
  const errors: string[] = [];
  if (!nonEmpty(value.completionClaim))
    errors.push(validationError(entityId, "completionClaim", value.completionClaim, "must be a non-empty string"));
  for (const field of ["deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks"] as const)
    if (!stringArray(value[field]))
      errors.push(validationError(entityId, field, value[field], "must be an array of non-empty strings"));
  if (!sha(value.commitSha))
    errors.push(validationError(entityId, "commitSha", value.commitSha, "must be a native 40-character commit SHA"));
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
      "pinned",
    ],
    optional = ["provenance", "metadata", "packageDisposition", "supersededBy", "contractVersion"];
  return (
    recordWith(value, required) &&
    Object.keys(value).every((field) => required.includes(field) || optional.includes(field)) &&
    value.schema === "task/v2" &&
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
    typeof value.pinned === "boolean" &&
    isJsonObject(value.graph) &&
    (value.metadata === undefined || validTaskMetadata(value.metadata)) &&
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
  const fields = [
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
  ];
  return (
    (exactRecord(value, fields) || exactRecord(value, [...fields, "submissionDigest"])) &&
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
    digest(value.contentDigest) &&
    (value.submissionDigest === undefined || digest(value.submissionDigest))
  );
}

export function consent(value: unknown): boolean {
  const fields = [
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
  ];
  return (
    (exactRecord(value, fields) || exactRecord(value, [...fields, "submissionDigest"])) &&
    value.schema === "review-consent/v1" &&
    [value.consentId, value.taskId, value.executionId, value.reviewId, value.consentedAt].every(nonEmpty) &&
    digest(value.reviewDigest) &&
    digest(value.contentDigest) &&
    (value.submissionDigest === undefined || digest(value.submissionDigest)) &&
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
    actor(value.actor) &&
    source(value.source)
  );
}

export function codeDocRepoint(value: unknown): boolean {
  return (
    exactRecord(value, [
      "schema",
      "recordId",
      "supersedes",
      "taskId",
      "executionId",
      "commitSha",
      "iteration",
      "paths",
      "disposition",
      "reason",
      "actor",
      "source",
      "repointedAt",
    ]) &&
    value.schema === "code-doc-witness-repoint/v1" &&
    [value.recordId, value.supersedes, value.taskId, value.executionId, value.reason, value.repointedAt].every(
      nonEmpty,
    ) &&
    sha(value.commitSha) &&
    iteration(value.iteration) &&
    stringArray(value.paths) &&
    ((value.disposition === "repointed" && value.paths.length > 0) ||
      (value.disposition === "known-invalid" && value.paths.length === 0)) &&
    actor(value.actor) &&
    source(value.source)
  );
}

export const codeDocRecord = (value: unknown): boolean => codeDoc(value) || codeDocRepoint(value);

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

// Wire validation deliberately owns no kernel runtime dependency. The differential
// receipt tests keep its SQLite acceptance contract aligned with the domain validator.
const wireWaitPredicates = [
  "accepted_durable",
  "projection_visible",
  "git_verified",
  "worktree_visible",
  "replica_verified",
] as const;
const wireText = (value: unknown): value is string => nonEmpty(value) && value.trim().length > 0;
const wireRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function wireConsumerCut(value: unknown): value is JsonObject {
  return (
    exactRecord(value, ["repoId", "generation", "revision", "headDigest"]) &&
    wireText(value.repoId) &&
    value.generation === 1 &&
    wireRevision(value.revision) &&
    digest(value.headDigest)
  );
}
export function wireUnmetCriterion(value: unknown): boolean {
  return (
    exactRecord(value, ["ref", "failureCode", "explain"]) &&
    wireText(value.ref) &&
    wireText(value.failureCode) &&
    wireText(value.explain)
  );
}
function wireAuthorizationActor(value: unknown): boolean {
  return (
    exactRecord(value, ["principal", "executor"]) &&
    exactRecord(value.principal, ["personId"]) &&
    wireText(value.principal.personId) &&
    (value.executor === null ||
      (exactRecord(value.executor, ["kind", "id"]) && value.executor.kind === "agent" && wireText(value.executor.id)))
  );
}
// Exactly the built-in ref candidates emitted by repo-cell-authorization actionTarget.
// It constructs kind/id locally: external harness aliases and artifact refs cannot occur here.
function squadControlSubject(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    value === "settings/repository" ||
    /^task\/(?:task_[A-Za-z0-9_-]+|[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9_-]+)$/u.test(value) ||
    /^decision\/(?:dec_[A-Za-z0-9_-]+|[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)?$/u.test(
      value,
    ) ||
    /^fact\/F-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value) ||
    /^execution\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value) ||
    /^(?:schedule|agent|squad)\/[a-z0-9][a-z0-9-]{0,63}$/u.test(value)
  );
}
export function validSquadControlAuthorization(value: unknown): boolean {
  if (
    !exactRecord(value, [
      "policyRef",
      "actor",
      "subject",
      "bindingsUsed",
      "outcome",
      "reasonCodes",
      "nextActions",
      "evaluatedAtCut",
    ])
  )
    return false;
  const denied = value.outcome === "denied";
  return (
    /^\S+@[1-9][0-9]*$/u.test(String(value.policyRef)) &&
    wireAuthorizationActor(value.actor) &&
    squadControlSubject(value.subject) &&
    Array.isArray(value.bindingsUsed) &&
    value.bindingsUsed.every(isJsonObject) &&
    (value.outcome === "allowed" || denied) &&
    Array.isArray(value.reasonCodes) &&
    value.reasonCodes.every(wireText) &&
    Array.isArray(value.nextActions) &&
    value.nextActions.every(wireText) &&
    (!denied || (value.reasonCodes.length > 0 && value.nextActions.length > 0)) &&
    wireText(value.evaluatedAtCut)
  );
}

export function validateReceiptAcceptanceWire(value: Readonly<Record<string, unknown>>): readonly string[] {
  const errors: string[] = [];
  const status = String(value.status),
    known = ["accepted_durable", "rejected", "unknown"].includes(status),
    accepted = status === "accepted_durable";
  if (!known) errors.push("receipt status is invalid");
  if (accepted) {
    const a = value.acceptance;
    if (
      !isJsonObject(a) ||
      !exactRecord(a, ["storage", "durability", "recordedAt", "revisionFrom", "revisionTo", "memberOpIds", "cut"]) ||
      a.storage !== "sqlite" ||
      a.durability !== "local_fsync" ||
      !wireText(a.recordedAt) ||
      !Number.isFinite(Date.parse(a.recordedAt)) ||
      !wireRevision(a.revisionFrom) ||
      a.revisionFrom < 1 ||
      !wireRevision(a.revisionTo) ||
      a.revisionTo < a.revisionFrom ||
      !wireConsumerCut(a.cut) ||
      a.cut.revision !== a.revisionTo ||
      !Array.isArray(a.memberOpIds) ||
      a.memberOpIds.length !== a.revisionTo - a.revisionFrom + 1 ||
      !a.memberOpIds.every(wireText) ||
      new Set(a.memberOpIds).size !== a.memberOpIds.length ||
      typeof value.opId !== "string" ||
      !a.memberOpIds.includes(value.opId)
    )
      errors.push("accepted_durable requires a committed acceptance interval");
  } else if (value.acceptance !== null) errors.push("unaccepted receipt requires acceptance:null");
  for (const name of ["projection", "git", "worktree", "replica"] as const) {
    const facet = value[name],
      fields = ["state", "cut", ...(name === "git" ? ["commitSha"] : [])];
    if (
      !isJsonObject(facet) ||
      !exactRecord(facet, [...fields, ...("reason" in facet ? ["reason"] : [])]) ||
      !["pending", "verified", ...(name === "replica" ? ["not_configured"] : [])].includes(String(facet.state)) ||
      (facet.state === "verified" ? !wireConsumerCut(facet.cut) : facet.cut !== null) ||
      ("reason" in facet && !wireText(facet.reason)) ||
      (name === "git" &&
        (facet.state === "verified"
          ? typeof facet.commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(facet.commitSha)
          : facet.commitSha !== null))
    )
      errors.push(`${name} must report an independent verified cut or pending state`);
  }
  if (value.outcome === "applied" && !accepted) errors.push("applied requires accepted_durable");
  if (
    "wait" in value &&
    (!isJsonObject(value.wait) ||
      !exactRecord(value.wait, ["state", "unsatisfied"]) ||
      !["satisfied", "timed_out"].includes(String(value.wait.state)) ||
      !Array.isArray(value.wait.unsatisfied) ||
      !value.wait.unsatisfied.every((item) => (wireWaitPredicates as readonly unknown[]).includes(item)) ||
      (value.wait.state === "satisfied") !== (value.wait.unsatisfied.length === 0))
  )
    errors.push("receipt wait result is invalid");
  return errors;
}
