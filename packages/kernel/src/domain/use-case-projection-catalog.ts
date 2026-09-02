import { entityKindContracts } from "./entity-kind-registry.ts";
import type { RelationType } from "./entity-relation.ts";

/**
 * The second read-contract layer of dec_5B135F46D96703B8951EED9606 CH4: one named use-case
 * projection per GUI view use case, each carrying the authoritative derived judgment that view
 * renders (capabilities, rejection reasons, nextActions, liveness) so the renderer stops deriving
 * it locally. Object Projections (stable entity facts) and Query Functions (cross-entity
 * aggregation) are the other two layers and stay on their own reads.
 *
 * CH2 is the negative criterion this file is written against: an entry declares only what is
 * projected and who consumes it. Transport truth — method, path, commandClass, auth, lease — stays
 * solely in the daemon's `daemonGuiReadMethods`, and `useCaseProjectionEntryKeys` below is asserted
 * by contract test so a transport dimension cannot be added here without turning that test red.
 *
 * `entityKinds` is the only input a definition spells out. Relation types are never hand-listed:
 * `deriveUseCaseProjectionInputs` reads them back off `entityKindContracts`, so a projection can
 * only ever claim relations the kind registry actually declares.
 */

export const useCaseProjectionNames = Object.freeze([
  "schedule-plane",
  "schedule-run-history",
  "runtime-session-groups",
  "task-board-rows",
] as const);

export type UseCaseProjectionName = (typeof useCaseProjectionNames)[number];

/** The exact key set a catalog entry may carry. Asserted by contract test; see CH2 above. */
export const useCaseProjectionEntryKeys = Object.freeze([
  "name",
  "entityKinds",
  "outputSchemaId",
  "version",
  "consumers",
] as const);

export interface UseCaseProjectionDefinition {
  readonly name: UseCaseProjectionName;
  /** Kind ids this projection reads. Every one must exist in `entityKindContracts`. */
  readonly entityKinds: readonly string[];
  readonly outputSchemaId: string;
  readonly version: number;
  /** Renderer view files that consume this projection. One use-case projection per view. */
  readonly consumers: readonly string[];
}

/** Inputs resolved against the kind registry rather than restated by hand. */
export interface UseCaseProjectionInputs {
  readonly entityKinds: readonly string[];
  readonly relationTypes: readonly RelationType[];
}

export const useCaseProjectionCatalog: readonly UseCaseProjectionDefinition[] = Object.freeze([
  {
    name: "schedule-plane",
    entityKinds: ["schedule"],
    outputSchemaId: "daemon.use-case-projection/v1",
    version: 1,
    consumers: ["views/SchedulesView.tsx", "views/EntitiesView.tsx", "views/GraphView.tsx"],
  },
  {
    name: "schedule-run-history",
    entityKinds: ["schedule"],
    outputSchemaId: "daemon.use-case-projection/v1",
    version: 1,
    consumers: ["views/ScheduleDetailView.tsx"],
  },
  {
    // Grouping is the judgment: the daemon decides which sessions belong to which task, squad,
    // agent or day, so the renderer paints lanes instead of re-deriving membership.
    name: "runtime-session-groups",
    entityKinds: ["runtime-session", "task", "squad", "agent"],
    outputSchemaId: "daemon.use-case-projection/v1",
    version: 1,
    consumers: ["views/SessionsView.tsx", "views/AgentSquadView.tsx"],
  },
  {
    // Column placement, archive visibility and per-row action affordances for the task plane.
    // The judgments themselves are `domain/task-board-projection.ts`; this entry is only the
    // registration that makes the kernel — not the renderer — their authority face.
    name: "task-board-rows",
    entityKinds: ["task"],
    outputSchemaId: "daemon.use-case-projection/v1",
    version: 1,
    consumers: [
      "views/BoardView.tsx",
      "views/ListView.tsx",
      "views/SwimlaneBoard.tsx",
      "components/TaskControlPanel.tsx",
    ],
  },
] as const satisfies readonly UseCaseProjectionDefinition[]);

export function getUseCaseProjection(name: UseCaseProjectionName): UseCaseProjectionDefinition {
  const definition = useCaseProjectionCatalog.find((entry) => entry.name === name);
  if (!definition) throw new Error(`Unknown use-case projection: ${name}`);
  return definition;
}

/**
 * Kind ids the catalog claims that the entity-kind registry does not declare. The contract test
 * asserts this is empty, so a projection naming a kind the registry never registered goes red at
 * the declaration instead of failing at read time.
 */
export function useCaseProjectionKindGaps(): readonly string[] {
  const registered = new Set<string>(entityKindContracts.map((contract) => contract.kind));
  const gaps = new Set<string>();
  for (const entry of useCaseProjectionCatalog)
    for (const kind of entry.entityKinds) if (!registered.has(kind)) gaps.add(kind);
  return Object.freeze([...gaps].sort());
}

/**
 * Resolve a projection's inputs from the authority face. `entityKinds` is echoed back in registry
 * order; `relationTypes` is derived from each kind contract's declared relation edges, deduplicated
 * and sorted. Nothing here restates the registry.
 */
export function deriveUseCaseProjectionInputs(name: UseCaseProjectionName): UseCaseProjectionInputs {
  const claimed = new Set<string>(getUseCaseProjection(name).entityKinds);
  const contracts = entityKindContracts.filter((contract) => claimed.has(contract.kind));
  const missing = [...claimed].filter((kind) => !contracts.some((contract) => contract.kind === kind));
  if (missing.length > 0)
    throw new Error(
      `Use-case projection ${name} names kinds absent from the entity kind registry: ${missing.join(", ")}.`,
    );
  const relationTypes = new Set<RelationType>();
  for (const contract of contracts) for (const edge of contract.relations.edges) relationTypes.add(edge.type);
  return Object.freeze({
    entityKinds: Object.freeze(contracts.map((contract) => contract.kind)),
    relationTypes: Object.freeze([...relationTypes].sort()),
  });
}
