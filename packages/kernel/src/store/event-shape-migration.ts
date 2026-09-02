import { tmpdir } from "node:os";
import path from "node:path";
import type { ActorIdentity } from "../domain/actor-identity.ts";
import {
  decisionContentPin,
  decisionMachineDigest,
  reduceDecisionDocument,
} from "../domain/decision-event-document.ts";
import type { DecisionEventV1 } from "../domain/decision-event-types.ts";
import { serializePersistedCanonicalEvent } from "../domain/doc-sync-canonical-events.ts";
import type { CanonicalEventV1 } from "../domain/doc-sync-types.ts";
import {
  isMigrationImportEvent,
  migrationImportWritePlan,
  type MigrationImportEventV1,
} from "../domain/migration-import-event.ts";
import { normalizeLegacyRelationState } from "../domain/entity-relation.ts";
import type { WriteReceiptDraft } from "../domain/receipt-domain-registry.ts";
import { isRelationEvent } from "../domain/relation-event.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { eventObjectRelativePath } from "../layout/ledger-object-layout.ts";
import { makeTaskProjection } from "../projection/rebuildable-task-projection-factory.ts";
import type { TaskProjection } from "../projection/task-projection-port.ts";
import { ledgerGitPath, resolveLedgerGitLayout } from "./ledger-git-layout.ts";
import type { CanonicalEventStore, PublicationFile } from "./task-event-store-types.ts";

// One-shot history upcasts. A migrating replay walks the ledger into a scratch projection:
// candidates (`matches`) are replayed alone so each is rewritten against the projection state at
// its own cut, everything between them is caught up in bulk rounds, and the rewritten event is
// what the scratch projection applies. The rewrites are then published
// atomically as rewritten event objects alongside a migration marker, the same publication
// shape `fact-rekey` uses, so the ledger head and commit are produced by the store. The live
// projection is left alone: every rewrite is, by construction, what the projection already
// derived, so it only has to catch up the marker. Cold rebuilds are proved separately.
export type EventShapeMigrationName = "relation-events" | "decision-digests";
export type EventShapeMigrationKind = "relation-events-migrate" | "decision-digests-migrate";
export interface EventShapeRewrite {
  readonly event: CanonicalEventV1;
  readonly category: string;
  readonly before: unknown;
  readonly after: unknown;
}
export type EventShapeCut = Pick<TaskProjection, "readEntityVersionWitness" | "readDecisionDocumentState">;
export interface EventShapeMigrationSpec {
  readonly name: EventShapeMigrationName;
  // Pure on the event: true for every event whose `rewrite` reads the cut. Only these are replayed
  // one revision at a time; every other event is rewritten inside bulk rounds, so a rewrite may
  // touch `cut` only when `matches` is true for that event.
  readonly matches: (event: CanonicalEventV1) => boolean;
  readonly rewrite: (event: CanonicalEventV1, cut: EventShapeCut) => EventShapeRewrite | null;
}
export interface EventShapeMigrationInput {
  readonly dryRun: boolean;
  readonly actor: ActorIdentity;
  readonly rootDir: string;
  readonly store: CanonicalEventStore;
  readonly now: () => string;
}

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

export const eventShapeMigrations: Readonly<Record<EventShapeMigrationKind, EventShapeMigrationSpec>> = {
  "relation-events-migrate": relationEventsMigration,
  "decision-digests-migrate": decisionDigestsMigration,
};

export async function runEventShapeMigration(
  spec: EventShapeMigrationSpec,
  input: EventShapeMigrationInput,
): Promise<WriteReceiptDraft> {
  const { store } = input;
  if (!input.dryRun) await store.settlePendingMaterialization?.(`${spec.name} migration`);
  const head = store.readHead(),
    headRevision = head?.revision ?? 0,
    gitRevision = store.revisionAt(store.currentCommit()) ?? 0,
    rewrites = replayRewrites(spec, input, headRevision, head),
    report = migrationReport(spec.name, headRevision, gitRevision, rewrites),
    reportBody = `${JSON.stringify(report, null, 2)}\n`,
    digest = sha256Text(reportBody),
    markerOpId = `op_${sha256Text(`${spec.name}\0${digest}`)}`;
  if (input.dryRun || rewrites.length === 0)
    return {
      outcome: "pending",
      opId: `preview:${markerOpId}`,
      revision: headRevision,
      evidence: JSON.stringify(report),
      visibility: "center",
      proof: {
        committedRevision: headRevision,
        appliedCut: 0,
        durable: false,
        canonicalVisible: false,
        worktreeVisible: false,
      },
      nextAction:
        rewrites.length === 0
          ? `Nothing to migrate: every event already has the current ${spec.name} shape.`
          : `Remove --dry-run to publish the ${spec.name} migration through the canonical event store.`,
    };
  if (gitRevision !== headRevision)
    throw new Error(
      `${spec.name} migration requires the WAL to be settled into Git first (head ${headRevision}, Git ${gitRevision})`,
    );
  const ledger = resolveLedgerGitLayout(input.rootDir),
    eventLayout = store.layout();
  if (eventLayout === "mixed") throw new Error(`${spec.name} migration requires a single flat or sharded event layout`);
  const additional = new Map<string, PublicationFile>();
  for (const rewrite of rewrites) {
    const target = ledgerGitPath(ledger, eventObjectRelativePath(rewrite.event.opId, eventLayout));
    additional.set(target, { target, body: serializePersistedCanonicalEvent(rewrite.event), mode: "100644" });
  }
  const marker: MigrationImportEventV1 = {
    schema: "migration-import-event/v1",
    eventId: `event-${sha256Text(markerOpId)}`,
    workspaceRevision: headRevision + 1,
    opId: markerOpId,
    type: "entity_migrated",
    actor: input.actor,
    source: "migration-import/v1",
    occurredAt: input.now(),
    payload: {
      migratedFrom: `${spec.name}:${digest}`,
      generation: "v0",
      entity: {
        kind: "id-map",
        importId: `${spec.name}-${digest.slice(0, 16)}`,
        documentClaim: {
          path: `migrations/${spec.name}/${digest.slice(0, 16)}/report.json`,
          sha256: digest,
          size: Buffer.byteLength(reportBody),
          mediaType: "application/json",
          policyId: "typed-migration-import/v1",
        },
      },
    },
  };
  const appended = store.append(
    {
      event: marker,
      plan: migrationImportWritePlan(marker),
      blobs: [{ sha256: digest, size: Buffer.byteLength(reportBody), mediaType: "application/json", body: reportBody }],
      preceding: [],
    },
    [...additional.values()],
  );
  return {
    outcome: "applied",
    opId: marker.opId,
    revision: appended.revision,
    evidence: JSON.stringify(report),
    visibility: "center",
    proof: {
      committedRevision: appended.revision,
      appliedCut: appended.revision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: true,
    },
    commitSha: appended.commitSha?.sha ?? null,
    cut: appended.cut,
    nextAction:
      `Published ${rewrites.length} rewritten events under marker revision ${appended.revision}. ` +
      "Apply every remaining event-shape migration, then prove the cold rebuild with `ha daemon projection rebuild`.",
  };
}

