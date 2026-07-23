import {
  isCompleteAuthorityCommittedReceiptV2,
  type AuthorityCommittedReceipt,
  type AuthorityOperationReceipt,
  type AuthorityRejectedReceipt,
  type AuthorityRetryableReceipt,
  type DaemonGenerationWriteRejectionV1
} from "@harness-anything/application";
import { stablePayloadHash } from "@harness-anything/kernel";
import { RepoWriteOutcomeValidationError } from "./repo-write-outcome-errors.ts";
import {
  repoWriteJsonBudget,
  repoWriteJsonObjectAt
} from "./repo-write-json-budget.ts";

export const repoWriteTerminalProofSchema = "repo-write-terminal-proof/v1" as const;
const evidenceDigestSchema = "repo-write-authority-evidence-digest/v1" as const;
const digestPattern = /^[a-f0-9]{64}$/u;
const maximumMutationItems = 16_384;

export type RepoWriteTerminalEvidenceV1 =
  | AuthorityCommittedReceipt
  | AuthorityRejectedReceipt
  | AuthorityRetryableReceipt;

export interface RepoWriteTerminalProofV1 {
  readonly schema: typeof repoWriteTerminalProofSchema;
  readonly disposition: "committed" | "rejected";
  readonly evidence: RepoWriteTerminalEvidenceV1;
  readonly evidenceDigest: string;
}

export function createRepoWriteTerminalProofV1(
  evidence: AuthorityOperationReceipt
): RepoWriteTerminalProofV1 {
  const normalized = decodeAuthorityTerminalEvidenceV1(evidence, "$.evidence");
  return {
    schema: repoWriteTerminalProofSchema,
    disposition: normalized.tag === "COMMITTED" ? "committed" : "rejected",
    evidence: normalized,
    evidenceDigest: repoWriteTerminalProofEvidenceDigest(normalized)
  };
}

export function decodeRepoWriteTerminalProofV1(
  value: unknown,
  path = "$"
): RepoWriteTerminalProofV1 {
  repoWriteJsonObjectAt(value, path, repoWriteJsonBudget(), 0);
  const record = repoWriteTerminalProofRecordAt(value, path);
  repoWriteTerminalProofExactKeys(
    record,
    ["schema", "disposition", "evidence", "evidenceDigest"],
    path
  );
  if (record.schema !== repoWriteTerminalProofSchema) {
    repoWriteTerminalProofInvalid(`${path}.schema`, repoWriteTerminalProofSchema);
  }
  const evidence = decodeAuthorityTerminalEvidenceV1(record.evidence, `${path}.evidence`);
  const disposition = evidence.tag === "COMMITTED" ? "committed" : "rejected";
  if (record.disposition !== disposition) {
    repoWriteTerminalProofInvalid(
      `${path}.disposition`,
      "classification derived from authority evidence"
    );
  }
  const evidenceDigest = repoWriteTerminalProofDigestAt(
    record.evidenceDigest,
    `${path}.evidenceDigest`
  );
  if (evidenceDigest !== repoWriteTerminalProofEvidenceDigest(evidence)) {
    repoWriteTerminalProofInvalid(
      `${path}.evidenceDigest`,
      "store-derived digest of exact authority evidence"
    );
  }
  return {
    schema: repoWriteTerminalProofSchema,
    disposition,
    evidence,
    evidenceDigest
  };
}

export function decodeAuthorityTerminalEvidenceV1(
  value: unknown,
  path = "$"
): RepoWriteTerminalEvidenceV1 {
  repoWriteJsonObjectAt(value, path, repoWriteJsonBudget(), 0);
  const record = repoWriteTerminalProofRecordAt(value, path);
  const tag = record.tag;
  if (tag === "COMMITTED") return repoWriteTerminalProofCommittedEvidenceAt(record, path);
  if (tag === "REJECTED") return repoWriteTerminalProofRejectedEvidenceAt(record, path);
  if (tag === "RETRYABLE_NOT_COMMITTED") {
    return repoWriteTerminalProofRetryableEvidenceAt(record, path);
  }
  repoWriteTerminalProofInvalid(
    `${path}.tag`,
    "COMMITTED, REJECTED, or RETRYABLE_NOT_COMMITTED"
  );
}

