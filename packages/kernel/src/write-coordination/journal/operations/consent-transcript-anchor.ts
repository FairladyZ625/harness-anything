import path from "node:path";
import type { EntityId } from "../../../domain/entity-id.ts";
import type { DeclaredEntityDocumentWritePayload } from "../../../entity/declaration.ts";
import { sha256Text } from "../../../integrity/stable-hash.ts";
import { resolveHarnessLayout, taskPackagePath, type HarnessLayoutInput } from "../../../layout/index.ts";
import { localLayoutFileSystem } from "../../../local/local-layout-file-system.ts";
import type { DocumentWrite } from "../../../ports/artifact-store-writer.ts";
import type { WriteOp } from "../../../ports/write-coordinator.ts";
import { appendJsonLineDurably } from "../durable.ts";
import { rejectWrite } from "../rejection.ts";
import { declaredEntityCompanionWrites, hasDeclaredEntityDocument } from "./declared-entity-document.ts";

interface TranscriptConsentClaim {
  readonly key: `sha256:${string}`;
  readonly sessionRef: string;
  readonly messageSha256: string;
  readonly taskRef: string;
  readonly executionRef: string;
  readonly sourcePath: string;
  readonly opId?: string;
}

interface ConsentDocumentCandidate {
  readonly body: string;
  readonly hostTaskId: string;
  readonly relativePath: string;
  readonly sourcePath: string;
}

interface LegacyScanWarning {
  readonly sourcePath: string;
  readonly warning: string;
}

interface AnchorLedgerState {
  readonly claims: ReadonlyArray<TranscriptConsentClaim>;
  readonly migrationComplete: boolean;
}

const anchorLedgerFileName = "consent-anchor-ledger.jsonl";
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;
const executionPathPattern = /^executions\/([^/]+)\.md$/u;
const sessionRefPattern = /^session\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;

export function transcriptConsentClaimsForWriteOp(
  rootInput: HarnessLayoutInput,
  op: WriteOp
): ReadonlyArray<TranscriptConsentClaim> {
  if (op.kind !== "doc_write" || !hasDeclaredEntityDocument(op.payload)) return [];
  const payload = op.payload as DeclaredEntityDocumentWritePayload;
  const companionWrites = declaredEntityCompanionWrites(payload);
  return candidateConsentDocuments(payload, companionWrites, op.entityId).flatMap((candidate) => {
    const claim = decodeCandidateTranscriptConsentClaim(rootInput, payload, companionWrites, candidate, op);
    return claim ? [claim] : [];
  });
}

export function assertTranscriptConsentAnchorReservation(
  rootInput: HarnessLayoutInput,
  op: WriteOp,
  journaledOps: ReadonlyArray<WriteOp>
): void {
  const candidates = transcriptConsentClaimsForWriteOp(rootInput, op);
  if (candidates.length === 0) return;

  const ledger = readAnchorLedger(rootInput, op.entityId);
  const legacy = ledger.migrationComplete ? { claims: [], warnings: [] } : scanLegacyTranscriptConsentClaims(rootInput);
  const journaledClaims = journaledOps.flatMap((journaledOp) => transcriptConsentClaimsForWriteOp(rootInput, journaledOp));
  assertClaimsCompatible(
    [...ledger.claims, ...legacy.claims, ...journaledClaims],
    candidates,
    op.entityId
  );
}