const BULK_ROUND_LIMIT = 4096;

function replayRewrites(
  spec: EventShapeMigrationSpec,
  input: EventShapeMigrationInput,
  headRevision: number,
  head: ReturnType<CanonicalEventStore["readHead"]>,
): readonly EventShapeRewrite[] {
  const rewrites: EventShapeRewrite[] = [],
    scratchPath = path.join(tmpdir(), `ha-${spec.name}-${process.pid}-${Date.now()}.sqlite`),
    pending: CanonicalEventV1[] = [];
  let cap = 0,
    cursor: string | null = null,
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
  // Every migration's rewrite is applied to the scratch projection so it stays valid past shapes
  // the other migrations own (a decision digest is derived over rewritten relations, and the
  // strict reducer rejects both legacy shapes); only the requested migration's rewrites are
  // reported and published.
  const migrations = Object.values(eventShapeMigrations);
  // A round ends at the next candidate when it is the next event (so its rewrite sees the
  // projection at revision-1), otherwise right before it or after a full bulk round; with no
  // events left it ends at the head.
  const nextCap = (): number => {
    fill();
    if (pending.length === 0) return headRevision;
    const candidate = pending.findIndex((event) => migrations.some((migration) => migration.matches(event))),
      count = candidate === 0 ? 1 : Math.min(candidate === -1 ? pending.length : candidate, BULK_ROUND_LIMIT);
    return pending[count - 1]!.workspaceRevision;
  };
  const stream = {
    readHead: () =>
      cap >= headRevision
        ? head
        : { revision: cap, eventDigest: `sha256:${sha256Text(`event-shape-migration:${cap}`)}` as `sha256:${string}` },
    readBatch: () => {
      const beyond = pending.findIndex((event) => event.workspaceRevision > cap),
        events = pending.splice(0, beyond === -1 ? pending.length : beyond).map((event) => {
          let current = event;
          for (const migration of migrations) {
            const rewrite = migration.rewrite(current, projection!);
            if (rewrite === null) continue;
            if (migration === spec) rewrites.push(rewrite);
            current = rewrite.event;
          }
          return current;
        });
      return {
        sourceRevision: cap,
        events,
        cursor: null,
        done: true,
        accessedItems: events.length,
        ...(prefetchContent ? { prefetchContent } : {}),
      };
    },
    readContentBlob: (sha256: string) => input.store.readContentBlob(sha256),
  };
  projection = makeTaskProjection({
    rootDir: input.rootDir,
    eventStore: stream,
    projectionPath: scratchPath,
    catchUpLimit: BULK_ROUND_LIMIT,
  });
  try {
    let watermark = 0;
    while (watermark < headRevision) {
      cap = nextCap();
      const round = projection.catchUp!();
      if (round.watermark !== cap)
        throw new Error(`${spec.name} migrating replay stalled at revision ${round.watermark} before ${cap}`);
      watermark = cap;
    }
  } finally {
    projection.close();
    for (const suffix of ["", "-wal", "-shm"]) localRuntimeStateFileSystem.remove(`${scratchPath}${suffix}`);
  }
  return rewrites;
}

function migrationReport(
  name: EventShapeMigrationName,
  headRevision: number,
  gitRevision: number,
  rewrites: readonly EventShapeRewrite[],
) {
  const counts: Record<string, number> = {};
  for (const rewrite of rewrites) counts[rewrite.category] = (counts[rewrite.category] ?? 0) + 1;
  return {
    schema: "event-shape-migration-report/v1",
    migration: name,
    sourceRevision: headRevision,
    gitRevision,
    walPendingRevisions: headRevision - gitRevision,
    rewrittenEvents: rewrites.length,
    categories: counts,
    samples: rewrites.slice(0, 5).map((rewrite) => ({
      opId: rewrite.event.opId,
      workspaceRevision: rewrite.event.workspaceRevision,
      type: rewrite.event.type,
      category: rewrite.category,
      before: rewrite.before,
      after: rewrite.after,
    })),
  };
}
