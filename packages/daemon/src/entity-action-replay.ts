import {
  agentRetiredWritePlan,
  entityDeletedWritePlan,
  entityUpsertWritePlan,
  decisionWritePlan,
  isEntityDeclarationEvent,
  type CanonicalEventStore,
  type EntityActionContract,
  type EntityDeletedBundle,
  type EntityUpsertBundle,
  type AgentRetiredBundle,
  type DecisionEventV1,
  type FactEventV1,
} from "@harness-anything/kernel";
import type { RepoTaskAction } from "./repo-cell-types.ts";
import { reject } from "./entity-action-relation.ts";
import { factReplayBundle } from "./fact-supersede-document.ts";
import { matchingRuntimeSessionReplayBundle, type RuntimeSessionBundle } from "./entity-action-runtime-session.ts";

type ExecutableAction = EntityActionContract & { readonly execution: NonNullable<EntityActionContract["execution"]> };
type ReplayBundle =
  | EntityUpsertBundle
  | EntityDeletedBundle
  | AgentRetiredBundle
  | RuntimeSessionBundle
  | ReturnType<typeof factReplayBundle>
  | {
      readonly event: DecisionEventV1;
      readonly plan: ReturnType<typeof decisionWritePlan>;
      readonly blobs: readonly {
        readonly sha256: string;
        readonly size: number;
        readonly mediaType: string;
        readonly body: string;
      }[];
      readonly path: string;
      readonly body: string;
    };

export function matchingReplayBundle(
  store: CanonicalEventStore,
  contract: ExecutableAction,
  action: RepoTaskAction,
  existing: ReturnType<CanonicalEventStore["readEvent"]>,
): ReplayBundle | null {
  const writesFact = contract.target.kind === "fact" || contract.id === "reckon";
  if (contract.target.kind === "runtime-session" && existing !== null)
    return matchingRuntimeSessionReplayBundle(store, contract, action, existing) as unknown as ReplayBundle;
  if (
    existing?.schema === "entity-event/v1" &&
    existing.type === "entity_upserted" &&
    isEntityDeclarationEvent(existing) &&
    existing.payload.entityKind === contract.target.kind
  ) {
    const claim = existing.payload.declarationDocumentClaim,
      bytes = store.readContentBlob(claim.sha256);
    if (!bytes) reject("content_not_ready", `Entity content for ${claim.path} is unavailable.`);
    return {
      event: existing,
      plan: entityUpsertWritePlan(existing),
      blobs: [
        {
          sha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
          body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        },
      ],
    };
  }
  if (
    existing?.schema === "entity-event/v1" &&
    existing.type === "entity_deleted" &&
    existing.payload.entityKind === contract.target.kind
  )
    return { event: existing, plan: entityDeletedWritePlan(existing), blobs: [] };
  if (
    existing?.schema === "entity-event/v1" &&
    existing.type === "agent_retired" &&
    existing.payload.entityKind === contract.target.kind
  )
    return { event: existing, plan: agentRetiredWritePlan(existing), blobs: [] };
  if (existing?.schema === "fact-event/v1" && writesFact)
    return factReplayBundle(store, existing as FactEventV1) as ReplayBundle;
  if (existing?.schema === "decision-event/v1" && !writesFact) {
    const claim = existing.payload.decisionDocumentClaim,
      bytes = store.readContentBlob(claim.sha256);
    if (!bytes) reject("content_not_ready", `Decision content for ${existing.decisionId} is unavailable.`);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      event: existing,
      plan: decisionWritePlan(existing),
      blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body }],
      path: claim.path,
      body,
    };
  }
  return null;
}
