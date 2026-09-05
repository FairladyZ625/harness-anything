import { parseSquadDeclarationV1, type SquadDeclarationV1 } from "./agent-squad-schema.ts";
import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";
import {
  attributeEntityActionCriterion,
  type EntityActionCompileHook,
  type EntityActionCompileInput,
} from "./entity-action-execution.ts";
import { assertTransitionDocumentReady, requireTransitionDocumentKind } from "./transition-document-readiness.ts";

export const squadActionIds = Object.freeze([
  "install",
  "validate",
  "list",
  "inspect",
  "run",
  "status",
  "cancel",
] as const);
export type SquadActionId = (typeof squadActionIds)[number];

export interface SquadActionDraft {
  readonly kind: "entity";
  readonly entityKind: "squad";
  readonly entity: SquadDeclarationV1;
}

const input = (fields: readonly EntityActionInputField[]): EntityActionInputContract =>
  Object.freeze({
    schema: "entity-action-input/v1",
    fields: Object.freeze(fields.map((field) => Object.freeze(field))),
    exactlyOneOf: Object.freeze([]),
  });
const field = (
  name: string,
  type: EntityActionInputField["type"] = "string",
  required = false,
): EntityActionInputField => Object.freeze({ field: name, type, required });
const criterion = (ref: string, failureCode: string, explain: string) => Object.freeze({ ref, failureCode, explain });
const noOccurrence = Object.freeze({ authority: "not-applicable" });
const operationId = Object.freeze({ authority: "operation-id", input: "idempotencyKey" });
const readConcurrency: EntityActionContract["concurrency"] = Object.freeze({
  expectedVersion: Object.freeze({ authority: "canonical-projection-cut", required: false }),
  leasePolicy: Object.freeze({ authority: "not-applicable" }),
  occurrenceClaim: noOccurrence,
  idempotency: operationId,
  artifactOwnership: Object.freeze({ authority: "not-applicable" }),
});
const installConcurrency: EntityActionContract["concurrency"] = Object.freeze({
  expectedVersion: Object.freeze({
    authority: "entity-event/v1 Squad projection revision",
    required: false,
    default: "center-bound-current-revision",
    arbitration: "center-single-write-queue",
    conflict: "revision_conflict",
  }),
  leasePolicy: Object.freeze({ authority: "not-applicable" }),
  occurrenceClaim: noOccurrence,
  idempotency: Object.freeze({ ...operationId, scope: "squad/{id}/install", retry: "canonical-event-replay" }),
  artifactOwnership: Object.freeze({
    owner: "squad/{id}",
    declaration: "squads/{id}.json",
    policy: "typed-entity/v1",
  }),
});
const runConcurrency: EntityActionContract["concurrency"] = Object.freeze({
  expectedVersion: Object.freeze({
    authority: "center-single-write-queue",
    required: false,
    arbitration: "writer-generation-and-epoch",
  }),
  leasePolicy: Object.freeze({
    authority: "task-current-execution-lease",
    holder: "authenticated-squad-coordinator",
    generation: "retained-across-spawnCoordinated-worker-fanout",
    conflict: "lease_conflict",
  }),
  occurrenceClaim: Object.freeze({
    authority: "squad-run-id",
    subject: "squad/{squadId}/task/{taskId}/run",
    claimFence: "task-current-execution-lease-generation",
  }),
  idempotency: Object.freeze({ ...operationId, scope: "squad/{squadId}/run" }),
  artifactOwnership: Object.freeze({
    runState: "squadRunId",
    dispatchState: "dispatchId/runtimeSessionId",
    taskArtifacts: "task-current-execution",
    mutationRoad: "center-single-write-queue",
  }),
});
const cancelConcurrency: EntityActionContract["concurrency"] = Object.freeze({
  expectedVersion: Object.freeze({ authority: "squad-run-state-revision", required: false }),
  leasePolicy: Object.freeze({ authority: "authenticated-run-binding" }),
  occurrenceClaim: Object.freeze({ authority: "squad-run-id", subject: "squad/{squadRunId}" }),
  idempotency: Object.freeze({ ...operationId, scope: "squad/{squadRunId}/cancel" }),
  artifactOwnership: runConcurrency.artifactOwnership,
});

type SquadActionDeclaration = {
  readonly id: SquadActionId;
  readonly ingress: `squad-${SquadActionId}`;
  readonly input: EntityActionInputContract;
  readonly read: boolean;
  readonly compile: EntityActionCompileHook | null;
  readonly implementation: "compiled-event" | "catalog-runtime";
  readonly topology?: "center-forward-write" | "ledger-write" | "local-arbiter";
  readonly criteria: EntityActionContract["criteria"];
  readonly concurrency: EntityActionContract["concurrency"];
  readonly effects: EntityActionContract["effects"];
  readonly explain: string;
  readonly targetIdField?: string;
};

