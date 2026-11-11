import type { FactEventPayload, FactEventV1 } from "./fact-event.ts";
import { factLiveness, type FactLivenessRelation } from "./fact-liveness.ts";

export interface FactAdmissionState {
  readonly row: (FactEventPayload & { readonly taskId?: string; readonly archived?: boolean }) | null;
  readonly domainTypes: readonly { readonly domainType: string }[];
  readonly supersededTarget: { readonly ref: string } | null;
  readonly relations: readonly FactLivenessRelation[];
}

export class FactProjectionError extends Error {
  readonly code:
    | "content_not_ready"
    | "invalid_transition"
    | "entity_not_found"
    | "anchor_not_found"
    | "fact_type_unregistered"
    | "relation_invalid";
  constructor(code: FactProjectionError["code"], message: string) {
    super(message);
    this.name = "FactProjectionError";
    this.code = code;
  }
}

export function assertFactAdmissionAtCut(
  state: FactAdmissionState,
  event: Pick<FactEventV1, "factId" | "taskId" | "type" | "payload">,
): void {
  const ownRef = `fact/${event.factId}`,
    row = state.row;
  if (event.type === "fact_archived" || event.type === "fact_unarchived") {
    if (!row) fail("entity_not_found", `Fact ${ownRef} does not exist.`);
    if (event.type === "fact_archived" && row.archived === true)
      fail("invalid_transition", `Fact ${ownRef} is already archived.`);
    if (event.type === "fact_unarchived" && row.archived !== true)
      fail("invalid_transition", `Fact ${ownRef} is not archived.`);
    return;
  }
  if (event.type === "fact_recorded" && row) fail("invalid_transition", `Fact ${ownRef} already exists.`);
  if (event.type === "fact_reclassified") {
    if (!row) fail("entity_not_found", `Fact ${ownRef} does not exist.`);
    if (row.archived === true)
      fail("invalid_transition", `Fact ${ownRef} is archived; unarchive it before reclassifying.`);
    if (
      row.taskId !== event.taskId ||
      row.statement !== event.payload.statement ||
      row.evidenceSource !== event.payload.evidenceSource ||
      row.observedAt !== event.payload.observedAt ||
      row.observedCommit !== event.payload.observedCommit ||
      row.confidence !== event.payload.confidence ||
      row.memoryClass !== event.payload.memoryClass ||
      JSON.stringify(row.memoryTags) !== JSON.stringify(event.payload.memoryTags)
    )
      fail("invalid_transition", `Fact ${ownRef} reclassification changed observation data.`);
  }
  if (
    event.payload.registersDomainType &&
    state.domainTypes.some(({ domainType }) => domainType === event.payload.registersDomainType)
  )
    fail("invalid_transition", `Fact domain type ${event.payload.registersDomainType} is already registered.`);
  for (const domainType of event.payload.domainTypes ?? [])
    if (!state.domainTypes.some((row) => row.domainType === domainType)) {
      const registered = state.domainTypes.map(({ domainType: value }) => value).join(", ");
      fail(
        "fact_type_unregistered",
        `Fact domain type ${domainType} is not registered. Registered: ${registered || "none yet"}.`,
      );
    }
  const supersedes = event.payload.supersedes,
    target = state.supersededTarget;
  if (supersedes && target && factLiveness(target, state.relations) === "superseded_fact")
    fail("relation_invalid", `Superseded endpoint ${supersedes.factRef} is already superseded.`);
}

function fail(code: FactProjectionError["code"], message: string): never {
  throw new FactProjectionError(code, message);
}
