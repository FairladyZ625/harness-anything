import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import { readAttributionEvents } from "../local/attribution-event-source.ts";
import { readLegacyPersonIds } from "../projection/entity-attribution-projection.ts";
import { materializeAttributionProjection } from "../projection/sqlite-attribution-projection.ts";
import { readDecisionProjectionRows } from "../projection/sqlite-decision-source.ts";
import { readMarkdownSource, taskEntryToRow } from "../projection/sqlite-task-source.ts";
import type { ActorAxes } from "../schemas/actor-attribution.ts";
import type { WriteOpKind } from "../domain/write-op-kind.ts";
import { makeLocalVersionControlSystem } from "./local-version-control-system.ts";
import { commitTouchedPaths } from "./write-journal-git.ts";
import { makeLocalGitAttributionEventStore } from "./write-journal-attribution-events.ts";
import type { JournalRecordV2 } from "./write-journal-types.ts";
import { durableFileExists } from "./write-journal-durable.ts";

type LegacyActor = { readonly kind: "human" | "agent" | "system"; readonly id: string };

export interface AttributionBackfillCandidate {
  readonly entityId: string;
  readonly entityKind: "task" | "decision";
  readonly role: "createdBy" | "proposedBy" | "arbiter";
  readonly legacyActor: LegacyActor | null;
  readonly operation: WriteOpKind;
  readonly occurredAt: string | null;
  readonly resolution: "legacy-derived" | "unresolved" | "already-covered";
  readonly actor: ActorAxes | null;
  readonly reason: string;
}

export interface AttributionBackfillPlan {
  readonly schema: "attribution-backfill-report/v1";
  readonly planId: string;
  readonly reportDigest: string;
  readonly candidates: ReadonlyArray<AttributionBackfillCandidate>;
  readonly summary: {
    readonly scanned: number;
    readonly legacyDerived: number;
    readonly unresolved: number;
    readonly alreadyCovered: number;
    readonly applicableEvents: number;
  };
}

export interface AttributionBackfillApplyResult {
  readonly plan: AttributionBackfillPlan;
  readonly appliedEvents: number;
  readonly recordedAt: string;
}

export function planAttributionBackfill(rootInput: HarnessLayoutInput): AttributionBackfillPlan {
  const personIds = readLegacyPersonIds(rootInput);
  const covered = new Set(readAttributionEvents(rootInput).map((event) => event.entityId));
  const candidates = [
    ...taskCandidates(rootInput),
    ...decisionCandidates(rootInput)
  ].map((candidate) => resolveCandidate(candidate, personIds, covered))
    .sort((left, right) => `${left.entityKind}:${left.entityId}:${left.role}`.localeCompare(`${right.entityKind}:${right.entityId}:${right.role}`));
  const payload = { candidates, personIds: [...personIds].sort() };
  const reportDigest = stablePayloadHash(payload);
  const planId = `abf_${reportDigest.slice(0, 20)}`;
  return {
    schema: "attribution-backfill-report/v1",
    planId,
    reportDigest: `sha256:${reportDigest}`,
    candidates,
    summary: {
      scanned: candidates.length,
      legacyDerived: candidates.filter((candidate) => candidate.resolution === "legacy-derived").length,
      unresolved: candidates.filter((candidate) => candidate.resolution === "unresolved").length,
      alreadyCovered: candidates.filter((candidate) => candidate.resolution === "already-covered").length,
      applicableEvents: candidates.filter(isApplicableCandidate).length
    }
  };
}

export function applyAttributionBackfill(
  rootInput: HarnessLayoutInput,
  expectedPlanId: string,
  recordedAt = new Date().toISOString()
): AttributionBackfillApplyResult {
  const plan = planAttributionBackfill(rootInput);
  if (expectedPlanId !== plan.planId) throw new Error(`attribution backfill requires --confirm-plan ${plan.planId}`);
  const layout = resolveHarnessLayout(rootInput);
  const vcs = makeLocalVersionControlSystem();
  const store = makeLocalGitAttributionEventStore();
  const commitSha = vcs.currentHead(layout.authoredRoot);
  const writes = plan.candidates.filter(isApplicableCandidate).map((candidate) => {
    const record = syntheticJournalRecord(candidate, plan);
    return store.ensure(record, {
      rootDir: layout.rootDir,
      rootInput,
      commitSha,
      versionControlSystem: vcs,
      recordedAt
    });
  });
  const paths = writes.flatMap((write) => write.touchedPaths);
  const committedSha = commitTouchedPaths(
    layout.rootDir,
    paths,
    writes.map((write) => write.event.opId),
    rootInput,
    `feat: backfill attribution ${plan.planId}`,
    undefined,
    { versionControlSystem: vcs }
  );
  for (const write of writes) {
    if (!store.confirms(write.event, { rootDir: layout.rootDir, rootInput, commitSha: committedSha, versionControlSystem: vcs })) {
      throw new Error(`attribution backfill event was not durable: ${write.event.opId}`);
    }
  }
  if (durableFileExists(layout.projectionPath)) materializeAttributionProjection(rootInput, layout.projectionPath);
  return { plan, appliedEvents: writes.length, recordedAt };
}