function repoWriteTerminalProofCommittedEvidenceAt(
  record: Record<string, unknown>,
  path: string
): AuthorityCommittedReceipt {
  repoWriteTerminalProofExactKeys(record, [
    "tag", "workspaceId", "opId", "semanticDigest", "revision", "commitSha",
    "previousCommit", "authorityIntegrity", "integrityTuple"
  ], path);
  const authorityIntegrity = repoWriteTerminalProofAuthorityIntegrityAt(
    record.authorityIntegrity,
    `${path}.authorityIntegrity`
  );
  const integrityTuple = repoWriteTerminalProofIntegrityTupleAt(
    record.integrityTuple,
    `${path}.integrityTuple`
  );
  const receipt: AuthorityCommittedReceipt = {
    tag: "COMMITTED",
    workspaceId: repoWriteTerminalProofIdentifierAt(record.workspaceId, `${path}.workspaceId`),
    opId: repoWriteTerminalProofIdentifierAt(record.opId, `${path}.opId`),
    semanticDigest: repoWriteTerminalProofDigestAt(
      record.semanticDigest,
      `${path}.semanticDigest`
    ),
    revision: repoWriteTerminalProofUintAt(record.revision, `${path}.revision`),
    commitSha: repoWriteTerminalProofIdentifierAt(record.commitSha, `${path}.commitSha`),
    previousCommit: record.previousCommit === null
      ? null
      : repoWriteTerminalProofIdentifierAt(record.previousCommit, `${path}.previousCommit`),
    authorityIntegrity,
    integrityTuple
  };
  if (!isCompleteAuthorityCommittedReceiptV2(receipt)) {
    repoWriteTerminalProofInvalid(path, "complete V2 COMMITTED integrity tuple");
  }
  return receipt;
}

function repoWriteTerminalProofRejectedEvidenceAt(
  record: Record<string, unknown>,
  path: string
): AuthorityRejectedReceipt {
  repoWriteTerminalProofExactKeys(
    record,
    ["tag", "workspaceId", "opId", "semanticDigest", "reason"],
    path
  );
  return {
    tag: "REJECTED",
    workspaceId: repoWriteTerminalProofIdentifierAt(record.workspaceId, `${path}.workspaceId`),
    opId: repoWriteTerminalProofIdentifierAt(record.opId, `${path}.opId`),
    semanticDigest: repoWriteTerminalProofDigestAt(
      record.semanticDigest,
      `${path}.semanticDigest`
    ),
    reason: repoWriteTerminalProofJsonTextAt(record.reason, `${path}.reason`)
  };
}

function repoWriteTerminalProofRetryableEvidenceAt(
  record: Record<string, unknown>,
  path: string
): AuthorityRetryableReceipt {
  repoWriteTerminalProofExactKeys(
    record,
    ["tag", "workspaceId", "opId", "semanticDigest", "reason"],
    path,
    ["errorCode", "errorContext"]
  );
  const common = {
    tag: "RETRYABLE_NOT_COMMITTED" as const,
    workspaceId: repoWriteTerminalProofIdentifierAt(record.workspaceId, `${path}.workspaceId`),
    opId: repoWriteTerminalProofIdentifierAt(record.opId, `${path}.opId`),
    semanticDigest: repoWriteTerminalProofDigestAt(
      record.semanticDigest,
      `${path}.semanticDigest`
    ),
    reason: repoWriteTerminalProofJsonTextAt(record.reason, `${path}.reason`)
  };
  if (record.errorCode === undefined && record.errorContext === undefined) return common;
  if (record.errorCode !== "DAEMON_GENERATION_FENCED") {
    repoWriteTerminalProofInvalid(`${path}.errorCode`, "DAEMON_GENERATION_FENCED");
  }
  const errorContext = repoWriteTerminalProofGenerationRejectionAt(
    record.errorContext,
    `${path}.errorContext`
  );
  if (errorContext.workspaceId !== common.workspaceId
    || (errorContext.opId !== undefined && errorContext.opId !== common.opId)) {
    repoWriteTerminalProofInvalid(
      `${path}.errorContext`,
      "generation rejection bound to authority workspaceId/opId"
    );
  }
  return {
    ...common,
    errorCode: "DAEMON_GENERATION_FENCED",
    errorContext
  };
}

