import type { CommandReceiptEnvelope } from "@harness-anything/application";
import { stablePayloadHash, stableStringify } from "@harness-anything/kernel";
import type {
  RepoWriteCommandDto,
  RepoWriteJsonObject
} from "./repo-write-protocol.ts";
import { decodeRepoWriteCommandReceiptV2 } from "./repo-write-command-receipt.ts";
import { RepoWriteOutcomeValidationError } from "./repo-write-outcome-errors.ts";
import {
  repoWriteJsonBudget as jsonBudget,
  repoWriteJsonObjectAt as jsonObjectAt,
  type RepoWriteJsonBudget as JsonBudget
} from "./repo-write-json-budget.ts";
import {
  createRepoWriteTerminalProofV1,
  decodeRepoWriteTerminalProofV1,
  type RepoWriteTerminalEvidenceV1,
  type RepoWriteTerminalProofV1
} from "./repo-write-terminal-proof.ts";

export { RepoWriteOutcomeValidationError } from "./repo-write-outcome-errors.ts";
export {
  repoWriteTerminalProofSchema,
  type RepoWriteTerminalEvidenceV1,
  type RepoWriteTerminalProofV1
} from "./repo-write-terminal-proof.ts";

export const repoWriteOutcomeSchema = "repo-write-outcome/v1" as const;
const repoWriteRequestDigestSchema = "repo-write-request-digest/v1" as const;
export const repoWriteReceiptSeedSchema = "repo-write-receipt-seed/v1" as const;
const repoWriteActorStampDigestSchema = "repo-write-actor-stamp-digest/v1" as const;
const digestPattern = /^[a-f0-9]{64}$/u;
const maximumIdentifierBytes = 4_096;
const maximumJsonStringBytes = 256 * 1_024;

export interface RepoWriteOutcomeAxesV1 {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly generation: number;
}

export interface RepoWriteProceedingInputV1 extends RepoWriteOutcomeAxesV1 {
  readonly outerOpId: string;
  readonly innerOpId: string;
  readonly authoritySemanticDigest: string;
  readonly canonicalCommand: RepoWriteCommandDto;
  readonly authenticatedContext: RepoWriteJsonObject;
  readonly receiptSeed: RepoWriteReceiptSeedV1;
  readonly recoveryContext: RepoWriteJsonObject;
}

export interface RepoWriteReceiptSeedV1 {
  readonly schema: typeof repoWriteReceiptSeedSchema;
  readonly renderer: "cli-command-receipt/v2@1";
  readonly generatedAt: string;
  readonly command: string;
  readonly action: string;
  readonly actorStampDigest: string;
}

interface RepoWriteOutcomeBaseV1 extends RepoWriteProceedingInputV1 {
  readonly schema: typeof repoWriteOutcomeSchema;
  readonly requestDigest: string;
}

export interface RepoWriteProceedingOutcomeV1 extends RepoWriteOutcomeBaseV1 {
  readonly phase: "PROCEEDING";
}

export interface RepoWriteTerminalOutcomeV1 extends RepoWriteOutcomeBaseV1 {
  readonly phase: "TERMINAL";
  readonly terminalKind: "committed" | "rejected";
  readonly terminalProof: RepoWriteTerminalProofV1;
  readonly receipt: CommandReceiptEnvelope;
  readonly receiptDigest: string;
}

export type RepoWriteOutcomeV1 = RepoWriteProceedingOutcomeV1 | RepoWriteTerminalOutcomeV1;

export function createRepoWriteProceedingOutcomeV1(
  input: RepoWriteProceedingInputV1
): RepoWriteProceedingOutcomeV1 {
  const normalized = repoWriteOutcomeDecodeProceedingInput(input, "$");
  return {
    schema: repoWriteOutcomeSchema,
    ...normalized,
    requestDigest: repoWriteRequestDigestV1(normalized),
    phase: "PROCEEDING"
  };
}

export function createRepoWriteTerminalOutcomeV1(
  proceeding: RepoWriteProceedingOutcomeV1,
  receipt: CommandReceiptEnvelope,
  authorityEvidence: RepoWriteTerminalEvidenceV1
): RepoWriteTerminalOutcomeV1 {
  const current = decodeRepoWriteOutcomeV1(proceeding);
  if (current.phase !== "PROCEEDING") repoWriteOutcomeInvalid("$", "PROCEEDING outcome");
  const normalizedReceipt = decodeRepoWriteCommandReceiptV2(receipt, "$.receipt");
  const normalizedProof = createRepoWriteTerminalProofV1(authorityEvidence);
  repoWriteOutcomeAssertTerminalBindings(current, normalizedReceipt, normalizedProof);
  return {
    ...current,
    phase: "TERMINAL",
    terminalKind: normalizedProof.disposition,
    terminalProof: normalizedProof,
    receipt: normalizedReceipt,
    receiptDigest: repoWriteReceiptDigestV1(normalizedReceipt)
  };
}

