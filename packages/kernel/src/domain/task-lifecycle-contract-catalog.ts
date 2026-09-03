import { EXECUTION_V1_SCHEMA } from "./execution.ts";
import { REVIEW_CONSENT_V1_SCHEMA, REVIEW_V1_SCHEMA } from "./review.ts";
import { TASK_V2_SCHEMA } from "./task.ts";
import { TASK_EDGE_TAKEN_SCHEMA } from "./task-graph.ts";
import { TASK_LIFECYCLE_TRANSITIONS } from "./task-lifecycle-transitions.ts";
import { getTaskActionForTransition } from "./entity-kind-registry.ts";

// CLI-facing catalog, projection fields, and contract descriptor.
export const TASK_LIFECYCLE_COMMAND_CATALOG = Object.freeze(
  [...new Set(TASK_LIFECYCLE_TRANSITIONS.map((value) => value.actionId))].map((actionId) => {
    const action = getTaskActionForTransition(actionId),
      lifecycle = action?.execution?.lifecycle;
    if (!action || !lifecycle) throw new Error(`Task lifecycle transition references undeclared action ${actionId}.`);
    return Object.freeze({
      id: lifecycle.transitionId,
      actionId,
      commandType: lifecycle.commandType,
      from: action.stateTransition?.from ?? [],
      proof: lifecycle.proof,
      eventType: lifecycle.eventType,
      returns: action.returns,
    });
  }),
);
export type TaskLifecycleCliCatalogEntry = (typeof TASK_LIFECYCLE_COMMAND_CATALOG)[number];
export const TASK_LIFECYCLE_PROJECTION_FIELDS = Object.freeze({
  task: TASK_V2_SCHEMA.required,
  execution: EXECUTION_V1_SCHEMA.required,
  review: REVIEW_V1_SCHEMA.required,
  consent: REVIEW_CONSENT_V1_SCHEMA.required,
  edgeTaken: TASK_EDGE_TAKEN_SCHEMA.required,
});
const taskLifecycleContract = Object.freeze({
  id: "task-lifecycle",
  phases: Object.freeze(["P4"]),
  commands: Object.freeze(TASK_LIFECYCLE_COMMAND_CATALOG.map((entry) => Object.freeze({ id: entry.id, phase: "P4" }))),
  gates: Object.freeze([]),
  guards: Object.freeze([]),
  schemas: Object.freeze([
    Object.freeze({
      id: "task-event/v1",
      schema: "packages/kernel/src/domain/task-lifecycle.contract.ts#TASK_EVENT_V1_SCHEMA",
      parser: "packages/kernel/src/domain/task-lifecycle.contract.ts#validateTaskEvent",
      writer: "packages/kernel/src/domain/task-lifecycle.contract.ts#serializeTaskEvent",
      error: "packages/kernel/src/domain/task-lifecycle.contract.ts#TaskLifecycleContractError",
      negativeFixtures: Object.freeze(["tools/gates/test/fixtures/task-event-legacy-shape.json"]),
    }),
  ]),
});
export default taskLifecycleContract;
