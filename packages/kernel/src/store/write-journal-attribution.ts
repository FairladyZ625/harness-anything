import type {
  JournalActor,
  JournaledWriteCoordinatorOptions,
  OperationalActor
} from "./write-journal-types.ts";

export function journalActorFromAttribution(attribution: JournaledWriteCoordinatorOptions["attribution"]): JournalActor {
  const executor = attribution.actor.executor;
  return executor
    ? { kind: "agent", id: executor.id }
    : { kind: "human", id: attribution.actor.principal.personId };
}

export function journalActorFromOperationalActor(actor: OperationalActor): JournalActor {
  return { kind: actor.kind, id: actor.id };
}