function repoWriteTerminalProofAuthorityIntegrityAt(value: unknown, path: string) {
  const record = repoWriteTerminalProofRecordAt(value, path);
  repoWriteTerminalProofExactKeys(record, [
    "schema", "semanticRequestDigest", "semanticMutationSetDigest",
    "mutationRegistryVersion", "actorAxesBindingDigest", "canonicalMutationSet"
  ], path);
  if (record.schema !== "authority-operation-integrity/v2") {
    repoWriteTerminalProofInvalid(`${path}.schema`, "authority-operation-integrity/v2");
  }
  const mutationSet = repoWriteTerminalProofRecordAt(
    record.canonicalMutationSet,
    `${path}.canonicalMutationSet`
  );
  repoWriteTerminalProofExactKeys(
    mutationSet,
    ["registryVersion", "mutations"],
    `${path}.canonicalMutationSet`
  );
  if (!Array.isArray(mutationSet.mutations) || mutationSet.mutations.length > maximumMutationItems) {
    repoWriteTerminalProofInvalid(
      `${path}.canonicalMutationSet.mutations`,
      "bounded mutation array"
    );
  }
  return {
    schema: "authority-operation-integrity/v2" as const,
    semanticRequestDigest: repoWriteTerminalProofDigestAt(
      record.semanticRequestDigest,
      `${path}.semanticRequestDigest`
    ),
    semanticMutationSetDigest: repoWriteTerminalProofDigestAt(
      record.semanticMutationSetDigest,
      `${path}.semanticMutationSetDigest`
    ),
    mutationRegistryVersion: repoWriteTerminalProofRegistryUintAt(
      record.mutationRegistryVersion,
      `${path}.mutationRegistryVersion`
    ),
    actorAxesBindingDigest: repoWriteTerminalProofDigestAt(
      record.actorAxesBindingDigest,
      `${path}.actorAxesBindingDigest`
    ),
    canonicalMutationSet: {
      registryVersion: repoWriteTerminalProofRegistryUintAt(
        mutationSet.registryVersion,
        `${path}.canonicalMutationSet.registryVersion`
      ),
      mutations: mutationSet.mutations.map((entry, index) =>
        repoWriteTerminalProofMutationAt(
          entry,
          `${path}.canonicalMutationSet.mutations[${index}]`
        ))
    }
  };
}

function repoWriteTerminalProofMutationAt(value: unknown, path: string) {
  const record = repoWriteTerminalProofRecordAt(value, path);
  repoWriteTerminalProofExactKeys(record, ["entity", "action"], path);
  const entity = repoWriteTerminalProofRecordAt(record.entity, `${path}.entity`);
  const action = repoWriteTerminalProofRecordAt(record.action, `${path}.action`);
  repoWriteTerminalProofExactKeys(
    entity,
    ["registryVersion", "entityKind", "canonicalRef"],
    `${path}.entity`
  );
  repoWriteTerminalProofExactKeys(
    action,
    ["registryVersion", "action"],
    `${path}.action`
  );
  return {
    entity: {
      registryVersion: repoWriteTerminalProofRegistryUintAt(
        entity.registryVersion,
        `${path}.entity.registryVersion`
      ),
      entityKind: repoWriteTerminalProofIdentifierAt(
        entity.entityKind,
        `${path}.entity.entityKind`
      ),
      canonicalRef: repoWriteTerminalProofIdentifierAt(
        entity.canonicalRef,
        `${path}.entity.canonicalRef`
      )
    },
    action: {
      registryVersion: repoWriteTerminalProofRegistryUintAt(
        action.registryVersion,
        `${path}.action.registryVersion`
      ),
      action: repoWriteTerminalProofIdentifierAt(action.action, `${path}.action.action`)
    }
  };
}

function repoWriteTerminalProofIntegrityTupleAt(value: unknown, path: string) {
  const record = repoWriteTerminalProofRecordAt(value, path);
  repoWriteTerminalProofExactKeys(record, [
    "schema", "canonicalEventDigest", "changeSetDigest",
    "semanticMutationSetDigest", "actorAxesBindingDigest"
  ], path);
  if (record.schema !== "authority-integrity-tuple/v2") {
    repoWriteTerminalProofInvalid(`${path}.schema`, "authority-integrity-tuple/v2");
  }
  return {
    schema: "authority-integrity-tuple/v2" as const,
    canonicalEventDigest: repoWriteTerminalProofDigestAt(
      record.canonicalEventDigest,
      `${path}.canonicalEventDigest`
    ),
    changeSetDigest: repoWriteTerminalProofDigestAt(
      record.changeSetDigest,
      `${path}.changeSetDigest`
    ),
    semanticMutationSetDigest: repoWriteTerminalProofDigestAt(
      record.semanticMutationSetDigest,
      `${path}.semanticMutationSetDigest`
    ),
    actorAxesBindingDigest: repoWriteTerminalProofDigestAt(
      record.actorAxesBindingDigest,
      `${path}.actorAxesBindingDigest`
    )
  };
}