export function publishTranscriptConsentAnchorClaims(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const candidates = transcriptConsentClaimsForWriteOp(rootInput, op);
  if (candidates.length === 0) return;
  const ledgerPath = transcriptConsentAnchorLedgerPath(rootInput);
  let ledger = readAnchorLedger(rootInput, op.entityId);

  if (!ledger.migrationComplete) {
    const legacy = scanLegacyTranscriptConsentClaims(rootInput);
    const known = new Map(ledger.claims.map((claim) => [claim.key, claim]));
    for (const claim of legacy.claims) {
      const existing = known.get(claim.key);
      if (existing) {
        if (existing.executionRef !== claim.executionRef) {
          rejectAnchorConflict(existing, claim, op.entityId);
        }
        continue;
      }
      appendJsonLineDurably(ledgerPath, ledgerClaimRecord(claim));
      known.set(claim.key, claim);
    }
    for (const warning of legacy.warnings) {
      appendJsonLineDurably(ledgerPath, {
        schema: "consent-anchor-migration-warning/v1",
        source_path: warning.sourcePath,
        warning: warning.warning
      });
    }
    appendJsonLineDurably(ledgerPath, {
      schema: "consent-anchor-legacy-scan/v1",
      state: "complete"
    });
    ledger = { claims: [...known.values()], migrationComplete: true };
  }

  assertClaimsCompatible(ledger.claims, candidates, op.entityId);
  const known = new Map(ledger.claims.map((claim) => [claim.key, claim]));
  for (const claim of candidates) {
    const existing = known.get(claim.key);
    if (existing) continue;
    appendJsonLineDurably(ledgerPath, ledgerClaimRecord(claim));
    known.set(claim.key, claim);
  }
}

export function transcriptConsentAnchorKey(anchor: {
  readonly session_ref: string;
  readonly message_sha256: string;
}): `sha256:${string}` {
  const sessionRef = canonicalSessionRef(anchor.session_ref);
  if (!sha256Pattern.test(anchor.message_sha256)) {
    throw new Error("transcript consent anchor message_sha256 must be sha256:<hex>");
  }
  return `sha256:${sha256Text(JSON.stringify([sessionRef, anchor.message_sha256]))}`;
}

export function transcriptConsentAnchorLedgerPath(rootInput: HarnessLayoutInput): string {
  return path.join(resolveHarnessLayout(rootInput).writeJournalRoot, anchorLedgerFileName);
}

function candidateConsentDocuments(
  payload: DeclaredEntityDocumentWritePayload,
  companionWrites: ReadonlyArray<DocumentWrite>,
  entityId: EntityId
): ReadonlyArray<ConsentDocumentCandidate> {
  const declaration = payload.entityDocument.declaration;
  const primary = declaration.kind === "consent"
    ? [candidateFromPrimary(payload, entityId)]
    : [];
  const companions = companionWrites
    .filter((write) => /^consents\/[^/]+\.md$/u.test(write.path))
    .map((write) => ({
      body: write.body,
      hostTaskId: validateTaskId(write.taskId, entityId),
      relativePath: write.path,
      sourcePath: `${write.taskId}/${write.path}`
    }));
  return [...primary, ...companions];
}

function candidateFromPrimary(
  payload: DeclaredEntityDocumentWritePayload,
  entityId: EntityId
): ConsentDocumentCandidate {
  const taskId = validateTaskId(payload.entityDocument.identity.taskId, entityId);
  const consentId = payload.entityDocument.identity.consentId;
  if (typeof consentId !== "string" || consentId.length === 0) {
    rejectWrite("declared consent entity is missing consentId identity", entityId);
  }
  const relativePath = `consents/${consentId}.md`;
  return {
    body: payload.entityDocument.body,
    hostTaskId: taskId,
    relativePath,
    sourcePath: `${taskId}/${relativePath}`
  };
}

function decodeCandidateTranscriptConsentClaim(
  rootInput: HarnessLayoutInput,
  payload: DeclaredEntityDocumentWritePayload,
  companionWrites: ReadonlyArray<DocumentWrite>,
  candidate: ConsentDocumentCandidate,
  op: WriteOp
): TranscriptConsentClaim | null {
  const value = parseConsentJson(candidate.body, candidate.sourcePath, op.entityId, false);
  if (!value || value.schema !== "consent/v2") return null;
  const source = value.source;
  if (!isConsentJsonRecord(source) || source.strength !== "transcript-verified") return null;

  const sourceExecutionIds = executionIdsFromHostedSources(payload, companionWrites, candidate.hostTaskId);
  let sourceExecutionId: string;
  if (sourceExecutionIds.size === 1) {
    sourceExecutionId = [...sourceExecutionIds][0]!;
  } else if (sourceExecutionIds.size > 1) {
    rejectWrite(`transcript consent has multiple hosted execution source paths: ${candidate.sourcePath}`, op.entityId);
  } else {
    sourceExecutionId = executionIdFromExistingHostedConsent(rootInput, candidate, op.entityId);
  }
  return decodeTranscriptConsentClaim(value, source, candidate, sourceExecutionId, op.entityId, op.opId);
}

