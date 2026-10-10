import path from "node:path";
import { stableStringify, sha256Bytes } from "../integrity/stable-hash.ts";
import { makeTaskProjection } from "../projection/rebuildable-task-projection-factory.ts";
import { localRuntimeStateFileSystem as files } from "../local/local-layout-file-system.ts";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { openSqliteEventStore, sqliteLedgerPath, type SqliteEventStore } from "./sqlite-event-store.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";
import type { CanonicalContentBlob } from "./task-event-store-types.ts";
import { completionSourceRows, type CompletionGenerationPlan } from "./completion-generation-plan.ts";

export function writeCompletionGeneration(
  source: SqliteEventStore,
  root: string,
  plan: CompletionGenerationPlan,
): void {
  if (files.exists(sqliteLedgerPath(root, 3))) throw new Error("generation 3 staging ledger already exists");
  const destination = openSqliteEventStore({
      repoId: plan.sourceCut.repoId,
      rootInput: root,
      generation: 3,
      conversionSourceGeneration: plan.sourceCut.generation,
    }),
    fence = {
      repoId: plan.sourceCut.repoId,
      holder: "offline-completion-converter",
      epoch: (source.writerFence()?.epoch ?? 0) + 1,
    },
    entries = plan.entries();
  try {
    destination.claimWriter(fence);
    for (const outcome of source.outcomes()) {
      const members = outcome.memberOpIds.map((opId) => {
        const entry = entries.next().value;
        if (!entry || entry.event.opId !== opId)
          throw new Error(`source outcome ${outcome.opId} does not match converted event ${opId}`);
        return entry;
      });
      const blobs = new Map<string, CanonicalContentBlob>(),
        convertedBlobs = new Map(members.flatMap((entry) => entry.blobs.map((blob) => [blob.sha256, blob] as const)));
      for (const { event } of members)
        for (const claim of contentClaims(event)) {
          const converted = convertedBlobs.get(claim.sha256);
          if (converted) blobs.set(claim.sha256, converted);
          else {
            const body = source.readContentObject(claim.sha256);
            if (!body) throw new Error(`source content ${claim.sha256} is unavailable`);
            blobs.set(claim.sha256, { ...claim, body });
          }
        }
      destination.appendCommand({
        fence,
        intent: { opId: outcome.opId, intentDigest: outcome.intentDigest, summary: outcome.summary },
        events: members.map((entry) => entry.event),
        blobs: [...blobs.values()],
        ...(outcome.rejectionCode === null ? {} : { rejectionCode: outcome.rejectionCode }),
        historicalRecord: {
          recordedAt: outcome.recordedAt,
          eventRecordedAt: members.map((entry) => entry.row.recordedAt),
        },
      });
    }
    if (!entries.next().done) throw new Error("source outcomes do not cover every event");
    destination.releaseWriter(fence);
  } finally {
    destination.close();
  }
}

/** Offline verification checks the converter's first write, never the normal read path. */
export function verifyCompletionGeneration(source: SqliteEventStore, root: string, plan: CompletionGenerationPlan) {
  const destination = openSqliteEventStore({
    repoId: plan.sourceCut.repoId,
    rootInput: root,
    generation: 3,
    readOnly: true,
  });
  try {
    let count = 0;
    const entries = plan.entries();
    for (const row of completionSourceRows(destination)) {
      const expected = entries.next().value;
      count++;
      if (
        !expected ||
        row.eventJson !== expected.eventJson ||
        row.digest !== expected.digest ||
        row.opId !== expected.row.opId ||
        row.revision !== expected.row.revision ||
        row.occurredAt !== expected.row.occurredAt ||
        row.recordedAt !== expected.row.recordedAt
      )
        throw new Error(`converted event differs at revision ${row.revision}`);
      for (const claim of contentClaims(expected.event)) {
        const bytes = destination.readContentObject(claim.sha256);
        if (!bytes || bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256)
          throw new Error(`converted content closure differs: ${claim.sha256}`);
      }
    }
    if (count !== plan.sourceEvents || !entries.next().done) throw new Error("converted prefix is incomplete");
    const outcomes = source.outcomes();
    if (outcomes.length !== destination.outcomes().length) throw new Error("command outcome count differs");
    for (const outcome of outcomes)
      if (stableStringify(outcome) !== stableStringify(destination.outcome(outcome.opId)))
        throw new Error(`command outcome differs: ${outcome.opId}`);
    const projection = makeTaskProjection({
      rootDir: root,
      projectionPath: path.join(root, ".harness", "cache", "completion-conversion-verification.sqlite"),
      eventStore: completionConversionStream(destination),
    });
    try {
      const first = projection.rebuild(),
        second = projection.rebuild();
      if (first.stateDigest !== second.stateDigest || second.watermark !== count)
        throw new Error("generation 3 cold replay differs");
      return { events: count, commandOutcomes: outcomes.length, projection: second };
    } finally {
      projection.close();
    }
  } finally {
    destination.close();
  }
}

export function completionConversionStream(source: SqliteEventStore) {
  return {
    readHead: () => source.eventIdentityAtRevision(source.revision()),
    readContentBlob: source.readContentObject,
    readBatch(cursor: string | null, maxItems: number) {
      const page = source.eventRowPage(Number(cursor ?? 0), maxItems);
      return {
        sourceRevision: source.revision(),
        events: page.rows.map((row) => JSON.parse(row.eventJson) as PersistedCanonicalEventV1),
        cursor: page.done ? null : String(page.rows.at(-1)!.revision),
        done: page.done,
        accessedItems: page.rows.length,
        prefetchContent: (events: readonly PersistedCanonicalEventV1[]) =>
          new Map(
            events.flatMap((event) =>
              contentClaims(event).map((claim) => [claim.sha256, source.readContentObject(claim.sha256)] as const),
            ),
          ),
      };
    },
  };
}