export function decodeRepoWriteOutcomeV1(value: unknown): RepoWriteOutcomeV1 {
  const record = repoWriteOutcomeRecordAt(value, "$");
  const phase = record.phase;
  const terminal = phase === "TERMINAL";
  repoWriteOutcomeExactKeys(record, [
    "schema", "repoId", "workspaceId", "generation", "outerOpId", "innerOpId",
    "authoritySemanticDigest", "canonicalCommand", "authenticatedContext", "receiptSeed",
    "recoveryContext", "requestDigest", "phase"
  ], terminal ? ["terminalKind", "terminalProof", "receipt", "receiptDigest"] : [], "$");
  if (record.schema !== repoWriteOutcomeSchema) {
    repoWriteOutcomeInvalid("$.schema", repoWriteOutcomeSchema);
  }
  if (phase !== "PROCEEDING" && phase !== "TERMINAL") {
    repoWriteOutcomeInvalid("$.phase", "PROCEEDING or TERMINAL");
  }

  const input = repoWriteOutcomeDecodeProceedingInput(record, "$");
  const requestDigest = repoWriteOutcomeDigestAt(record.requestDigest, "$.requestDigest");
  if (requestDigest !== repoWriteRequestDigestV1(input)) {
    repoWriteOutcomeInvalid("$.requestDigest", "digest of canonical request");
  }
  const base: RepoWriteOutcomeBaseV1 = {
    schema: repoWriteOutcomeSchema,
    ...input,
    requestDigest
  };
  if (phase === "PROCEEDING") return { ...base, phase };

  const receipt = decodeRepoWriteCommandReceiptV2(record.receipt, "$.receipt");
  const terminalProof = decodeRepoWriteTerminalProofV1(record.terminalProof, "$.terminalProof");
  const terminalKind = record.terminalKind;
  if (terminalKind !== "committed" && terminalKind !== "rejected") {
    repoWriteOutcomeInvalid("$.terminalKind", "committed or rejected");
  }
  if (terminalKind !== (receipt.ok ? "committed" : "rejected")) {
    repoWriteOutcomeInvalid("$.terminalKind", "classification matching receipt.ok");
  }
  if (terminalKind !== terminalProof.disposition) {
    repoWriteOutcomeInvalid("$.terminalKind", "classification matching terminal proof");
  }
  repoWriteOutcomeAssertTerminalBindings(
    { ...base, phase: "PROCEEDING" },
    receipt,
    terminalProof
  );
  const receiptDigest = repoWriteOutcomeDigestAt(record.receiptDigest, "$.receiptDigest");
  if (receiptDigest !== repoWriteReceiptDigestV1(receipt)) {
    repoWriteOutcomeInvalid("$.receiptDigest", "digest of exact command receipt");
  }
  return {
    ...base,
    phase,
    terminalKind,
    terminalProof,
    receipt,
    receiptDigest
  };
}

export function repoWriteRequestDigestV1(input: RepoWriteProceedingInputV1): string {
  const normalized = repoWriteOutcomeDecodeProceedingInput(input, "$");
  return stablePayloadHash({
    schema: repoWriteRequestDigestSchema,
    repoId: normalized.repoId,
    workspaceId: normalized.workspaceId,
    authoritySemanticDigest: normalized.authoritySemanticDigest,
    canonicalCommand: normalized.canonicalCommand,
    authenticatedContext: normalized.authenticatedContext
  });
}

export function repoWriteReceiptDigestV1(receipt: CommandReceiptEnvelope): string {
  return stablePayloadHash(decodeRepoWriteCommandReceiptV2(receipt, "$"));
}

export function repoWriteActorStampDigestV1(actorStamp: RepoWriteJsonObject): string {
  const budget = jsonBudget();
  return stablePayloadHash({
    schema: repoWriteActorStampDigestSchema,
    actor: jsonObjectAt(actorStamp, "$.actor", budget, 1)
  });
}

export function canonicalRepoWriteOutcomeText(outcome: RepoWriteOutcomeV1): string {
  return `${stableStringify(decodeRepoWriteOutcomeV1(outcome))}\n`;
}

export function assertRepoWriteOutcomeAxesV1(
  outcome: RepoWriteOutcomeV1,
  expected: RepoWriteOutcomeAxesV1
): void {
  if (outcome.repoId !== expected.repoId
    || outcome.workspaceId !== expected.workspaceId
    || outcome.generation !== expected.generation) {
    throw new RepoWriteOutcomeValidationError(
      "repo-write outcome repo/workspace/generation axes do not match the writer capsule"
    );
  }
}

