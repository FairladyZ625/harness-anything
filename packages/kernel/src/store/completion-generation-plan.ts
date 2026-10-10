import { validateCiRunObservationEvent } from "../domain/ci-run-observation-event.ts";
import { ciRunObservationV3Migration, ciWorkflowVerificationMigration } from "./event-shape-migration.ts";
import type { CanonicalEventV1 } from "../domain/doc-sync-types.ts";
import {
  serializePersistedCanonicalEvent,
  validateCurrentCanonicalEvent,
} from "../domain/doc-sync-canonical-events.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { canonicalLedgerCut } from "./task-event-store-contract.ts";
import type { SqliteEventStore } from "./sqlite-event-store.ts";
import { convertCompletionSnapshot } from "./offline-completion-snapshots.ts";
import { makeOfflineCompletionChain } from "./offline-completion-chain.ts";
import { completionDocumentConverter } from "./offline-completion-documents.ts";
import { historicalWitness } from "./generation-two-conversion.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";
import type { CanonicalContentBlob } from "./task-event-store-types.ts";
import type { PresetSnapshotClaim } from "../domain/task-bootstrap-event.ts";

/** Raw source rows are available only to the offline converter; online readers require the new shape. */
export function* completionSourceRows(source: SqliteEventStore) {
  let cursor = 0;
  for (;;) {
    const page = source.eventRowPage(cursor, 512);
    yield* page.rows;
    if (page.done) return;
    cursor = page.rows.at(-1)!.revision;
  }
}

export function planCompletionGeneration(source: SqliteEventStore, approvedSnapshotGaps: ReadonlySet<string>) {
  const metadata = source.metadata();
  if (metadata.generation !== 1 && metadata.generation !== 2)
    throw new Error("completion conversion requires a generation 1 or 2 source");
  const sourceCut = {
      ...canonicalLedgerCut(metadata.repoId, source.eventIdentityAtRevision(metadata.revision)),
      generation: metadata.generation as 1 | 2,
    },
    snapshots = new Map<string, ReturnType<typeof convertCompletionSnapshot>>();
  for (const row of completionSourceRows(source)) {
    const event = JSON.parse(row.eventJson) as CanonicalEventV1;
    const claim = (event.payload as { presetSnapshotClaim?: PresetSnapshotClaim }).presetSnapshotClaim;
    if (claim && !snapshots.has(claim.digest)) {
      const bytes = source.readContentObject(claim.sha256);
      if (!bytes) throw new Error(`accepted snapshot claim has no bytes: ${claim.digest}/${claim.sha256}`);
      snapshots.set(claim.digest, convertCompletionSnapshot(claim, bytes));
    }
  }
  function* entries() {
    const mapper = makeOfflineCompletionChain({
        generation: sourceCut.generation,
        snapshots,
        missingSnapshots: approvedSnapshotGaps,
        readContent: source.readContentObject,
      }),
      documents = completionDocumentConverter(source.readContentObject);
    // Cursor increases with every yielded revision; eventRowPage.done ends the stream.
    for (const row of completionSourceRows(source)) {
      const original = JSON.parse(row.eventJson) as CanonicalEventV1;
      // Generation 1's CI shapes use their existing offline rewrite functions. Completion
      // events go directly through this mapper so missing new fields cannot erase a Task.
      const verified =
        metadata.generation === 1 ? (ciWorkflowVerificationMigration.rewrite(original)?.event ?? original) : original;
      const canonical =
        metadata.generation === 1 ? (ciRunObservationV3Migration.rewrite(verified)?.event ?? verified) : verified;
      const converted = mapper.convert(canonical);
      const historicalBlobs: CanonicalContentBlob[] = [];
      let current = converted.event;
      // Gen1 non-completion records retain the existing offline source-witness policy.
      // Completion records must pass their dedicated closure conversion, never become a generic witness.
      if (metadata.generation === 1 && !("task" in original.payload) && original.schema !== "settings-event/v1") {
        const issues =
          current.schema === "ci-run-observation/v3"
            ? validateCiRunObservationEvent(current)
            : validateCurrentCanonicalEvent(current);
        const missing =
          issues.length === 0 &&
          contentClaims(current).some((claim) => {
            const bytes = source.readContentObject(claim.sha256);
            if (bytes && bytes.byteLength !== claim.size) throw new Error(`corrupt accepted content ${claim.sha256}`);
            return bytes === null;
          });
        if (issues.length || missing) {
          current = historicalWitness(original, row, source);
          const entity = current.payload.entity;
          if (entity.kind === "repo-document")
            historicalBlobs.push({ ...entity.documentClaim, body: new TextEncoder().encode(row.eventJson) });
        }
      }
      const rendered = documents(current);
      // Validate newly produced bytes before accepting them in the target ledger.
      const eventJson = serializePersistedCanonicalEvent(rendered.event);
      yield {
        row,
        event: rendered.event,
        eventJson,
        digest: `sha256:${sha256Text(eventJson)}` as const,
        blobs: [...converted.blobs, ...historicalBlobs, ...rendered.blobs],
      };
    }
  }
  return {
    sourceCut,
    entries,
    sourceEvents: metadata.revision,
    snapshotMappings: [...snapshots].map(([from, to]) => ({ from, to: to.claim })),
    historicalSnapshotGaps: [...approvedSnapshotGaps].sort(),
  };
}

export type CompletionGenerationPlan = ReturnType<typeof planCompletionGeneration>;