const declarations: readonly SquadActionDeclaration[] = Object.freeze([
  {
    id: "install",
    ingress: "squad-install",
    input: input([
      field("packageSource"),
      field("declaration", "json-object"),
      field("declarationSource"),
      field("dryRun", "boolean"),
      field("expectedVersion", "number"),
      field("idempotencyKey"),
    ]),
    read: false,
    compile: compileSquadInstallAction,
    implementation: "compiled-event",
    topology: "center-forward-write",
    criteria: Object.freeze([
      criterion(
        "squad/declaration-schema",
        "invalid_manifest",
        "The Squad declaration satisfies squad-declaration/v1 before publication.",
      ),
      criterion(
        "squad/roster-ready",
        "roster_placeholder",
        "The Squad roster contains authored content rather than the declaration scaffold.",
      ),
      criterion(
        "squad/entity-revision",
        "revision_conflict",
        "When supplied, expectedVersion matches the latest Squad entity revision.",
      ),
    ]),
    concurrency: installConcurrency,
    effects: Object.freeze([{ ref: "entity-event/entity_upserted", projection: "SquadProjection" }]),
    explain: "Install one validated Squad declaration through the canonical entity event stream.",
    targetIdField: "entityId",
  },
  {
    id: "validate",
    ingress: "squad-validate",
    input: input([field("packageSource", "string", true)]),
    read: true,
    compile: null,
    implementation: "catalog-runtime",
    criteria: Object.freeze([
      criterion(
        "squad/declaration-schema",
        "invalid_manifest",
        "The supplied package contains a valid squad-declaration/v1 manifest.",
      ),
      criterion("squad/roster-ready", "roster_placeholder", "The supplied package contains an authored Squad roster."),
    ]),
    concurrency: readConcurrency,
    effects: Object.freeze([]),
    explain: "Validate one Squad declaration package without mutation.",
  },
  {
    id: "list",
    ingress: "squad-list",
    input: input([]),
    read: true,
    compile: null,
    implementation: "catalog-runtime",
    criteria: Object.freeze([]),
    concurrency: readConcurrency,
    effects: Object.freeze([]),
    explain: "List installed Squad declarations from the canonical projection cut.",
  },
  {
    id: "inspect",
    ingress: "squad-inspect",
    input: input([field("squadId", "string", true)]),
    read: true,
    compile: null,
    implementation: "catalog-runtime",
    criteria: Object.freeze([
      criterion("squad/entity-present", "squad_not_found", "The requested Squad exists at the canonical cut."),
      criterion(
        "squad/member-declarations",
        "squad_agent_not_found",
        "Every leader and worker named by the Squad has an installed Agent declaration.",
      ),
    ]),
    concurrency: readConcurrency,
    effects: Object.freeze([]),
    explain: "Inspect one Squad and its roster from the canonical projection cut.",
    targetIdField: "squadId",
  },
  {
    id: "run",
    ingress: "squad-run",
    input: input([
      field("squadId", "string", true),
      field("runtimeInstanceId", "string", true),
      field("taskId", "string", true),
      field("prompt"),
      field("effort"),
      field("model"),
      field("permissionMode"),
      field("cwd", "json-object"),
      field("idempotencyKey"),
    ]),
    read: false,
    compile: null,
    implementation: "catalog-runtime",
    topology: "ledger-write",
    criteria: Object.freeze([
      criterion("squad/entity-present", "squad_not_found", "The requested Squad is installed."),
      criterion(
        "squad/member-declarations",
        "squad_agent_not_found",
        "Every leader and worker named by the Squad has an installed Agent declaration.",
      ),
      criterion(
        "squad/task-mission-ready",
        "squad_task_unavailable",
        "The requested Task has a mission that can be dispatched.",
      ),
      criterion("squad/task-run-available", "squad_run_active", "The requested Task has no active Squad run."),
      criterion(
        "squad/execution-lease-holder",
        "lease_conflict",
        "The authenticated coordinator holds the Task current execution lease.",
      ),
      criterion(
        "squad/execution-lease-reacquisition",
        "runtime_task_lease_required",
        "The coordinator can reacquire the same execution lease generation before each continuation.",
      ),
      criterion(
        "squad/leader-dispatch",
        "squad_leader_failed",
        "The initial leader runtime dispatch is accepted by the runtime coordinator.",
      ),
    ]),
    concurrency: runConcurrency,
    effects: Object.freeze([
      { ref: "squad-run/state-created", projection: "SquadRunProjection" },
      { ref: "runtime/leader-dispatched", projection: "RuntimeSessionProjection" },
    ]),
    explain: "Start a task-fenced Squad run through the center queue and coordinator-held lease generation.",
    targetIdField: "squadId",
  },
  {
    id: "status",
    ingress: "squad-status",
    input: input([field("squadRunId", "string", true)]),
    read: true,
    compile: null,
    implementation: "catalog-runtime",
    criteria: Object.freeze([
      criterion("squad/run-id", "invalid_squad_run_id", "The supplied Squad run handle has canonical syntax."),
      criterion("squad/run-present", "squad_run_not_found", "The requested Squad run state exists."),
    ]),
    concurrency: readConcurrency,
    effects: Object.freeze([]),
    explain: "Read durable Squad coordinator state without entering the write queue.",
    targetIdField: "squadRunId",
  },
  {
    id: "cancel",
    ingress: "squad-cancel",
    input: input([field("squadRunId", "string", true), field("idempotencyKey")]),
    read: false,
    compile: null,
    implementation: "catalog-runtime",
    topology: "local-arbiter",
    criteria: Object.freeze([
      criterion("squad/run-id", "invalid_squad_run_id", "The supplied Squad run handle has canonical syntax."),
      criterion("squad/run-present", "squad_run_not_found", "The requested Squad run state exists."),
      criterion(
        "squad/cancellation-complete",
        "squad_cancel_incomplete",
        "Every known leader and worker runtime accepts cancellation after durable run cancellation.",
      ),
    ]),
    concurrency: cancelConcurrency,
    effects: Object.freeze([
      { ref: "squad-run/cancelled", projection: "SquadRunProjection" },
      { ref: "runtime/cancel-requested", projection: "RuntimeSessionProjection" },
    ]),
    explain: "Cancel one Squad run through its authenticated coordinator and runtime cancellation path.",
    targetIdField: "squadRunId",
  },
]);