export function sameRepoWriteOutcomeImmutableFieldsV1(
  left: RepoWriteOutcomeV1,
  right: RepoWriteOutcomeV1
): boolean {
  return left.repoId === right.repoId
    && left.workspaceId === right.workspaceId
    && left.generation === right.generation
    && left.outerOpId === right.outerOpId
    && left.innerOpId === right.innerOpId
    && left.authoritySemanticDigest === right.authoritySemanticDigest
    && left.requestDigest === right.requestDigest
    && stableStringify(left.canonicalCommand) === stableStringify(right.canonicalCommand)
    && stableStringify(left.authenticatedContext) === stableStringify(right.authenticatedContext)
    && stableStringify(left.receiptSeed) === stableStringify(right.receiptSeed)
    && stableStringify(left.recoveryContext) === stableStringify(right.recoveryContext);
}

function repoWriteOutcomeDecodeProceedingInput(
  value: unknown,
  path: string
): RepoWriteProceedingInputV1 {
  const record = repoWriteOutcomeRecordAt(value, path);
  const budget = jsonBudget();
  const canonicalCommand = repoWriteOutcomeCommandAt(
    record.canonicalCommand,
    `${path}.canonicalCommand`,
    budget
  );
  const input = {
    repoId: repoWriteOutcomeIdentifierAt(record.repoId, `${path}.repoId`),
    workspaceId: repoWriteOutcomeIdentifierAt(record.workspaceId, `${path}.workspaceId`),
    generation: repoWriteOutcomePositiveIntegerAt(record.generation, `${path}.generation`),
    outerOpId: repoWriteOutcomeIdentifierAt(record.outerOpId, `${path}.outerOpId`),
    innerOpId: repoWriteOutcomeIdentifierAt(record.innerOpId, `${path}.innerOpId`),
    authoritySemanticDigest: repoWriteOutcomeDigestAt(
      record.authoritySemanticDigest,
      `${path}.authoritySemanticDigest`
    ),
    canonicalCommand,
    authenticatedContext: jsonObjectAt(
      record.authenticatedContext,
      `${path}.authenticatedContext`,
      budget,
      1
    ),
    receiptSeed: repoWriteOutcomeReceiptSeedAt(record.receiptSeed, `${path}.receiptSeed`),
    recoveryContext: jsonObjectAt(record.recoveryContext, `${path}.recoveryContext`, budget, 1)
  };
  repoWriteOutcomeAssertProceedingActorBindings(input);
  return input;
}

function repoWriteOutcomeAssertProceedingActorBindings(input: RepoWriteProceedingInputV1): void {
  const authenticatedActor = input.authenticatedContext.actor;
  if (!authenticatedActor || typeof authenticatedActor !== "object" || Array.isArray(authenticatedActor)) {
    repoWriteOutcomeInvalid("$.authenticatedContext.actor", "server-authenticated actor stamp");
  }
  const authenticatedDigest = repoWriteActorStampDigestV1(authenticatedActor as RepoWriteJsonObject);
  if (repoWriteActorStampDigestV1(input.canonicalCommand.actor) !== authenticatedDigest) {
    repoWriteOutcomeInvalid(
      "$.canonicalCommand.actor",
      "canonical equality with authenticatedContext.actor"
    );
  }
  if (input.receiptSeed.actorStampDigest !== authenticatedDigest) {
    repoWriteOutcomeInvalid("$.receiptSeed.actorStampDigest", "digest of authenticatedContext.actor");
  }
}

function repoWriteOutcomeReceiptSeedAt(value: unknown, path: string): RepoWriteReceiptSeedV1 {
  const record = repoWriteOutcomeRecordAt(value, path);
  repoWriteOutcomeExactKeys(record, [
    "schema", "renderer", "generatedAt", "command", "action", "actorStampDigest"
  ], [], path);
  if (record.schema !== repoWriteReceiptSeedSchema) {
    repoWriteOutcomeInvalid(`${path}.schema`, repoWriteReceiptSeedSchema);
  }
  if (record.renderer !== "cli-command-receipt/v2@1") {
    repoWriteOutcomeInvalid(`${path}.renderer`, "cli-command-receipt/v2@1");
  }
  const generatedAt = repoWriteOutcomeCanonicalTimestampAt(
    record.generatedAt,
    `${path}.generatedAt`
  );
  return {
    schema: repoWriteReceiptSeedSchema,
    renderer: "cli-command-receipt/v2@1",
    generatedAt,
    command: repoWriteOutcomeIdentifierAt(record.command, `${path}.command`),
    action: repoWriteOutcomeIdentifierAt(record.action, `${path}.action`),
    actorStampDigest: repoWriteOutcomeDigestAt(
      record.actorStampDigest,
      `${path}.actorStampDigest`
    )
  };
}

