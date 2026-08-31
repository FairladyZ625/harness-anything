import {
  reduceRuntimeSession,
  validateCurrentAgentRuntimeEvent,
  type AgentRuntimeEventType,
  type AgentRuntimeEventV1,
  type RuntimeSession,
  RuntimeSessionAdoptionStaleError,
} from "./agent-runtime.ts";
import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";
import type { EntityActionCompileHook, EntityActionCompileInput } from "./entity-action-execution.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { consumeKnownError } from "../error-consumption.ts";

export const runtimeSessionActionIds = Object.freeze([
  "runtime_session_started",
  "runtime_session_provider_bound",
  "runtime_session_task_bound",
  "runtime_session_liveness_changed",
  "runtime_session_cancelled",
  "runtime_session_exited",
  "runtime_session_outcome_observed",
] as const satisfies readonly AgentRuntimeEventType[]);

export type RuntimeSessionActionId = (typeof runtimeSessionActionIds)[number];
export type RuntimeSessionActionEvent = Extract<AgentRuntimeEventV1, { readonly type: RuntimeSessionActionId }>;

export interface RuntimeSessionActionDraft {
  readonly kind: "runtime-session";
  readonly event: RuntimeSessionActionEvent;
  readonly resultBody?: string;
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
  required = true,
  values?: readonly string[],
): EntityActionInputField =>
  Object.freeze({ field: name, type, required, ...(values ? { enum: Object.freeze(values) } : {}) });
const runtimeSessionId = field("runtimeSessionId");
const idempotencyKey = field("idempotencyKey", "string", false);
const noOccurrence = Object.freeze({ authority: "not-applicable" });

const actionFields: Readonly<Record<RuntimeSessionActionId, readonly EntityActionInputField[]>> = Object.freeze({
  runtime_session_started: Object.freeze([
    runtimeSessionId,
    field("instanceId"),
    field("installationId"),
    field("kindId"),
    field("definitionSnapshotRef"),
    field("launchGeneration", "number"),
    field("attachable", "boolean"),
    idempotencyKey,
  ]),
  runtime_session_provider_bound: Object.freeze([
    runtimeSessionId,
    field("providerSessionId"),
    field("transcriptRef"),
    idempotencyKey,
  ]),
  runtime_session_task_bound: Object.freeze([
    runtimeSessionId,
    field("taskId"),
    field("executionId"),
    field("providerSessionId"),
    field("transcriptRef"),
    idempotencyKey,
  ]),
  runtime_session_liveness_changed: Object.freeze([
    runtimeSessionId,
    field("liveness", "string", true, ["live", "stale", "unknown"]),
    idempotencyKey,
  ]),
  runtime_session_cancelled: Object.freeze([runtimeSessionId, idempotencyKey]),
  runtime_session_exited: Object.freeze([runtimeSessionId, idempotencyKey]),
  runtime_session_outcome_observed: Object.freeze([
    runtimeSessionId,
    field("outcome", "string", true, ["succeeded", "failed", "unknown", "cancelled"]),
    field("exitCode", "number", false),
    field("resultRef"),
    field("result", "json-object"),
    field("reasonCode", "string", false),
    field("resultBody", "string", false),
    idempotencyKey,
  ]),
});

const criteria = Object.freeze([
  Object.freeze({
    ref: "runtime-session/assignment-fence",
    failureCode: "assignment_scope_mismatch",
    explain: "The authenticated assignment owns the dispatch that created this RuntimeSession.",
  }),
  Object.freeze({
    ref: "runtime-session/adoption-fence",
    failureCode: "runtime_session_adoption_stale",
    explain: "A RuntimeSession start must advance its center-projected launchGeneration.",
  }),
  Object.freeze({
    ref: "runtime-session/task-binding",
    failureCode: "assignment_scope_mismatch",
    explain: "Task and execution binding must match the authenticated assignment scope.",
  }),
  Object.freeze({
    ref: "runtime-session/current-state",
    failureCode: "runtime_session_transition_invalid",
    explain: "The event must reduce from the current canonical RuntimeSession state.",
  }),
]);