export function createSquadActionCatalog(
  baseAction: (id: SquadActionId) => EntityActionContract,
  actionResultContract: EntityActionContract["returns"],
) {
  return Object.freeze({
    ref: "kernel/squad-action/v1",
    actions: Object.freeze(
      declarations.map((declaration) => {
        const base = baseAction(declaration.id);
        return Object.freeze({
          ...base,
          input: declaration.input,
          policy: Object.freeze({ ref: "default@5", action: declaration.read ? null : declaration.ingress }),
          criteria: declaration.criteria,
          concurrency: declaration.concurrency,
          effects: declaration.effects,
          returns: actionResultContract,
          explain: declaration.explain,
          execution: Object.freeze({
            ingress: declaration.ingress,
            compile: declaration.compile,
            read: declaration.read,
            implementation: declaration.implementation,
            ...(declaration.topology ? { topology: declaration.topology } : {}),
            ...(declaration.targetIdField ? { targetIdField: declaration.targetIdField } : {}),
          }),
        });
      }),
    ),
  });
}

export function compileSquadInstallAction(input: EntityActionCompileInput): SquadActionDraft {
  let entity: SquadDeclarationV1;
  try {
    entity = parseSquadDeclarationV1(input.action.declaration);
  } catch (error) {
    throw squadCriterionError(error, "squad/declaration-schema", "invalid_manifest");
  }
  try {
    assertTransitionDocumentReady(requireTransitionDocumentKind("squad.install"), entity.roster);
  } catch (error) {
    throw squadCriterionError(error, "squad/roster-ready", "roster_placeholder");
  }
  return { kind: "entity", entityKind: "squad", entity };
}

export function squadActionUsage(action: EntityActionContract, squadId = "<squad-id>"): string {
  const usage: Record<SquadActionId, string> = {
    install: "ha squad install --source <squad-package> [--dry-run]",
    validate: "ha squad validate --source <squad-package>",
    list: "ha squad list",
    inspect: `ha squad inspect ${squadId}`,
    run: `ha squad run ${squadId} --instance <runtime-instance-id> --task <task-id>`,
    status: "ha squad status <squad-run-id>",
    cancel: "ha squad cancel <squad-run-id>",
  };
  if (!squadActionIds.includes(action.id as SquadActionId)) throw new Error(`Unknown Squad Action ${action.id}.`);
  return usage[action.id as SquadActionId];
}

function squadCriterionError(error: unknown, criterionRef: string, fallbackCode: string): Error {
  const attributed = error instanceof Error ? error : Object.assign(new Error(String(error)), { code: fallbackCode });
  if (!("code" in attributed)) Object.assign(attributed, { code: fallbackCode });
  return attributeEntityActionCriterion(attributed, "install", criterionRef);
}
