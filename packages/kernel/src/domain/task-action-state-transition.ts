import type { EntityActionContract } from "./entity-kind-registry.ts";

export function equals(path: string, value: string | number | boolean) {
  return Object.freeze({ fieldEquals: Object.freeze({ path, value }) });
}
export const all = (...predicates: ReturnType<typeof equals>[]) => Object.freeze({ all: Object.freeze(predicates) });
const not = (predicate: ReturnType<typeof equals>) => Object.freeze({ not: predicate });
const coordinate = (
  status: string | null,
  currentNode: string | null,
  extra: Readonly<Record<string, string | null>> = {},
) => Object.freeze({ status, currentNode, ...extra });
type StateCoordinate = NonNullable<EntityActionContract["stateTransition"]>["from"][number];
type StatePredicate = NonNullable<EntityActionContract["stateTransition"]>["to"][number]["when"];
const branch = (state: StateCoordinate, when: StatePredicate = null) => Object.freeze({ when, coordinate: state });
const transition = (
  from: readonly StateCoordinate[],
  to: readonly ReturnType<typeof branch>[],
): NonNullable<EntityActionContract["stateTransition"]> =>
  Object.freeze({ from: Object.freeze(from), to: Object.freeze(to) });

export function stateTransition(id: string): EntityActionContract["stateTransition"] {
  if (id === "create")
    return transition(
      [Object.freeze({ existence: "missing" as const, status: null, currentNode: null })],
      [branch(Object.freeze({ existence: "present" as const, status: "planned", currentNode: "implementation" }))],
    );
  if (id === "start")
    return transition(
      [coordinate("planned", "implementation")],
      [branch(coordinate("active", "implementation", { executionState: "active" }))],
    );
  if (id === "transition") {
    const statuses = ["planned", "active", "blocked", "in_review", "done", "cancelled"];
    return transition(
      statuses.filter((status) => status !== "done").map((status) => coordinate(status, null)),
      statuses.map((status) => branch(coordinate(status, null), equals("input.status", status))),
    );
  }
  if (id === "submit")
    return transition(
      [
        coordinate("active", "implementation", { executionState: "active" }),
        coordinate("submitted", "review", { executionState: "submitted" }),
        coordinate("in_review", "review", { executionState: "submitted" }),
      ],
      [
        branch(coordinate("submitted", "review", { executionState: "submitted" }), equals("input.amend", true)),
        branch(coordinate("submitted", "review", { executionState: "submitted" }), not(equals("input.amend", true))),
      ],
    );
  if (id === "adjudicate")
    return transition(
      [
        coordinate("submitted", "review", { executionState: "submitted" }),
        coordinate("in_review", "review", { executionState: "submitted" }),
      ],
      [
        branch(coordinate("in_review", "review", { executionState: "submitted" }), equals("input.forward", true)),
        branch(
          coordinate("active", "implementation", { executionState: "changes_requested" }),
          equals("input.return", true),
        ),
      ],
    );
  if (id === "review")
    // A changes_requested verdict reports to the adjudicating owner; the cut stays at the gate.
    return unchanged("in_review", "review", "submitted");
  if (id === "consent" || id === "reconcile") return unchanged("in_review", "review", "submitted");
  if (id === "repoint") return unchanged("done", "review", "accepted");
  if (id === "complete")
    return transition(
      [
        Object.freeze({
          status: "in_review",
          currentNode: "review",
          executionState: "submitted",
          readiness: "ready" as const,
        }),
      ],
      [branch(coordinate("done", "review", { executionState: "accepted" }))],
    );
  return null;
}

function unchanged(status: string, currentNode: string, executionState: string) {
  const state = coordinate(status, currentNode, { executionState });
  return transition([state], [branch(state)]);
}