function taskCandidates(rootInput: HarnessLayoutInput): ReadonlyArray<Omit<AttributionBackfillCandidate, "resolution" | "actor" | "reason">> {
  return readMarkdownSource(rootInput).entries.map((entry) => taskEntryToRow(rootInput, entry))
    .filter((row) => row.createdBy !== undefined)
    .map((row) => ({
      entityId: row.taskId,
      entityKind: "task" as const,
      role: "createdBy" as const,
      legacyActor: null,
      operation: "package_create" as const,
      occurredAt: null
    }));
}

function decisionCandidates(rootInput: HarnessLayoutInput): ReadonlyArray<Omit<AttributionBackfillCandidate, "resolution" | "actor" | "reason">> {
  return readDecisionProjectionRows(rootInput).flatMap((row) => [
    ...(row.proposedBy ? [{
      entityId: row.decisionId,
      entityKind: "decision" as const,
      role: "proposedBy" as const,
      legacyActor: row.proposedBy,
      operation: "decision_propose" as const,
      occurredAt: row.proposedAt ?? null
    }] : []),
    ...(row.arbiter ? [{
      entityId: row.decisionId,
      entityKind: "decision" as const,
      role: "arbiter" as const,
      legacyActor: row.arbiter,
      operation: decisionOutcomeOperation(row.state),
      occurredAt: row.decidedAt ?? null
    }] : [])
  ]);
}

function resolveCandidate(
  candidate: Omit<AttributionBackfillCandidate, "resolution" | "actor" | "reason">,
  personIds: ReadonlySet<string>,
  covered: ReadonlySet<string>
): AttributionBackfillCandidate {
  if (covered.has(candidate.entityId) || covered.has(`${candidate.entityKind}/${candidate.entityId}`)) {
    return { ...candidate, resolution: "already-covered", actor: null, reason: "durable attribution event already exists" };
  }
  if (!candidate.legacyActor) {
    return { ...candidate, resolution: "unresolved", actor: null, reason: "legacy createdBy name/email is evidence, not a principal id" };
  }
  if (candidate.legacyActor.kind !== "human") {
    return { ...candidate, resolution: "unresolved", actor: null, reason: `${candidate.legacyActor.kind} legacy actor cannot establish a historical principal` };
  }
  if (!personIds.has(candidate.legacyActor.id)) {
    return { ...candidate, resolution: "unresolved", actor: null, reason: "legacy human id has no exact person registry match" };
  }
  if (!candidate.occurredAt) {
    return { ...candidate, resolution: "unresolved", actor: null, reason: "legacy record lacks a historical occurrence time" };
  }
  return {
    ...candidate,
    resolution: "legacy-derived",
    actor: { principal: { kind: "person", personId: candidate.legacyActor.id }, executor: null },
    reason: "legacy human id exactly matches the person registry"
  };
}

function isApplicableCandidate(candidate: AttributionBackfillCandidate): candidate is AttributionBackfillCandidate & { readonly actor: ActorAxes; readonly occurredAt: string } {
  return candidate.resolution === "legacy-derived" && candidate.actor !== null && candidate.occurredAt !== null;
}

function syntheticJournalRecord(
  candidate: AttributionBackfillCandidate & { readonly actor: ActorAxes; readonly occurredAt: string },
  plan: AttributionBackfillPlan
): JournalRecordV2 {
  const evidence = { planId: plan.planId, reportDigest: plan.reportDigest, candidate };
  const payloadHash = stablePayloadHash(evidence);
  const suffix = stablePayloadHash({ entityId: candidate.entityId, role: candidate.role }).slice(0, 16);
  return {
    schema: "write-journal/v2",
    opId: `attribution-backfill:${plan.planId}:${suffix}`,
    entityId: `${candidate.entityKind}/${candidate.entityId}`,
    kind: candidate.operation,
    actor: candidate.actor,
    principalSource: { kind: "migration", evidenceRef: plan.reportDigest },
    executorSource: "none",
    at: candidate.occurredAt,
    payloadRef: { path: `attribution-migration-report:${plan.planId}`, sha256: plan.reportDigest },
    payload: { payloadHash }
  };
}

function decisionOutcomeOperation(state: string): WriteOpKind {
  if (state === "accepted") return "decision_accept";
  if (state === "rejected") return "decision_reject";
  if (state === "deferred") return "decision_defer";
  if (state === "superseded") return "decision_supersede";
  if (state === "retired") return "decision_retire";
  return "decision_amend";
}