function repoWriteTerminalProofGenerationRejectionAt(
  value: unknown,
  path: string
): DaemonGenerationWriteRejectionV1 {
  const record = repoWriteTerminalProofRecordAt(value, path);
  repoWriteTerminalProofExactKeys(record, [
    "schema", "machineId", "attemptedDaemonGeneration", "workspaceId", "stage"
  ], path, ["currentDaemonGeneration", "runtimeRegistrationId", "connectionId", "opId"]);
  if (record.schema !== "daemon-generation-write-rejection/v1") {
    repoWriteTerminalProofInvalid(`${path}.schema`, "daemon-generation-write-rejection/v1");
  }
  const stages = new Set([
    "before-prepare", "before-canonical-publish", "after-canonical-publish",
    "before-terminal-visibility", "before-terminal-journal"
  ]);
  if (typeof record.stage !== "string" || !stages.has(record.stage)) {
    repoWriteTerminalProofInvalid(`${path}.stage`, "authority fence stage");
  }
  return {
    schema: "daemon-generation-write-rejection/v1" as const,
    machineId: repoWriteTerminalProofIdentifierAt(record.machineId, `${path}.machineId`),
    attemptedDaemonGeneration: repoWriteTerminalProofPositiveIntegerAt(
      record.attemptedDaemonGeneration,
      `${path}.attemptedDaemonGeneration`
    ),
    ...(record.currentDaemonGeneration === undefined ? {} : {
      currentDaemonGeneration: repoWriteTerminalProofPositiveIntegerAt(
        record.currentDaemonGeneration,
        `${path}.currentDaemonGeneration`
      )
    }),
    ...(record.runtimeRegistrationId === undefined ? {} : {
      runtimeRegistrationId: repoWriteTerminalProofIdentifierAt(
        record.runtimeRegistrationId,
        `${path}.runtimeRegistrationId`
      )
    }),
    ...(record.connectionId === undefined ? {} : {
      connectionId: repoWriteTerminalProofIdentifierAt(
        record.connectionId,
        `${path}.connectionId`
      )
    }),
    workspaceId: repoWriteTerminalProofIdentifierAt(record.workspaceId, `${path}.workspaceId`),
    ...(record.opId === undefined
      ? {}
      : { opId: repoWriteTerminalProofIdentifierAt(record.opId, `${path}.opId`) }),
    stage: record.stage as DaemonGenerationWriteRejectionV1["stage"]
  };
}

function repoWriteTerminalProofEvidenceDigest(
  evidence: RepoWriteTerminalEvidenceV1
): string {
  return stablePayloadHash({ schema: evidenceDigestSchema, evidence });
}

function repoWriteTerminalProofRecordAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    repoWriteTerminalProofInvalid(path, "plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    repoWriteTerminalProofInvalid(path, "plain object");
  }
  return value as Record<string, unknown>;
}

function repoWriteTerminalProofExactKeys(
  record: Record<string, unknown>,
  required: ReadonlyArray<string>,
  path: string,
  optional: ReadonlyArray<string> = []
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !allowed.has(key))) {
    repoWriteTerminalProofInvalid(path, "exact authority evidence fields");
  }
}

function repoWriteTerminalProofIdentifierAt(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()
    || Buffer.byteLength(value, "utf8") > 4_096
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    repoWriteTerminalProofInvalid(path, "non-empty bounded identifier");
  }
  return value;
}

function repoWriteTerminalProofJsonTextAt(value: unknown, path: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256 * 1024) {
    repoWriteTerminalProofInvalid(path, "bounded JSON string");
  }
  return value;
}

function repoWriteTerminalProofDigestAt(value: unknown, path: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    repoWriteTerminalProofInvalid(path, "lowercase SHA-256 digest");
  }
  return value;
}

function repoWriteTerminalProofUintAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    repoWriteTerminalProofInvalid(path, "non-negative safe integer");
  }
  return value;
}

function repoWriteTerminalProofPositiveIntegerAt(value: unknown, path: string): number {
  const result = repoWriteTerminalProofUintAt(value, path);
  if (result < 1) repoWriteTerminalProofInvalid(path, "positive safe integer");
  return result;
}

function repoWriteTerminalProofRegistryUintAt(value: unknown, path: string): number {
  const result = repoWriteTerminalProofUintAt(value, path);
  if (result > 0xffff_ffff) {
    repoWriteTerminalProofInvalid(path, "unsigned 32-bit integer");
  }
  return result;
}

function repoWriteTerminalProofInvalid(path: string, expected: string): never {
  throw new RepoWriteOutcomeValidationError(
    `Invalid repo-write-terminal-proof/v1 at ${path.slice(0, 160)}: expected ${expected}.`
  );
}