function executionIdsFromHostedSources(
  payload: DeclaredEntityDocumentWritePayload,
  companionWrites: ReadonlyArray<DocumentWrite>,
  taskId: string
): ReadonlySet<string> {
  const executionIds = new Set<string>();
  const identity = payload.entityDocument.identity;
  if (identity.taskId === taskId && typeof identity.executionId === "string") {
    executionIds.add(identity.executionId);
  }
  for (const source of [...(payload.preconditions ?? []), ...companionWrites]) {
    if (source.taskId !== taskId || !("path" in source) || typeof source.path !== "string") continue;
    const executionId = executionPathPattern.exec(source.path)?.[1];
    if (executionId) executionIds.add(executionId);
  }
  return executionIds;
}

function executionIdFromExistingHostedConsent(
  rootInput: HarnessLayoutInput,
  candidate: ConsentDocumentCandidate,
  entityId: EntityId
): string {
  const targetPath = path.join(taskPackagePath(rootInput, candidate.hostTaskId), candidate.relativePath);
  if (!localLayoutFileSystem.exists(targetPath)) {
    rejectWrite(`transcript consent requires a hosted execution source path: ${candidate.sourcePath}`, entityId);
  }
  const existing = parseConsentJson(localLayoutFileSystem.readText(targetPath), candidate.sourcePath, entityId, false);
  const executionRef = existing?.execution_ref;
  const parsed = typeof executionRef === "string" ? parseExecutionRef(executionRef) : null;
  if (!parsed || parsed.taskId !== candidate.hostTaskId) {
    rejectWrite(`existing hosted consent has an invalid execution_ref: ${candidate.sourcePath}`, entityId);
  }
  return parsed.executionId;
}

function decodeTranscriptConsentClaim(
  value: Record<string, unknown>,
  source: Record<string, unknown>,
  candidate: ConsentDocumentCandidate,
  sourceExecutionId: string,
  entityId: EntityId,
  opId?: string
): TranscriptConsentClaim {
  const taskRef = value.task_ref;
  const executionRef = value.execution_ref;
  const parsedExecutionRef = typeof executionRef === "string" ? parseExecutionRef(executionRef) : null;
  if (taskRef !== `task/${candidate.hostTaskId}`
    || !parsedExecutionRef
    || parsedExecutionRef.taskId !== candidate.hostTaskId
    || parsedExecutionRef.executionId !== sourceExecutionId) {
    rejectWrite(
      `transcript consent task_ref or execution_ref does not match its hosted execution source path: ${candidate.sourcePath}`,
      entityId
    );
  }

  const anchor = source.transcript_anchor;
  if (!isConsentJsonRecord(anchor)
    || typeof anchor.session_ref !== "string"
    || !Number.isInteger(anchor.message_index)
    || Number(anchor.message_index) < 0
    || typeof anchor.message_sha256 !== "string"
    || !sha256Pattern.test(anchor.message_sha256)) {
    rejectWrite(`transcript-verified consent has an invalid anchor: ${candidate.sourcePath}`, entityId);
  }
  const sessionRef = canonicalSessionRef(anchor.session_ref);
  return {
    key: transcriptConsentAnchorKey({ session_ref: sessionRef, message_sha256: anchor.message_sha256 }),
    sessionRef,
    messageSha256: anchor.message_sha256,
    taskRef: `task/${candidate.hostTaskId}`,
    executionRef: `execution/${candidate.hostTaskId}/${sourceExecutionId}`,
    sourcePath: candidate.sourcePath,
    ...(opId ? { opId } : {})
  };
}