function repoWriteOutcomeAssertTerminalBindings(
  proceeding: RepoWriteProceedingOutcomeV1,
  receipt: CommandReceiptEnvelope,
  proof: RepoWriteTerminalProofV1
): void {
  if (proof.disposition !== (receipt.ok ? "committed" : "rejected")) {
    repoWriteOutcomeInvalid("$.terminalProof.disposition", "classification matching receipt.ok");
  }
  if (proof.evidence.workspaceId !== proceeding.workspaceId
    || proof.evidence.opId !== proceeding.innerOpId
    || proof.evidence.semanticDigest !== proceeding.authoritySemanticDigest) {
    repoWriteOutcomeInvalid(
      "$.terminalProof.evidence",
      "authority workspaceId, fixed inner opId, and semantic digest"
    );
  }
  const seed = proceeding.receiptSeed;
  if (receipt.command !== seed.command
    || receipt.action !== seed.action
    || receipt.meta.generatedAt !== seed.generatedAt) {
    repoWriteOutcomeInvalid("$.receipt", "command, action, and generatedAt fixed by receiptSeed");
  }
  const actor = receipt.details?.actor;
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    repoWriteOutcomeInvalid("$.receipt.details.actor", "actor-stamped command receipt");
  }
  if (repoWriteActorStampDigestV1(actor as RepoWriteJsonObject) !== seed.actorStampDigest) {
    repoWriteOutcomeInvalid("$.receipt.details.actor", "actor stamp fixed by receiptSeed");
  }
}

function repoWriteOutcomeCommandAt(
  value: unknown,
  path: string,
  budget: JsonBudget
): RepoWriteCommandDto {
  const record = repoWriteOutcomeRecordAt(value, path);
  repoWriteOutcomeExactKeys(record, ["commandName", "actor", "context", "payload"], [], path);
  return {
    commandName: repoWriteOutcomeIdentifierAt(record.commandName, `${path}.commandName`),
    actor: jsonObjectAt(record.actor, `${path}.actor`, budget, 1),
    context: jsonObjectAt(record.context, `${path}.context`, budget, 1),
    payload: jsonObjectAt(record.payload, `${path}.payload`, budget, 1)
  };
}

function repoWriteOutcomeRecordAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    repoWriteOutcomeInvalid(path, "plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    repoWriteOutcomeInvalid(path, "plain object");
  }
  return value as Record<string, unknown>;
}

function repoWriteOutcomeExactKeys(
  record: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
  path: string
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !allowed.has(key))) {
    repoWriteOutcomeInvalid(path, "exact schema fields");
  }
}

function repoWriteOutcomeIdentifierAt(value: unknown, path: string): string {
  const text = repoWriteOutcomeStringAt(value, path, maximumIdentifierBytes);
  if (!text.trim() || /[\u0000-\u001f\u007f]/u.test(text)) {
    repoWriteOutcomeInvalid(path, "non-empty identifier");
  }
  return text;
}

function repoWriteOutcomeStringAt(
  value: unknown,
  path: string,
  maximumBytes = maximumJsonStringBytes
): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes) {
    repoWriteOutcomeInvalid(path, `string no larger than ${maximumBytes} bytes`);
  }
  return value;
}

function repoWriteOutcomePositiveIntegerAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    repoWriteOutcomeInvalid(path, "positive safe integer");
  }
  return value;
}

function repoWriteOutcomeDigestAt(value: unknown, path: string): string {
  const digest = repoWriteOutcomeStringAt(value, path, 64);
  if (!digestPattern.test(digest)) {
    repoWriteOutcomeInvalid(path, "lowercase SHA-256 digest");
  }
  return digest;
}

function repoWriteOutcomeCanonicalTimestampAt(value: unknown, path: string): string {
  const timestamp = repoWriteOutcomeStringAt(value, path);
  if (!repoWriteOutcomeIsCanonicalIsoTimestamp(timestamp)) {
    repoWriteOutcomeInvalid(path, "canonical ISO timestamp");
  }
  return timestamp;
}

function repoWriteOutcomeIsCanonicalIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function repoWriteOutcomeBoundedSegment(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 45)}...`;
}

function repoWriteOutcomeInvalid(path: string, expected: string): never {
  throw new RepoWriteOutcomeValidationError(
    `Invalid ${repoWriteOutcomeSchema} at ${repoWriteOutcomeBoundedSegment(path)}: expected ${expected}.`
  );
}
