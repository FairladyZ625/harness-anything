import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decisionContentPin,
  decisionMachineDigest,
  eventObjectRelativePath,
  isMigrationImportEvent,
  isRelationEvent,
  ledgerGitPath,
  makeTaskProjection,
  migrationImportWritePlan,
  reduceDecisionDocument,
  resolveLedgerGitLayout,
  serializePersistedCanonicalEvent,
  sha256Text,
  type CanonicalEventStore,
  type CanonicalEventV1,
  type DecisionEventV1,
  type MigrationImportEventV1,
  type PublicationFile,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { readFactRekeyEvents } from "./fact-rekey-event-read.ts";

// One-shot history upcasts. A migrating replay walks the ledger one revision at a time into a
// scratch projection; each event is rewritten against the projection state at its own cut and
// the rewritten event is what the scratch projection applies. The rewrites are then published
// atomically as rewritten event objects alongside a migration marker, the same publication
// shape `fact-rekey` uses, so the ledger head and commit are produced by the store.
export type EventShapeMigrationName = "relation-events" | "decision-digests";
export interface EventShapeRewrite {
  readonly event: CanonicalEventV1;
  readonly category: string;
  readonly before: unknown;
  readonly after: unknown;
}
export interface EventShapeMigrationSpec {
  readonly name: EventShapeMigrationName;
  readonly rewrite: (event: CanonicalEventV1, projection: TaskProjection) => EventShapeRewrite | null;
}

const RELATION_STATES = new Set(["active", "retired"]);
function upcastRelationState(state: unknown): "active" | "retired" {
  if (state === "edge_retired") return "retired";
  if (typeof state === "string" && RELATION_STATES.has(state)) return state as "active" | "retired";
  throw new Error(`relation history state is invalid: ${String(state)}`);
}

export const relationEventsMigration: EventShapeMigrationSpec = {
  name: "relation-events",
  rewrite: (event, projection) => {
    if (isMigrationImportEvent(event)) {
      const entity = event.payload.entity;
      if (entity.kind !== "relation") return null;
      const state = upcastRelationState(entity.relation.state);
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
      state = upcastRelationState(facet.state),
      witnessed = Object.hasOwn(facet, "targetObservedVersion");
    if (!hasStrength && state === facet.state && witnessed) return null;
    const { strength: _legacyStrength, ...rest } = facet;
    const targetObservedVersion = witnessed
      ? facet.targetObservedVersion
      : projection.readEntityVersionWitness(String(facet.target)).currentVersion;
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

export const decisionDigestsMigration: EventShapeMigrationSpec = {
  name: "decision-digests",
  rewrite: (event, projection) => {
    if (event.schema !== "decision-event/v1") return null;
    const decision = event as DecisionEventV1,
      payload = decision.payload as Readonly<Record<string, unknown>>;
    const consent = payload.judgmentConsent as Readonly<Record<string, unknown>> | undefined,
      pin = payload.contentPin as Readonly<Record<string, unknown>> | undefined;
    if (consent === undefined && pin === undefined) return null;
    const current = projection.readDecisionDocumentState?.(decision.decisionId);
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

export function runEventShapeMigration(input: {
  readonly spec: EventShapeMigrationSpec;
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly rootDir: string;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
}): WriteReceipt {
  const { spec, store } = input,
    head = store.readHead(),
    headRevision = head?.revision ?? 0,
    gitRevision = readFactRekeyEvents(input.rootDir, store).events.reduce(
      (max, event) => Math.max(max, event.workspaceRevision),
      0,
    ),
    rewrites = replayRewrites(input, headRevision, head),
    report = migrationReport(spec.name, headRevision, gitRevision, rewrites),
    reportBody = `${JSON.stringify(report, null, 2)}\n`,
    digest = sha256Text(reportBody),
    markerOpId = `op_${sha256Text(`${spec.name}\0${digest}`)}`,
    revision = headRevision;
  if (input.action.dryRun === true || rewrites.length === 0)
    return {
      outcome: "pending",
      opId: `preview:${markerOpId}`,
      revision,
      evidence: JSON.stringify(report),
      visibility: "center",
      proof: {
        committedRevision: revision,
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
    actor: input.binding.actor,
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
          sha256: sha256Text(reportBody),
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
      blobs: [
        {
          sha256: sha256Text(reportBody),
          size: Buffer.byteLength(reportBody),
          mediaType: "application/json",
          body: reportBody,
        },
      ],
      preceding: [],
    },
    [...additional.values()],
  );
  input.projection.rebuild();
  const projected = input.projection.list();
  return {
    outcome: "applied",
    opId: marker.opId,
    revision: appended.revision,
    evidence: JSON.stringify(report),
    visibility: "center",
    proof: {
      committedRevision: appended.revision,
      appliedCut: projected.watermark,
      durable: true,
      canonicalVisible: projected.watermark >= appended.revision,
      worktreeVisible: true,
    },
    commitSha: appended.commitSha?.sha ?? null,
    cut: appended.cut,
  };
}

function replayRewrites(
  input: { readonly spec: EventShapeMigrationSpec; readonly rootDir: string; readonly store: CanonicalEventStore },
  headRevision: number,
  head: ReturnType<CanonicalEventStore["readHead"]>,
): readonly EventShapeRewrite[] {
  const rewrites: EventShapeRewrite[] = [],
    scratchDir = mkdtempSync(path.join(tmpdir(), `ha-${input.spec.name}-`)),
    scratchPath = path.join(scratchDir, "projection.sqlite");
  let cap = 0,
    cursor: string | null = null,
    projection: TaskProjection | null = null;
  const stream = {
    readHead: () =>
      cap >= headRevision
        ? head
        : { revision: cap, eventDigest: `sha256:${sha256Text(`event-shape-migration:${cap}`)}` as `sha256:${string}` },
    readBatch: () => {
      const batch = input.store.readBatch(cursor, 1);
      cursor = batch.cursor;
      const events = batch.events
        .filter((event) => event.workspaceRevision <= cap)
        .map((event) => {
          const rewrite = input.spec.rewrite(event, projection!);
          if (rewrite === null) return event;
          rewrites.push(rewrite);
          return rewrite.event;
        });
      return {
        sourceRevision: cap,
        events,
        cursor: null,
        done: true,
        accessedItems: batch.accessedItems,
        ...(batch.prefetchContent ? { prefetchContent: batch.prefetchContent } : {}),
      };
    },
    readContentBlob: (sha256: string) => input.store.readContentBlob(sha256),
  };
  projection = makeTaskProjection({
    rootDir: input.rootDir,
    eventStore: stream,
    projectionPath: scratchPath,
    catchUpLimit: 1,
  });
  try {
    for (cap = 1; cap <= headRevision; cap += 1) {
      const round = projection.catchUp!();
      if (round.watermark !== cap)
        throw new Error(`${input.spec.name} migrating replay stalled at revision ${round.watermark} before ${cap}`);
    }
  } finally {
    projection.close();
    rmSync(scratchDir, { recursive: true, force: true });
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