const concurrency = Object.freeze({
  expectedVersion: Object.freeze({
    authority: "runtime-session/v1 canonical projection",
    subject: "runtime-session/{runtimeSessionId}",
    startFence: "launchGeneration",
    writerFence: "center-issued writerEpoch",
    conflict: "runtime_session_adoption_stale",
  }),
  leasePolicy: Object.freeze({
    authority: "runtime-session adoption fence",
    owner: "originating authenticated assignment",
    arbitration: "center-single-write-queue",
  }),
  occurrenceClaim: noOccurrence,
  idempotency: Object.freeze({
    authority: "operation-id",
    input: "idempotencyKey",
    scope: "runtime-session/{runtimeSessionId}/event",
    retry: "canonical-event-replay",
  }),
  artifactOwnership: Object.freeze({
    owner: "dispatch/{dispatchId}",
    session: "runtime-session/{runtimeSessionId}",
    result: "dispatch/{dispatchId}/result",
    policy: "per-dispatch-no-shared-overwrite",
  }),
});

export function createRuntimeSessionActionCatalog(
  baseAction: (id: RuntimeSessionActionId) => EntityActionContract,
  actionResultContract: EntityActionContract["returns"],
) {
  return Object.freeze({
    ref: "kernel/runtime-session-action/v1",
    actions: Object.freeze(
      runtimeSessionActionIds.map((id) => {
        const declared = baseAction(id);
        return Object.freeze({
          ...declared,
          input: input(actionFields[id]),
          policy: Object.freeze({ ref: "default@5", action: "runtime-run" }),
          criteria,
          concurrency,
          effects: Object.freeze([{ ref: `agent-runtime-event/${id}`, projection: "RuntimeSessionProjection" }]),
          returns: actionResultContract,
          explain: `Append ${id} through the canonical RuntimeSession event stream.`,
          execution: Object.freeze({
            ingress: id,
            compile: runtimeSessionActionCompiler(id),
            read: false,
            implementation: "compiled-event" as const,
            topology: "center-forward-write" as const,
            targetIdField: "runtimeSessionId",
          }),
        });
      }),
    ),
  });
}

export function runtimeSessionActionPayload(
  id: RuntimeSessionActionId,
  action: Readonly<Record<string, unknown>>,
): AgentRuntimeEventV1["payload"] {
  const payload = Object.fromEntries(
    actionFields[id]
      .filter(({ field: name }) => name !== "idempotencyKey" && name !== "resultBody")
      .flatMap(({ field: name, required }) =>
        required || Object.hasOwn(action, name) ? ([[name, action[name]]] as const) : [],
      ),
  );
  if (id === "runtime_session_outcome_observed" && !Object.hasOwn(payload, "exitCode")) payload.exitCode = null;
  return payload as unknown as AgentRuntimeEventV1["payload"];
}

export function runtimeSessionActionCompiler(id: RuntimeSessionActionId): EntityActionCompileHook {
  return (input): RuntimeSessionActionDraft => compileRuntimeSessionAction(id, input);
}

function compileRuntimeSessionAction(
  id: RuntimeSessionActionId,
  input: EntityActionCompileInput,
): RuntimeSessionActionDraft {
  const event = {
      schema: "agent-runtime-event/v1",
      eventId: `event-${sha256Text(input.opId)}`,
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      type: id,
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: runtimeSessionActionPayload(id, input.action),
    } as RuntimeSessionActionEvent,
    errors = validateCurrentAgentRuntimeEvent(event);
  if (errors.length) invalidRuntimeSessionAction("invalid_runtime_event", errors.join("; "));
  try {
    reduceRuntimeSession((input.currentEntity as RuntimeSession | null | undefined) ?? null, event);
  } catch (error) {
    consumeKnownError(error);
    const message = error instanceof Error ? error.message : String(error);
    invalidRuntimeSessionAction(
      error instanceof RuntimeSessionAdoptionStaleError
        ? "runtime_session_adoption_stale"
        : "runtime_session_transition_invalid",
      message,
    );
  }
  const resultBody = input.action.resultBody;
  if (resultBody !== undefined && (id !== "runtime_session_outcome_observed" || typeof resultBody !== "string"))
    invalidRuntimeSessionAction(
      "invalid_runtime_event",
      "Only runtime_session_outcome_observed accepts resultBody text.",
    );
  if (event.type === "runtime_session_outcome_observed" && typeof resultBody === "string") {
    const result = event.payload.result,
      bytes = new TextEncoder().encode(resultBody);
    if (bytes.byteLength !== result.size || sha256Text(resultBody) !== result.sha256)
      invalidRuntimeSessionAction(
        "content_claim_mismatch",
        "Runtime result bytes do not match the declared result claim.",
      );
  }
  return {
    kind: "runtime-session",
    event,
    ...(typeof resultBody === "string" ? { resultBody } : {}),
  };
}

function invalidRuntimeSessionAction(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