function scanLegacyTranscriptConsentClaims(rootInput: HarnessLayoutInput): {
  readonly claims: ReadonlyArray<TranscriptConsentClaim>;
  readonly warnings: ReadonlyArray<LegacyScanWarning>;
} {
  const tasksRoot = resolveHarnessLayout(rootInput).tasksRoot;
  if (!localLayoutFileSystem.exists(tasksRoot)) return { claims: [], warnings: [] };
  const claims: TranscriptConsentClaim[] = [];
  const warnings: LegacyScanWarning[] = [];
  for (const taskEntry of localLayoutFileSystem.readDirents(tasksRoot)) {
    if (!taskEntry.isDirectory()) continue;
    const hostTaskId = taskEntry.name.match(/^(task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26})(?:-|$)/u)?.[1];
    if (!hostTaskId) continue;
    const consentRoot = path.join(tasksRoot, taskEntry.name, "consents");
    if (!localLayoutFileSystem.exists(consentRoot)) continue;
    for (const consentEntry of localLayoutFileSystem.readDirents(consentRoot)) {
      if (!consentEntry.isFile() || !consentEntry.name.endsWith(".md")) continue;
      const consentPath = path.join(consentRoot, consentEntry.name);
      const relativePath = `consents/${consentEntry.name}`;
      const sourcePath = `${taskEntry.name}/${relativePath}`;
      try {
        const value = parseConsentJson(localLayoutFileSystem.readText(consentPath), sourcePath, undefined, true);
        if (!value || value.schema !== "consent/v2" || !isConsentJsonRecord(value.source)
          || value.source.strength !== "transcript-verified") continue;
        const executionRef = typeof value.execution_ref === "string" ? parseExecutionRef(value.execution_ref) : null;
        if (!executionRef || executionRef.taskId !== hostTaskId) throw new Error("execution_ref does not match hosted task");
        assertHostedExecutionDocument(rootInput, hostTaskId, executionRef.executionId);
        claims.push(decodeTranscriptConsentClaim(
          value,
          value.source,
          { body: "", hostTaskId, relativePath, sourcePath },
          executionRef.executionId,
          `entity/consent/${consentEntry.name.slice(0, -3)}` as EntityId
        ));
      } catch (error) {
        warnings.push({
          sourcePath,
          warning: `skipped malformed legacy consent: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }
  return { claims, warnings };
}

function assertHostedExecutionDocument(rootInput: HarnessLayoutInput, taskId: string, executionId: string): void {
  const executionPath = path.join(taskPackagePath(rootInput, taskId), "executions", `${executionId}.md`);
  if (!localLayoutFileSystem.exists(executionPath)) throw new Error("hosted execution document is missing");
  const value: unknown = JSON.parse(localLayoutFileSystem.readText(executionPath));
  if (!isConsentJsonRecord(value)
    || value.schema !== "execution/v2"
    || value.execution_id !== executionId
    || value.task_ref !== `task/${taskId}`) {
    throw new Error("hosted execution document identity is inconsistent");
  }
}

function readAnchorLedger(rootInput: HarnessLayoutInput, entityId: EntityId): AnchorLedgerState {
  const ledgerPath = transcriptConsentAnchorLedgerPath(rootInput);
  if (!localLayoutFileSystem.exists(ledgerPath)) return { claims: [], migrationComplete: false };
  const lines = localLayoutFileSystem.readText(ledgerPath).split(/\r?\n/u).filter(Boolean);
  const claims: TranscriptConsentClaim[] = [];
  let migrationComplete = false;
  for (let index = 0; index < lines.length; index += 1) {
    let value: unknown;
    try {
      value = JSON.parse(lines[index]!);
    } catch {
      rejectWrite(`coordinator-owned consent anchor ledger is malformed at line ${index + 1}`, entityId);
    }
    if (!isConsentJsonRecord(value) || typeof value.schema !== "string") {
      rejectWrite(`coordinator-owned consent anchor ledger is malformed at line ${index + 1}`, entityId);
    }
    if (value.schema === "consent-anchor-migration-warning/v1") continue;
    if (value.schema === "consent-anchor-legacy-scan/v1" && value.state === "complete") {
      migrationComplete = true;
      continue;
    }
    if (value.schema !== "consent-anchor-claim/v1"
      || typeof value.key !== "string"
      || !sha256Pattern.test(value.key)
      || typeof value.session_ref !== "string"
      || typeof value.message_sha256 !== "string"
      || typeof value.task_ref !== "string"
      || typeof value.execution_ref !== "string"
      || typeof value.source_path !== "string") {
      rejectWrite(`coordinator-owned consent anchor ledger has an unsupported record at line ${index + 1}`, entityId);
    }
    const expectedKey = transcriptConsentAnchorKey({
      session_ref: value.session_ref,
      message_sha256: value.message_sha256
    });
    if (value.key !== expectedKey) {
      rejectWrite(`coordinator-owned consent anchor ledger key mismatch at line ${index + 1}`, entityId);
    }
    claims.push({
      key: expectedKey,
      sessionRef: canonicalSessionRef(value.session_ref),
      messageSha256: value.message_sha256,
      taskRef: value.task_ref,
      executionRef: value.execution_ref,
      sourcePath: value.source_path,
      ...(typeof value.op_id === "string" ? { opId: value.op_id } : {})
    });
  }
  assertLedgerSelfConsistent(claims, entityId);
  return { claims, migrationComplete };
}

function assertLedgerSelfConsistent(claims: ReadonlyArray<TranscriptConsentClaim>, entityId: EntityId): void {
  const known = new Map<string, TranscriptConsentClaim>();
  for (const claim of claims) {
    const existing = known.get(claim.key);
    if (existing && existing.executionRef !== claim.executionRef) {
      rejectWrite(`coordinator-owned consent anchor ledger contains conflicting consumers for ${claim.key}`, entityId);
    }
    known.set(claim.key, claim);
  }
}

function assertClaimsCompatible(
  existingClaims: ReadonlyArray<TranscriptConsentClaim>,
  candidates: ReadonlyArray<TranscriptConsentClaim>,
  entityId: EntityId
): void {
  const known = new Map<string, TranscriptConsentClaim>();
  for (const claim of existingClaims) {
    const existing = known.get(claim.key);
    if (!existing) known.set(claim.key, claim);
    else if (existing.executionRef !== claim.executionRef) rejectAnchorConflict(existing, claim, entityId);
  }
  for (const claim of candidates) {
    const existing = known.get(claim.key);
    if (existing && existing.executionRef !== claim.executionRef) rejectAnchorConflict(existing, claim, entityId);
    known.set(claim.key, claim);
  }
}

function rejectAnchorConflict(
  existing: TranscriptConsentClaim,
  candidate: TranscriptConsentClaim,
  entityId: EntityId
): never {
  rejectWrite([
    `transcript consent anchor ${candidate.key} has already been consumed by ${existing.executionRef}.`,
    `Ask the human to send a new standalone confirmation message containing ${candidate.executionRef}, then pass that complete message.`
  ].join(" "), entityId);
}

function ledgerClaimRecord(claim: TranscriptConsentClaim): Record<string, unknown> {
  return {
    schema: "consent-anchor-claim/v1",
    key: claim.key,
    session_ref: claim.sessionRef,
    message_sha256: claim.messageSha256,
    task_ref: claim.taskRef,
    execution_ref: claim.executionRef,
    source_path: claim.sourcePath,
    ...(claim.opId ? { op_id: claim.opId } : {})
  };
}

function canonicalSessionRef(value: string): string {
  const normalized = value.normalize("NFC");
  if (!sessionRefPattern.test(normalized)) {
    throw new Error("transcript consent anchor session_ref must be canonical session/<sessionId>");
  }
  return normalized;
}

function parseExecutionRef(value: string): { readonly taskId: string; readonly executionId: string } | null {
  const match = /^execution\/(task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26})\/([^/]+)$/u.exec(value);
  return match ? { taskId: match[1]!, executionId: match[2]! } : null;
}

function validateTaskId(value: unknown, entityId: EntityId): string {
  if (typeof value !== "string" || !taskIdPattern.test(value)) {
    rejectWrite("transcript consent host task identity is invalid", entityId);
  }
  return value;
}

function parseConsentJson(
  body: string,
  sourcePath: string,
  entityId: EntityId | undefined,
  legacy: boolean
): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return isConsentJsonRecord(value) ? value : null;
  } catch (error) {
    if (legacy) throw error;
    rejectWrite(`consent document is not valid JSON: ${sourcePath}`, entityId);
  }
}

function isConsentJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
