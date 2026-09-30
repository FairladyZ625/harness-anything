import type { EntityActionContract } from "./entity-kind-registry.ts";

export function equals(path: string, value: string | number | boolean) {
  return Object.freeze({ fieldEquals: Object.freeze({ path, value }) });
}
export const all = (...predicates: ReturnType<typeof equals>[]) => Object.freeze({ all: Object.freeze(predicates) });
type StateCoordinate = NonNullable<EntityActionContract["stateTransition"]>["from"][number];
const transition = (
  from: readonly StateCoordinate[],
  to: NonNullable<EntityActionContract["stateTransition"]>["to"],
): NonNullable<EntityActionContract["stateTransition"]> =>
  Object.freeze({ from: Object.freeze(from), to: Object.freeze(to) });

export function stateTransition(id: string): EntityActionContract["stateTransition"] {
  if (id === "create")
    return transition(
      [Object.freeze({ existence: "missing" as const, status: null, currentNode: null })],
      [
        Object.freeze({
          when: null,
          coordinate: Object.freeze({
            existence: "present" as const,
            status: "planned",
            currentNode: "implementation",
          }),
        }),
      ],
    );
  // Lifecycle registry entries carry executable matches/validate/reduce guards, not lossless
  // static coordinates. Omitting their projection prevents the catalog from promising a move
  // before the aggregate has accepted the command.
  return null;
}
