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

export function supersededFactDocumentSource(
  projection: Pick<TaskProjection, "readFact">,
  event: FactEventDraftV1,
): SupersededFactDocumentSource | null {
  const factId = /^fact\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(event.payload.supersedes?.factRef ?? "")?.[1];
  if (!factId) return null;
  const fact = projection.readFact(factId).fact;
  if (fact === null) return null;
  return {
    factId: fact.factId,
    ...(fact.taskId ? { taskId: fact.taskId } : {}),
    statement: fact.statement,
    evidenceSource: fact.evidenceSource,
    observedAt: fact.observedAt,
    confidence: fact.confidence,
  };
}

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
  if (existing.type === "fact_archived") {
    const retirement = existing.payload.factsDocumentRetirement!;
    return { event: existing, plan: factWritePlan(existing), blobs: [], path: retirement.path, body: "" };
  }
  const claim = existing.payload.factsDocumentClaim!,
    supersededClaim = existing.payload.supersededFactsDocumentClaim,
    body = factDocumentBody(store, claim.sha256, claim.path);
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
