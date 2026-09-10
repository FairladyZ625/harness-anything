import { validateCurrentCiRunObservationEvent } from "../domain/ci-run-observation-event.ts";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decisionContentPin,
  decisionMachineDigest,
  reduceDecisionDocument,
} from "../domain/decision-event-document.ts";
import type { DecisionEventV1 } from "../domain/decision-event-types.ts";
import type { CanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { submissionDigest, type SubmissionV1 } from "../domain/execution.ts";
import { reviewDigest, type ReviewConsentV1, type ReviewV1 } from "../domain/review.ts";
import { isSettingsEvent } from "../domain/settings-event.ts";
import { SETTINGS_REPOSITORY_V1_SCHEMA, type WalFlushSettingsV1 } from "../domain/settings.ts";
import { canonicalMigrationProvenance, isMigrationImportEvent } from "../domain/migration-import-event.ts";
import { normalizeLegacyRelationState } from "../domain/entity-relation.ts";
import {
  serializeEntityJsonSchema,
  validateEntityJsonSchema,
  type EntityJsonObjectSchema,
} from "../domain/entity-json-schema.ts";
import {
  SCHEDULE_DEFINITION_V1_SCHEMA,
  scheduleDefinition,
  validateScheduleDefinitionV1,
  type ScheduleV1,
} from "../domain/schedule.ts";
import { isRelationEvent } from "../domain/relation-event.ts";
import { isTaskBootstrapEvent } from "../domain/task-bootstrap-event.ts";
import { isTaskEvent, serializePersistedCanonicalEvent } from "../domain/doc-sync-canonical-events.ts";
import { validateTaskV2, type TaskV2 } from "../domain/task.ts";
import { normalizePersistedTimestamp } from "../domain/timestamp.ts";
import { isRecord } from "../domain/write-chain.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { makeTaskProjection } from "../projection/rebuildable-task-projection-factory.ts";
import { canonicalJson } from "../projection/rebuildable-task-projection-sql.ts";
import type { TaskProjection } from "../projection/task-projection-port.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";
import { canonicalLedgerCut } from "./task-event-store-contract.ts";
import type { CanonicalContentBlob, CanonicalEventStore } from "./task-event-store-types.ts";

// Pure offline generation planner. It replays an immutable generation-0 snapshot into a scratch
// projection and emits generation-1 event values and required content blobs. Candidates are
// replayed at their historical cuts; the planner neither mutates the source nor publishes into an
// active store. Conversion validates the complete plan before seeding an inactive destination.
export type EventShapeMigrationName =
  | "task-v2-snapshots"
  | "legacy-import-normalization"
  | "relation-events"
  | "review-submission-pins"
  | "decision-digests"
  | "schedule-definitions"
  | "settings-wal-flush"
  | "ci-workflow-verification";
export type EventShapeMigrationKind =
  | "task-v2-snapshots-migrate"
  | "legacy-import-normalization-migrate"
  | "relation-events-migrate"
  | "review-submission-pins-migrate"
  | "decision-digests-migrate"
  | "schedule-definitions-migrate"
  | "settings-wal-flush-migrate";
export interface EventShapeRewrite {
  readonly event: CanonicalEventV1;
  readonly blobs?: readonly CanonicalContentBlob[];
  readonly category: string;
  readonly before: unknown;
  readonly after: unknown;
}
export type EventShapeCut = Pick<
  TaskProjection,
  "readEntityVersionWitness" | "readDecisionDocumentState" | "readReplicaBasis"
>;
export interface EventShapeMigrationSpec {
  readonly name: EventShapeMigrationName;
  // Pure on the event: true for every event whose `rewrite` reads the cut. Only these are replayed
  // one revision at a time; every other event is rewritten inside bulk rounds, so a rewrite may
  // touch `cut` only when `matches` is true for that event.
  readonly matches: (event: CanonicalEventV1) => boolean;
  readonly rewrite: (event: CanonicalEventV1, cut: EventShapeCut) => EventShapeRewrite | null;
}
export interface LegacyGenerationConversionPlan {
  readonly events: readonly CanonicalEventV1[];
  readonly blobs: readonly CanonicalContentBlob[];
  readonly rewrites: readonly {
    readonly migration: EventShapeMigrationName;
    readonly opId: string;
    readonly revision: number;
    readonly category: string;
  }[];
  readonly migrationFamilies: readonly EventShapeMigrationFamilyReport[];
}

export interface EventShapeMigrationFamilyReport {
  readonly name: EventShapeMigrationName;
  readonly count: number;
  readonly firstRevision: number | null;
  readonly lastRevision: number | null;
}

function asTaskBootstrapEvent(event: CanonicalEventV1) {
  return isTaskBootstrapEvent(event) ? event : null;
}

function taskWithRetiredRelations(event: CanonicalEventV1): {
  readonly task: TaskV2;
  readonly relations: readonly Readonly<Record<string, unknown>>[];
} | null {
  const carrier = isTaskEvent(event) ? event : asTaskBootstrapEvent(event);
  if (carrier === null) return null;
  const task = carrier.payload.task as TaskV2 & { readonly relations?: unknown };
  if (!Object.hasOwn(task, "relations")) return null;
  const { relations, ...current } = task;
  if (!Array.isArray(relations) || validateTaskV2(current).length > 0) return null;
  return {
    task,
    relations: relations as readonly Readonly<Record<string, unknown>>[],
  };
}

const taskV2SnapshotsMigration: EventShapeMigrationSpec = {
  name: "task-v2-snapshots",
  // A non-empty carrier reads the relation aggregate at the pre-event cut. In particular,
  // task_relation_added becomes the canonical relation event before later snapshots drop the
  // retired hosted field.
  matches: (event) => (taskWithRetiredRelations(event)?.relations.length ?? 0) > 0,
  rewrite: (event, cut) => {
    const legacy = taskWithRetiredRelations(event);
    if (legacy === null) return null;
    const { relations: _retiredRelations, ...task } = legacy.task as TaskV2 & {
      readonly relations: readonly Readonly<Record<string, unknown>>[];
    };
    if (legacy.relations.length === 0)
      return {
        event: { ...event, payload: { ...event.payload, task } } as CanonicalEventV1,
        category: "retired empty Task.relations dropped",
        before: legacy.task,
        after: task,
      };
    if (!isTaskEvent(event))
      throw new Error(`task snapshot ${event.opId} carries non-empty relations without a task lifecycle mutation`);
    if (event.type === "task_relation_added") {
      const addedIds = new Set(event.payload.mutation.fields),
        added = legacy.relations.filter((relation) => addedIds.has(String(relation.relation_id))),
        carried = legacy.relations.filter((relation) => !addedIds.has(String(relation.relation_id)));
      if (added.length !== 1)
        throw new Error(`task relation event ${event.opId} must identify exactly one added relation`);
      assertRelationsExistAtCut(carried, cut, event.opId);
      const relation = added[0]!,
        relationId = String(relation.relation_id);
      return {
        event: {
          schema: "relation-event/v1",
          eventId: event.eventId,
          workspaceRevision: event.workspaceRevision,
          opId: event.opId,
          relationId,
          type: "relation_created",
          actor: event.actor,
          source: event.source,
          occurredAt: event.occurredAt,
          payload: { relation },
        } as CanonicalEventV1,
        category: "embedded task relation promoted to canonical relation_created",
        before: event,
        after: { relationId, relation },
      };
    }
    assertRelationsExistAtCut(legacy.relations, cut, event.opId);
    return {
      event: { ...event, payload: { ...event.payload, task } } as CanonicalEventV1,
      category: "retired Task.relations dropped after canonical relation event",
      before: legacy.task,
      after: task,
    };
  },
};

function normalizeEmbeddedTaskToCurrentTaskV2(task: TaskV2): TaskV2 | null {
  const current = task as TaskV2 & { readonly pinned?: unknown };
  let normalized: TaskV2 = {
    ...current,
    schema: "task/v2",
    ...(Object.hasOwn(current, "pinned") ? {} : { pinned: false }),
  };
  if (normalized.metadata !== undefined) {
    const { longRunning: _retiredLongRunning, ...metadata } = normalized.metadata as TaskV2["metadata"] & {
      readonly longRunning?: unknown;
    };
    normalized = {
      ...normalized,
      metadata: {
        ...metadata,
        workKind: metadata.workKind ?? null,
        urgency: metadata.urgency ?? null,
        verticalId: metadata.verticalId ?? "software/coding",
        surfaces: metadata.surfaces ?? [],
      },
    };
  }
  if (
    Array.isArray(normalized.provenance) &&
    normalized.provenance.some((entry) => !Object.hasOwn(entry, "transcriptReachability"))
  )
    normalized = { ...normalized, provenance: canonicalMigrationProvenance(normalized.provenance) };
  return canonicalJson(normalized) === canonicalJson(task) ? null : normalized;
}

function taskCarrier(event: CanonicalEventV1): { readonly task: TaskV2 } | null {
  const payload = event.payload as unknown;
  if (!isRecord(payload) || !isRecord(payload.task)) return null;
  return { task: payload.task as unknown as TaskV2 };
}

function legacyDocLedgerIdentity(event: CanonicalEventV1): { readonly repoId: string } | null {
  if (event.schema !== "doc-event/v1" || event.type !== "documents_written" || !isRecord(event.payload)) return null;
  const payload = event.payload as unknown as Readonly<Record<string, unknown>>,
    base = payload.baseLedgerSha;
  return isRecord(base) && typeof base.repoId === "string" && typeof base.sha === "string"
    ? { repoId: base.repoId }
    : null;
}

function canonicalProvenance(entries: readonly unknown[]): ReturnType<typeof canonicalMigrationProvenance> {
  return canonicalMigrationProvenance(
    entries.map((entry) =>
      isRecord(entry) ? { ...entry, boundAt: normalizePersistedTimestamp(entry.boundAt) ?? entry.boundAt } : entry,
    ),
  );
}

const legacyImportNormalizationMigration: EventShapeMigrationSpec = {
  name: "legacy-import-normalization",
  matches: (event) => legacyDocLedgerIdentity(event) !== null,
  rewrite: (event, cut) => {
    const carrier = taskCarrier(event);
    if (carrier !== null) {
      const task = normalizeEmbeddedTaskToCurrentTaskV2(carrier.task);
      return task === null
        ? null
        : {
            event: { ...event, payload: { ...event.payload, task } } as CanonicalEventV1,
            category: "embedded task normalized to current Task/v2",
            before: carrier.task,
            after: task,
          };
    }
    const legacyLedger = legacyDocLedgerIdentity(event);
    if (legacyLedger !== null) {
      const headEvent = cut.readReplicaBasis(null).headEvent,
        head =
          headEvent === null
            ? null
            : {
                revision: headEvent.workspaceRevision,
                opId: headEvent.opId,
                eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(headEvent))}` as const,
              },
        baseLedgerSha = canonicalLedgerCut(legacyLedger.repoId, head);
      return {
        event: {
          ...event,
          source: isRecord(event.source) && event.source.kind === "watch_session" ? "local" : event.source,
          payload: { ...event.payload, baseLedgerSha },
        } as CanonicalEventV1,
        category: "legacy commit ledger identity normalized to pre-event canonical cut",
        before: (event.payload as unknown as Readonly<Record<string, unknown>>).baseLedgerSha,
        after: baseLedgerSha,
      };
    }
    if (event.schema === "decision-event/v1" && event.type === "decision_proposed" && isRecord(event.payload)) {
      if (Object.hasOwn(event.payload, "provenance")) return null;
      const payload = {
        ...event.payload,
        provenance: canonicalProvenance([{ runtime: "unavailable", sessionId: null, boundAt: event.occurredAt }]),
      };
      return {
        event: { ...event, payload } as CanonicalEventV1,
        category: "legacy decision proposal normalized to current payload",
        before: event.payload,
        after: payload,
      };
    }
    if (!isMigrationImportEvent(event)) return null;
    const entity = event.payload.entity,
      task = entity.kind === "task" ? normalizeEmbeddedTaskToCurrentTaskV2(entity.task) : null,
      fact =
        entity.kind === "fact"
          ? {
              ...entity.fact,
              observedAt: normalizePersistedTimestamp(entity.fact.observedAt) ?? entity.fact.observedAt,
              provenance: canonicalProvenance(entity.fact.provenance),
            }
          : null,
      decision =
        entity.kind === "decision"
          ? {
              ...entity.decision,
              proposedAt: normalizePersistedTimestamp(entity.decision.proposedAt) ?? entity.decision.proposedAt,
              decidedAt:
                entity.decision.decidedAt === null
                  ? null
                  : (normalizePersistedTimestamp(entity.decision.decidedAt) ?? entity.decision.decidedAt),
            }
          : null,
      occurredAt = event.occurredAt.endsWith("Z") ? null : normalizePersistedTimestamp(event.occurredAt);
    const normalizedEntity =
      task !== null
        ? { ...entity, task }
        : fact !== null && entity.kind === "fact" && canonicalJson(fact) !== canonicalJson(entity.fact)
          ? { ...entity, fact }
          : decision !== null &&
              entity.kind === "decision" &&
              canonicalJson(decision) !== canonicalJson(entity.decision)
            ? { ...entity, decision }
            : entity;
    if (normalizedEntity === entity && occurredAt === null) return null;
    return {
      event: {
        ...event,
        occurredAt: occurredAt ?? event.occurredAt,
        payload: { ...event.payload, entity: normalizedEntity },
      } as CanonicalEventV1,
      category: [
        task === null ? null : "embedded task normalized to current Task/v2",
        fact === null ? null : "fact provenance normalized",
        normalizedEntity !== entity && entity.kind === "decision" ? "decision timestamps normalized" : null,
        occurredAt ? "occurredAt normalized to Z" : null,
      ]
        .filter(Boolean)
        .join(", "),
      before: { occurredAt: event.occurredAt, entity },
      after: { occurredAt: occurredAt ?? event.occurredAt, entity: normalizedEntity },
    };
  },
};

function assertRelationsExistAtCut(
  relations: readonly Readonly<Record<string, unknown>>[],
  cut: EventShapeCut,
  opId: string,
): void {
  const missing = relations
    .map((relation) => String(relation.relation_id))
    .filter((relationId) => cut.readEntityVersionWitness(`relation/${relationId}`).currentVersion === null);
  if (missing.length > 0)
    throw new Error(`task snapshot ${opId} carries relations not present at its historical cut: ${missing.join(", ")}`);
}

const reviewSubmissionPinsMigration: EventShapeMigrationSpec = {
  name: "review-submission-pins",
  matches: () => false,
  rewrite: (event) => {
    if (!isTaskEvent(event) || (event.type !== "review_recorded" && event.type !== "review_consent_recorded"))
      return null;
    const review = event.payload.review as ReviewV1;
    if (Object.hasOwn(review, "submissionDigest")) return null;
    const submission = event.payload.execution.submission as SubmissionV1 | null;
    if (submission === null) throw new Error(`review event ${event.opId} has no submitted execution to pin`);
    const pin = submissionDigest(submission),
      pinnedReview = { ...review, submissionDigest: pin };
    if (event.type === "review_recorded")
      return {
        event: { ...event, payload: { ...event.payload, review: pinnedReview } } as CanonicalEventV1,
        category: "review submission digest pinned",
        before: review,
        after: pinnedReview,
      };
    const consent = event.payload.consent as ReviewConsentV1,
      pinnedConsent = {
        ...consent,
        reviewDigest: reviewDigest(pinnedReview),
        ...(Object.hasOwn(consent, "submissionDigest") ? {} : { submissionDigest: pin }),
      };
    return {
      event: {
        ...event,
        payload: { ...event.payload, review: pinnedReview, consent: pinnedConsent },
      } as CanonicalEventV1,
      category: "review and consent submission digests pinned",
      before: { review, consent },
      after: { review: pinnedReview, consent: pinnedConsent },
    };
  },
};

const relationEventsMigration: EventShapeMigrationSpec = {
  name: "relation-events",
  // Only a missing target witness needs the projection at the event's cut; dropping strength and
  // normalising the state word are pure on the event.
  matches: (event) =>
    isRelationEvent(event) &&
    (event.type === "relation_created" || event.type === "relation_replaced") &&
    !Object.hasOwn(event.payload.relation, "targetObservedVersion"),
  rewrite: (event, cut) => {
    if (isMigrationImportEvent(event)) {
      const entity = event.payload.entity;
      if (entity.kind !== "relation") return null;
      const state = normalizeLegacyRelationState(entity.relation.state);
      if (state === entity.relation.state) return null;
      const relation = { ...entity.relation, state };
      return {
        event: { ...event, payload: { ...event.payload, entity: { ...entity, relation } } } as CanonicalEventV1,
        category: "migration-import relation state normalized",
        before: entity.relation,
        after: relation,
      };
    }
    if (!isRelationEvent(event) || (event.type !== "relation_created" && event.type !== "relation_replaced"))
      return null;
    const facet = event.payload.relation as Readonly<Record<string, unknown>>;
    const hasStrength = Object.hasOwn(facet, "strength"),
      state = normalizeLegacyRelationState(facet.state),
      witnessed = Object.hasOwn(facet, "targetObservedVersion");
    if (!hasStrength && state === facet.state && witnessed) return null;
    const { strength: _legacyStrength, ...rest } = facet;
    const targetObservedVersion = witnessed
      ? facet.targetObservedVersion
      : cut.readEntityVersionWitness(String(facet.target)).currentVersion;
    const relation = { ...rest, state, targetObservedVersion };
    const category = [
      hasStrength ? "strength dropped" : null,
      state !== facet.state ? "state normalized" : null,
      witnessed ? null : targetObservedVersion === null ? "witness genesis null" : "witness filled at cut",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      event: { ...event, payload: { ...event.payload, relation } } as CanonicalEventV1,
      category,
      before: facet,
      after: relation,
    };
  },
};

const decisionDigestsMigration: EventShapeMigrationSpec = {
  name: "decision-digests",
  matches: (event) => {
    if (event.schema !== "decision-event/v1") return false;
    const payload = (event as DecisionEventV1).payload as Readonly<Record<string, unknown>>;
    return payload.judgmentConsent !== undefined || payload.contentPin !== undefined;
  },
  rewrite: (event, cut) => {
    if (event.schema !== "decision-event/v1") return null;
    const decision = event as DecisionEventV1,
      payload = decision.payload as Readonly<Record<string, unknown>>;
    const consent = payload.judgmentConsent as Readonly<Record<string, unknown>> | undefined,
      pin = payload.contentPin as Readonly<Record<string, unknown>> | undefined;
    if (consent === undefined && pin === undefined) return null;
    const current = cut.readDecisionDocumentState?.(decision.decisionId);
    if (!current)
      throw new Error(`decision ${decision.decisionId} has no projected state at revision ${event.workspaceRevision}`);
    let next = payload;
    const categories: string[] = [];
    if (consent !== undefined) {
      const machineDigest = decisionMachineDigest(current);
      if (consent.machineDigest !== machineDigest) {
        next = { ...next, judgmentConsent: { ...consent, machineDigest } };
        categories.push("consent machineDigest restamped");
      }
    }
    if (pin !== undefined) {
      const expected = decisionContentPin(
        reduceDecisionDocument(current, decision),
        decision as Parameters<typeof decisionContentPin>[1],
      );
      if (pin.digest !== expected.digest) {
        next = { ...next, contentPin: { ...pin, digest: expected.digest } };
        categories.push("content pin digest restamped");
      }
    }
    if (categories.length === 0) return null;
    return {
      event: { ...event, payload: next } as CanonicalEventV1,
      category: categories.join(", "),
      before: { judgmentConsent: consent, contentPin: pin },
      after: { judgmentConsent: next.judgmentConsent, contentPin: next.contentPin },
    };
  },
};

const SETTINGS_WAL_FLUSH_MIGRATION_VALUE: WalFlushSettingsV1 = Object.freeze({
  adaptive: true,
  events: 256,
  bytes: 8_388_608,
  milliseconds: 3_600_000,
});

function validateHistoricalWalFlush(value: unknown, opId: string): void {
  const schema = SETTINGS_REPOSITORY_V1_SCHEMA.properties.walFlush as EntityJsonObjectSchema,
    errors = validateEntityJsonSchema(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "SettingsWalFlushMigration/v1",
        ...schema,
      },
      value,
      `settings event ${opId} walFlush`,
    );
  if (errors.length > 0) throw new Error(errors.join("; "));
}

export const settingsWalFlushMigration: EventShapeMigrationSpec = {
  name: "settings-wal-flush",
  // The rewrite never reads the cut, so every settings event stays in bulk rounds.
  matches: () => false,
  rewrite: (event) => {
    if (!isSettingsEvent(event) || event.type !== "settings_changed") return null;
    const settings = event.payload.settings as unknown;
    if (settings === null || typeof settings !== "object" || Array.isArray(settings))
      throw new Error(`settings event ${event.opId} settings must be a JSON object`);
    const historical = settings as Readonly<Record<string, unknown>>;
    if (Object.hasOwn(historical, "walFlush")) {
      validateHistoricalWalFlush(historical.walFlush, event.opId);
      return null;
    }
    const migrated = { ...historical, walFlush: SETTINGS_WAL_FLUSH_MIGRATION_VALUE };
    return {
      event: { ...event, payload: { ...event.payload, settings: migrated } } as CanonicalEventV1,
      category: "walFlush filled from declared/default settings",
      before: {
        walFlushPresent: false,
        harnessDocumentClaim: event.payload.harnessDocumentClaim,
      },
      after: {
        walFlush: SETTINGS_WAL_FLUSH_MIGRATION_VALUE,
        harnessDocumentClaim: event.payload.harnessDocumentClaim,
      },
    };
  },
};

// This migration owns exactly one historical break: `spec.target.cwd` (removed in 272de6d16).
// Any other field the current target schema does not declare is a new break that needs its own
// migration, so it is reported instead of being silently absorbed here.
const RETIRED_SCHEDULE_TARGET_FIELDS: ReadonlySet<string> = new Set(["cwd"]);
const scheduleTargetFields = new Set(
  Object.keys(
    (
      (SCHEDULE_DEFINITION_V1_SCHEMA.properties.spec as EntityJsonObjectSchema).properties
        .target as EntityJsonObjectSchema
    ).properties,
  ),
);

function legacyScheduleDefinition(event: CanonicalEventV1): {
  readonly schedule: ScheduleV1 & { readonly spec: { readonly target: Readonly<Record<string, unknown>> } };
  readonly claim: { readonly sha256: string; readonly size: number } | null;
} | null {
  if (event.schema !== "schedule-event/v1") return null;
  const payload = event.payload as unknown as Readonly<Record<string, unknown>>,
    schedule = payload.schedule as ScheduleV1 & {
      readonly spec?: { readonly target?: Readonly<Record<string, unknown>> };
    },
    candidateClaim = payload.declarationDocumentClaim as
      | { readonly sha256?: unknown; readonly size?: unknown }
      | undefined,
    target = schedule?.spec?.target;
  if (!target) return null;
  const claim =
    candidateClaim && typeof candidateClaim.sha256 === "string" && typeof candidateClaim.size === "number"
      ? (candidateClaim as { readonly sha256: string; readonly size: number })
      : null;
  const unknown = Object.keys(target).filter((field) => !scheduleTargetFields.has(field)),
    foreign = unknown.filter((field) => !RETIRED_SCHEDULE_TARGET_FIELDS.has(field));
  if (foreign.length > 0)
    throw new Error(
      `schedule ${schedule.scheduleId} target carries fields this migration does not own: ${foreign.join(", ")}`,
    );
  return unknown.length > 0 ? { schedule: schedule as never, claim } : null;
}

const scheduleDefinitionsMigration: EventShapeMigrationSpec = {
  name: "schedule-definitions",
  // The rewrite never reads the cut, so every schedule event stays in bulk rounds.
  matches: () => false,
  rewrite: (event) => {
    const legacy = legacyScheduleDefinition(event);
    if (legacy === null) return null;
    const target = legacy.schedule.spec.target,
      removed = Object.keys(target).filter((field) => RETIRED_SCHEDULE_TARGET_FIELDS.has(field)),
      nextTarget = Object.fromEntries(
        Object.entries(target).filter(([field]) => !RETIRED_SCHEDULE_TARGET_FIELDS.has(field)),
      ),
      schedule = { ...legacy.schedule, spec: { ...legacy.schedule.spec, target: nextTarget } } as unknown as ScheduleV1,
      definition = scheduleDefinition(schedule),
      body = serializeEntityJsonSchema(SCHEDULE_DEFINITION_V1_SCHEMA, definition, "schedule definition");
    if (
      validateScheduleDefinitionV1(JSON.parse(body)).length > 0 ||
      canonicalJson(JSON.parse(body)) !== canonicalJson(definition)
    )
      throw new Error(`schedule ${schedule.scheduleId} migration did not produce its exact definition facet`);
    const sha256 = sha256Text(body),
      claim = legacy.claim
        ? {
            ...(event.payload as { readonly declarationDocumentClaim: Readonly<Record<string, unknown>> })
              .declarationDocumentClaim,
            sha256,
            size: Buffer.byteLength(body),
          }
        : null,
      payload = {
        ...event.payload,
        schedule,
        ...(claim ? { declarationDocumentClaim: claim } : {}),
      };
    return {
      event: { ...event, payload } as CanonicalEventV1,
      blobs: claim ? [{ sha256, size: claim.size, mediaType: "application/json", body }] : [],
      category: `schedule target fields dropped: ${removed.join(", ")}`,
      before: { target, declarationDocumentClaim: legacy.claim },
      after: { target: nextTarget, declarationDocumentClaim: claim },
    };
  },
};

export const ciWorkflowVerificationMigration = {
  name: "ci-workflow-verification",
  matches: (event: CanonicalEventV1) => String(event.schema) === "ci-run-observation/v1",
  rewrite: (event: CanonicalEventV1) => {
    if (String(event.schema) !== "ci-run-observation/v1") return null;
    const legacyPayload = event.payload as unknown as {
      readonly gates?: readonly { readonly gate: string; readonly pass: boolean; readonly metrics: unknown }[];
    };
    const gates = Array.isArray(legacyPayload.gates)
      ? legacyPayload.gates.map((gate) => ({
          gate: gate.gate,
          result: gate.pass ? "pass" : "fail",
          metrics: gate.metrics,
        }))
      : legacyPayload.gates;
    const rewritten = {
      ...event,
      schema: "ci-run-observation/v2",
      payload: { ...event.payload, gates, verification: null },
    } as CanonicalEventV1;
    const issues = validateCurrentCiRunObservationEvent(rewritten);
    if (issues.length) throw new Error(`Invalid historical CI observation ${event.opId}: ${issues.join("; ")}`);
    return {
      event: rewritten,
      category: "historical CI measurements retained without workflow verification",
      before: { schema: event.schema },
      after: { schema: rewritten.schema, verification: null },
    };
  },
} satisfies EventShapeMigrationSpec;

export const eventShapeMigrations: Readonly<Record<EventShapeMigrationKind, EventShapeMigrationSpec>> = {
  "task-v2-snapshots-migrate": taskV2SnapshotsMigration,
  "legacy-import-normalization-migrate": legacyImportNormalizationMigration,
  "relation-events-migrate": relationEventsMigration,
  "review-submission-pins-migrate": reviewSubmissionPinsMigration,
  "decision-digests-migrate": decisionDigestsMigration,
  "schedule-definitions-migrate": scheduleDefinitionsMigration,
  "settings-wal-flush-migrate": settingsWalFlushMigration,
};

const generationShapeMigrations = [...Object.values(eventShapeMigrations), ciWorkflowVerificationMigration];

/**
 * Plans the generation-0 to generation-1 shape conversion without changing the source store.
 * The replay uses the historical projection cut, so relation witnesses and decision digests are
 * derived from the state that existed immediately before each event.
 */
export function planLegacyGenerationConversion(input: {
  readonly rootDir: string;
  readonly store: CanonicalEventStore;
}): LegacyGenerationConversionPlan {
  const head = input.store.readHead(),
    headRevision = head?.revision ?? 0,
    replayed = replayRewrites(input, headRevision, head);
  return { ...replayed, migrationFamilies: summarizeMigrationFamilies(replayed.rewrites) };
}

export function assertNoPendingHistoricalRewrites(input: {
  readonly rootDir: string;
  readonly store: CanonicalEventStore;
}): void {
  const plan = planLegacyGenerationConversion(input);
  if (plan.rewrites.length === 0) return;
  const first = plan.rewrites[0]!;
  throw new Error(
    `generation activation requires zero pending historical rewrites; found ${plan.rewrites.length}, ` +
      `first is ${first.migration} at revision ${first.revision} (${first.opId})`,
  );
}

const BULK_ROUND_LIMIT = 4096;

function replayRewrites(
  input: { readonly rootDir: string; readonly store: CanonicalEventStore },
  headRevision: number,
  head: ReturnType<CanonicalEventStore["readHead"]>,
): Pick<LegacyGenerationConversionPlan, "events" | "blobs" | "rewrites"> {
  const events: CanonicalEventV1[] = [],
    blobs = new Map<string, CanonicalContentBlob>(),
    rewrites: LegacyGenerationConversionPlan["rewrites"][number][] = [],
    scratchPath = path.join(tmpdir(), `ha-event-shapes-${process.pid}-${Date.now()}.sqlite`),
    pending: CanonicalEventV1[] = [];
  let cursor: string | null = null,
    exhausted = false,
    prefetchContent: ReturnType<CanonicalEventStore["readBatch"]>["prefetchContent"],
    projection: TaskProjection | null = null;
  // Read ahead from the real store until the buffer holds a full bulk round or the stream ends.
  const fill = (): void => {
    while (!exhausted && pending.length < BULK_ROUND_LIMIT) {
      const batch = input.store.readBatch(cursor, BULK_ROUND_LIMIT);
      pending.push(...batch.events);
      cursor = batch.cursor;
      exhausted = batch.done;
      if (batch.prefetchContent) prefetchContent = batch.prefetchContent;
    }
  };
  const migrations = generationShapeMigrations;
  // Each cut-dependent candidate is the first and only event in its batch. TaskProjection applies
  // the previous batch before requesting the next one, so rewrite sees the exact pre-event cut.
  // The stream head remains the real final head, which makes one catchUp settle one state digest.
  const nextBatch = () => {
    fill();
    if (pending.length === 0) return [];
    const candidate = pending.findIndex((event) => migrations.some((migration) => migration.matches(event))),
      count = candidate === 0 ? 1 : Math.min(candidate === -1 ? pending.length : candidate, BULK_ROUND_LIMIT);
    return pending
      .splice(0, count)
      .map((event) => rewriteToFixedPoint(event, projection!, migrations, blobs, rewrites));
  };
  const stream = {
    readHead: () => head,
    readBatch: () => {
      const batch = nextBatch(),
        done = exhausted && pending.length === 0;
      events.push(...batch);
      return {
        sourceRevision: headRevision,
        events: batch,
        cursor: done ? null : String(batch.at(-1)?.workspaceRevision ?? events.length),
        done,
        accessedItems: batch.length,
        prefetchContent: (replay: readonly CanonicalEventV1[]) => {
          const persisted = replay.filter((event) => contentClaims(event).every((claim) => !blobs.has(claim.sha256))),
            generated = [...blobs].map(([sha256, blob]) => [sha256, Buffer.from(blob.body)] as const),
            content = new Map([...(prefetchContent?.(persisted) ?? []), ...generated]);
          return content;
        },
      };
    },
    readContentBlob: (sha256: string) => {
      const generated = blobs.get(sha256);
      return generated ? Buffer.from(generated.body) : input.store.readContentBlob(sha256);
    },
  };
  projection = makeTaskProjection({
    rootDir: input.rootDir,
    eventStore: stream,
    projectionPath: scratchPath,
    catchUpLimit: BULK_ROUND_LIMIT,
  });
  try {
    const round = projection.catchUp!();
    if (round.watermark !== headRevision)
      throw new Error(`event-shape migration replay stalled at revision ${round.watermark} before ${headRevision}`);
  } finally {
    projection.close();
    for (const suffix of ["", "-wal", "-shm"]) localRuntimeStateFileSystem.remove(`${scratchPath}${suffix}`);
  }
  return { events, blobs: [...blobs.values()], rewrites };
}

function rewriteToFixedPoint(
  event: CanonicalEventV1,
  cut: EventShapeCut,
  migrations: readonly EventShapeMigrationSpec[],
  blobs: Map<string, CanonicalContentBlob>,
  rewrites: LegacyGenerationConversionPlan["rewrites"][number][],
): CanonicalEventV1 {
  let current = event;
  const applied = new Set<EventShapeMigrationName>(),
    seen = new Set([canonicalJson(event)]);
  for (let pass = 0; pass <= migrations.length; pass += 1) {
    let changed = false;
    for (const migration of migrations) {
      const rewrite = migration.rewrite(current, cut);
      if (rewrite === null) continue;
      if (applied.has(migration.name)) throw new Error(`${migration.name} is not idempotent for event ${event.opId}`);
      applied.add(migration.name);
      changed = true;
      current = rewrite.event;
      for (const blob of rewrite.blobs ?? []) blobs.set(blob.sha256, blob);
      rewrites.push({
        migration: migration.name,
        opId: event.opId,
        revision: event.workspaceRevision,
        category: rewrite.category,
      });
    }
    if (!changed) return current;
    const state = canonicalJson(current);
    if (seen.has(state)) throw new Error(`event-shape migration cycle for event ${event.opId}`);
    seen.add(state);
  }
  throw new Error(`event-shape migrations did not reach a fixed point for event ${event.opId}`);
}

function summarizeMigrationFamilies(
  rewrites: LegacyGenerationConversionPlan["rewrites"],
): readonly EventShapeMigrationFamilyReport[] {
  return generationShapeMigrations.map(({ name }) => {
    const revisions = rewrites.filter((rewrite) => rewrite.migration === name).map((rewrite) => rewrite.revision);
    return {
      name,
      count: revisions.length,
      firstRevision: revisions.length === 0 ? null : Math.min(...revisions),
      lastRevision: revisions.length === 0 ? null : Math.max(...revisions),
    };
  });
}
