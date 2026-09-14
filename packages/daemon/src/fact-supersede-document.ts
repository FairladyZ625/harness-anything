import type {
  CanonicalEventStore,
  FactContentBlob,
  FactEventDraftV1,
  FactEventV1,
  FrozenWritePlan,
  SupersededFactDocumentSource,
  TaskProjection,
} from "../../kernel/src/index.ts";
import { factWritePlan } from "../../kernel/src/index.ts";
import { reject } from "./entity-action-write-helpers.ts";

/** Reads the Fact a draft supersedes so the same event can rewrite its disk document. */
export function supersededFactDocumentSource(
  projection: Pick<TaskProjection, "readFact">,
  event: FactEventDraftV1,
): SupersededFactDocumentSource | null {
  const factId = /^fact\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(event.payload.supersedes?.factRef ?? "")?.[1];
  if (!factId) return null;
  const fact = projection.readFact(factId).fact;
  // A dangling supersedes ref audits a missing endpoint: there is no document to rewrite.
  if (fact === null) return null;
  return {
    factId: fact.factId,
    statement: fact.statement,
    evidenceSource: fact.evidenceSource,
    observedAt: fact.observedAt,
    confidence: fact.confidence,
    workspaceRevision: fact.workspaceRevision,
  };
}

/** Rebuilds a persisted Fact event's write bundle, including its superseded-document rewrite. */
export function factReplayBundle(
  store: Pick<CanonicalEventStore, "readContentBlob">,
  existing: FactEventV1,
): {
  readonly event: FactEventV1;
  readonly plan: FrozenWritePlan<"FactRecord">;
  readonly blobs: readonly FactContentBlob[];
  readonly path: string;
  readonly body: string;
} {
  const claim = existing.payload.factsDocumentClaim,
    supersededClaim = existing.payload.supersededFactsDocumentClaim ?? null,
    bytes = store.readContentBlob(claim.sha256);
  if (!bytes) reject("content_not_ready", `Facts content for ${existing.taskId} is unavailable.`);
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return {
    event: existing,
    plan: factWritePlan(existing),
    blobs: [
      { sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body },
      ...(supersededClaim
        ? [
            {
              sha256: supersededClaim.sha256,
              size: supersededClaim.size,
              mediaType: supersededClaim.mediaType,
              body: factDocumentBody(store, supersededClaim.sha256, supersededClaim.path),
            },
          ]
        : []),
    ],
    path: claim.path,
    body,
  };
}

function factDocumentBody(store: Pick<CanonicalEventStore, "readContentBlob">, sha256: string, path: string): string {
  const bytes = store.readContentBlob(sha256);
  if (!bytes) reject("content_not_ready", `Facts content for ${path} is unavailable.`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
