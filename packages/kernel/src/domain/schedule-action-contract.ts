import { record } from "./actor-identity.ts";
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
import {
  compileScheduleDeletedEvent,
  compileScheduleDefinitionEvent,
  compileScheduleRunEvent,
  type ScheduleDefinitionEventBundle,
  type ScheduleDeletedEventBundle,
  type ScheduleRunEventBundle,
} from "./schedule-event.ts";
import {
  createScheduleV1,
  scheduleMissedReasons,
  scheduleRunOutcomes,
  validateScheduleV1,
  type ScheduleMissedReason,
  type ScheduleMode,
  type ScheduleRunOutcome,
  type ScheduleTriggerV1,
  type ScheduleV1,
} from "./schedule.ts";
import { timestamp } from "./timestamp.ts";
import { sha256Text } from "../integrity/stable-hash.ts";

type ScheduleEventBundle = ScheduleDefinitionEventBundle | ScheduleDeletedEventBundle | ScheduleRunEventBundle;

export type ScheduleActionDraft =
  | { readonly kind: "event"; readonly bundle: ScheduleEventBundle }
  | { readonly kind: "no-changes"; readonly schedule: ScheduleV1; readonly revision: number };

type ScheduleActionId =
  | "create"
  | "update"
  | "delete"
  | "enable"
  | "disable"
  | "run-now"
  | "claim"
  | "link"
  | "record-missed"
  | "settle"
  | "list"
  | "runs"
  | "show";

type ScheduleActionDeclaration = {
  readonly id: ScheduleActionId;
  readonly ingress: string;
  readonly input: EntityActionInputContract;
  readonly read: boolean;
  readonly compile: EntityActionCompileHook | null;
  readonly criteria: EntityActionContract["criteria"];
  readonly concurrency: EntityActionContract["concurrency"];
  readonly effects: EntityActionContract["effects"];
  readonly explain: string;
};

const input = (
  fields: readonly EntityActionInputField[],
  exactlyOneOf: readonly (readonly string[])[] = [],
): EntityActionInputContract =>
  Object.freeze({
    schema: "entity-action-input/v1",
    fields: Object.freeze(fields.map((field) => Object.freeze(field))),
    exactlyOneOf: Object.freeze(exactlyOneOf.map((group) => Object.freeze(group))),
  });
const field = (
  name: string,
  type: EntityActionInputField["type"] = "string",
  required = false,
  values?: readonly string[],
): EntityActionInputField =>
  Object.freeze({ field: name, type, required, ...(values ? { enum: Object.freeze(values) } : {}) });
const scheduleId = field("scheduleId", "string", true);
const idempotencyKey = field("idempotencyKey");
const definitionFields = Object.freeze([
  field("name"),
  field("mode", "string", false, ["detect", "remediate"]),
  field("everyMs", "number"),
  field("cronExpression"),
  field("timezone"),
  field("agentId"),
  field("runtimeInstanceId"),
  field("mission"),
  field("model"),
  field("reasoningEffort", "string", false, ["minimal", "low", "medium", "high", "xhigh"]),
  field("fast", "boolean"),
]);
const createDefinitionFields = Object.freeze([
  field("name", "string", true),
  field("mode", "string", true, ["detect", "remediate"]),
  ...definitionFields.filter(
    ({ field }) => !["name", "mode", "agentId", "runtimeInstanceId", "mission"].includes(field),
  ),
  field("agentId", "string", true),
  field("runtimeInstanceId", "string", true),
  field("mission", "string", true),
]);
const noLease = Object.freeze({ authority: "not-applicable" });
const noOccurrence = Object.freeze({ authority: "not-applicable" });
const noArtifacts = Object.freeze({ authority: "not-applicable" });
const scheduleConcurrency = (
  options: {
    readonly expectedVersion?: Readonly<Record<string, unknown>>;
    readonly occurrenceClaim?: Readonly<Record<string, unknown>>;
    readonly artifactOwnership?: Readonly<Record<string, unknown>>;
  } = {},
): EntityActionContract["concurrency"] =>
  Object.freeze({
    expectedVersion: Object.freeze(
      options.expectedVersion ?? {
        authority: "schedule-event/v1 projection revision",
        default: "daemon-bound-projection-revision",
        conflict: "schedule_definition_stale",
      },
    ),
    leasePolicy: noLease,
    occurrenceClaim: Object.freeze(options.occurrenceClaim ?? noOccurrence),
    idempotency: Object.freeze({
      authority: "operation-id",
      input: "idempotencyKey",
      scope: "schedule/{scheduleId}/action",
      retry: "canonical-event-replay",
    }),
    artifactOwnership: Object.freeze(options.artifactOwnership ?? noArtifacts),
  });
const definitionConcurrency = scheduleConcurrency({
  artifactOwnership: {
    owner: "schedule/{scheduleId}",
    declaration: "schedules/{scheduleId}.json",
    policy: "typed-entity/v1",
  },
});
const occurrenceConcurrency = scheduleConcurrency({
  occurrenceClaim: {
    authority: "schedule-event/v1 activeRun",
    subject: "schedule/{scheduleId}/occurrence",
    mode: "single-flight",
    definitionFence: "observedDefinitionRevision",
    assignmentFence: "authenticated WriteSource assignment",
    claimFence: "activeRun.claimFence",
  },
});
const claimFenceConcurrency = scheduleConcurrency({
  occurrenceClaim: {
    authority: "schedule-event/v1 activeRun",
    subject: "schedule/{scheduleId}/occurrence",
    mode: "claim-fence",
    input: "claimFence",
    conflict: "schedule_claim_stale",
  },
});
const scheduleEffect = (ref: string, projection = "ScheduleProjection") => Object.freeze([{ ref, projection }]);
const criterion = (ref: string, failureCode: string, explain: string) => Object.freeze({ ref, failureCode, explain });

const declarations = Object.freeze([
  {
    id: "create",
    ingress: "schedule-create",
    input: input(
      [scheduleId, ...createDefinitionFields, field("disabled", "boolean"), idempotencyKey],
      [["everyMs", "cronExpression"]],
    ),
    read: false,
    compile: scheduleActionCompiler("create"),
    criteria: Object.freeze([
      criterion("schedule/create-identity", "entity_exists", "The Schedule id has no active canonical projection."),
    ]),
    concurrency: scheduleConcurrency({
      expectedVersion: { authority: "schedule-event/v1 projection", expected: "absent", conflict: "entity_exists" },
      artifactOwnership: {
        owner: "schedule/{scheduleId}",
        declaration: "schedules/{scheduleId}.json",
        policy: "typed-entity/v1",
      },
    }),
    effects: scheduleEffect("schedule-event/schedule_created"),
    explain: "Create one canonical Schedule definition and its initial run view.",
  },
  {
    id: "update",
    ingress: "schedule-update",
    input: input([scheduleId, ...definitionFields, idempotencyKey]),
    read: false,
    compile: scheduleActionCompiler("update"),
    criteria: Object.freeze([
      criterion("schedule/update-definition", "invalid_command", "At least one valid definition field changes."),
    ]),
    concurrency: definitionConcurrency,
    effects: scheduleEffect("schedule-event/schedule_updated"),
    explain: "Update selected Schedule definition fields at the current canonical revision.",
  },
  {
    id: "delete",
    ingress: "schedule-delete",
    input: input([scheduleId, field("reason"), idempotencyKey]),
    read: false,
    compile: scheduleActionCompiler("delete"),
    criteria: Object.freeze([
      criterion(
        "schedule/delete-single-flight",
        "schedule_single_flight_active",
        "The Schedule has no active occurrence when its declaration is retired.",
      ),
    ]),
    concurrency: definitionConcurrency,
    effects: scheduleEffect("schedule-event/schedule_deleted"),
    explain: "Retire the Schedule declaration while retaining its canonical event history.",
  },
  ...(["enable", "disable"] as const).map((id) => ({
    id,
    ingress: `schedule-${id}`,
    input: input([scheduleId, idempotencyKey]),
    read: false,
    compile: scheduleActionCompiler(id),
    criteria: Object.freeze([]),
    concurrency: definitionConcurrency,
    effects: scheduleEffect(`schedule-event/schedule_${id}d`),
    explain: `${id === "enable" ? "Arm" : "Pause"} the Schedule without changing its cadence or run history.`,
  })),
  {
    id: "run-now",
    ingress: "schedule-run-now",
    input: input([scheduleId, field("scheduledFor"), field("observedDefinitionRevision", "number"), idempotencyKey]),
    read: false,
    compile: scheduleActionCompiler("run-now"),
    criteria: claimCriteria(),
    concurrency: occurrenceConcurrency,
    effects: scheduleEffect("schedule-event/schedule_occurrence_claimed"),
    explain: "Claim one manual or scheduler-selected occurrence before launching its runtime.",
  },
  {
    id: "claim",
    ingress: "schedule-claim",
    input: input([
      scheduleId,
      field("scheduledFor", "string", true),
      field("observedDefinitionRevision", "number"),
      idempotencyKey,
    ]),
    read: false,
    compile: scheduleActionCompiler("claim"),
    criteria: claimCriteria(),
    concurrency: occurrenceConcurrency,
    effects: scheduleEffect("schedule-event/schedule_occurrence_claimed"),
    explain: "Claim one occurrence without launching it; recovery may resume dispatch through run-now.",
  },
  {
    id: "link",
    ingress: "schedule-dispatch-link",
    input: input([
      scheduleId,
      field("claimFence", "string", true),
      field("dispatchId", "string", true),
      field("runtimeSessionId", "string", true),
      idempotencyKey,
    ]),
    read: false,
    compile: scheduleActionCompiler("link"),
    criteria: claimFenceCriteria(),
    concurrency: claimFenceConcurrency,
    effects: scheduleEffect("schedule-event/schedule_occurrence_dispatched"),
    explain: "Link the runtime dispatch to the occurrence that still owns the supplied claim fence.",
  },
  {
    id: "record-missed",
    ingress: "schedule-missed",
    input: input([
      scheduleId,
      field("from", "string", true),
      field("to", "string", true),
      field("count", "number", true),
      field("reason", "string", true, scheduleMissedReasons),
      field("observedDefinitionRevision", "number", true),
      idempotencyKey,
    ]),
    read: false,
    compile: scheduleActionCompiler("record-missed"),
    criteria: Object.freeze([
      criterion(
        "schedule/missed-definition-fence",
        "schedule_definition_stale",
        "Missed-occurrence evidence targets the observed Schedule projection revision.",
      ),
    ]),
    concurrency: occurrenceConcurrency,
    effects: scheduleEffect("schedule-event/schedule_occurrences_missed"),
    explain: "Advance automatic cadence with aggregated, non-catch-up missed-occurrence evidence.",
  },
  {
    id: "settle",
    ingress: "schedule-settle",
    input: input([
      scheduleId,
      field("claimFence", "string", true),
      field("outcome", "string", true, scheduleRunOutcomes),
      field("endedAt", "string", true),
      field("detail"),
      idempotencyKey,
    ]),
    read: false,
    compile: scheduleActionCompiler("settle"),
    criteria: claimFenceCriteria(),
    concurrency: claimFenceConcurrency,
    effects: scheduleEffect("schedule-event/schedule_run_settled"),
    explain: "Settle only the active occurrence that owns the supplied claim fence.",
  },
  ...(["list", "runs", "show"] as const).map((id) => ({
    id,
    ingress: `schedule-${id}`,
    input: input(id === "list" ? [] : [scheduleId, ...(id === "runs" ? [field("limit", "number")] : [])]),
    read: true,
    compile: null,
    criteria: Object.freeze([]),
    concurrency: scheduleConcurrency(),
    effects: Object.freeze([]),
    explain: [
      id === "list" ? "List canonical Schedules" : id === "runs" ? "Read occurrence history" : "Read one Schedule",
      "from the canonical projection.",
    ].join(" "),
  })),
] as const satisfies readonly ScheduleActionDeclaration[]);

export function createScheduleActionCatalog(
  baseAction: (id: ScheduleActionId) => EntityActionContract,
  actionResultContract: EntityActionContract["returns"],
) {
  return Object.freeze({
    ref: "kernel/schedule-action/v1",
    actions: Object.freeze(
      declarations.map(
        (declaration): EntityActionContract =>
          Object.freeze({
            ...baseAction(declaration.id),
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
              implementation: "catalog-runtime" as const,
              ...(declaration.read ? {} : { topology: "center-forward-write" as const }),
              ...(declaration.id === "list" ? {} : { targetIdField: "scheduleId" }),
            }),
          }),
      ),
    ),
  });
}

function scheduleActionCompiler(id: Exclude<ScheduleActionId, "list" | "runs" | "show">): EntityActionCompileHook {
  return (compileInput) => ({ kind: "schedule", result: compileScheduleAction(id, compileInput) });
}

function compileScheduleAction(
  id: Exclude<ScheduleActionId, "list" | "runs" | "show">,
  input: EntityActionCompileInput,
): ScheduleActionDraft {
  const action = input.action,
    revision = input.entityRevision ?? 0,
    current = input.currentEntity,
    schedule = currentSchedule(input),
    common = {
      eventId: `event-${sha256Text(input.opId)}`,
      opId: input.opId,
      workspaceRevision: input.workspaceRevision,
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
    };
  if (id === "create") {
    if (current !== undefined && current !== null)
      rejectCriterion(
        "create",
        "schedule/create-identity",
        "entity_exists",
        `Schedule ${text(action.scheduleId, "scheduleId")} already exists.`,
      );
    const created = createScheduleV1({
      scheduleId: text(action.scheduleId, "scheduleId"),
      name: text(action.name, "name"),
      state: action.disabled === true ? "paused" : "armed",
      mode: scheduleMode(action.mode),
      spec: {
        trigger: scheduleTriggerFromCreate(action, input.occurredAt),
        target: {
          kind: "agent",
          agentId: text(action.agentId, "agentId"),
          runtimeInstanceId: text(action.runtimeInstanceId, "runtimeInstanceId"),
          ...(typeof action.model === "string" ? { model: action.model } : {}),
          ...(typeof action.reasoningEffort === "string" ? { reasoningEffort: action.reasoningEffort } : {}),
          ...(typeof action.fast === "boolean" ? { fast: action.fast } : {}),
        },
        mission: text(action.mission, "mission"),
      },
      actor: input.actor,
      occurredAt: input.occurredAt,
    });
    return event(compileScheduleDefinitionEvent({ ...common, type: "schedule_created", schedule: created }));
  }
  if (id === "update") {
    const fields = definitionFields.map(({ field }) => field);
    if (!fields.some((field) => Object.hasOwn(action, field)))
      rejectCriterion(
        "update",
        "schedule/update-definition",
        "invalid_command",
        "Schedule update requires at least one definition field.",
      );
    if (!record(current))
      reject("entity_not_found", `Schedule ${text(action.scheduleId, "scheduleId")} does not exist.`);
    const merged = mergeScheduleUpdate(current, action, input.occurredAt);
    if (!merged.schedule)
      reject(
        "invalid_store",
        `Schedule ${text(action.scheduleId, "scheduleId")} update remains invalid: ${merged.errors.join("; ")}`,
      );
    if (
      schedule &&
      JSON.stringify({ name: merged.schedule.name, mode: merged.schedule.mode, spec: merged.schedule.spec }) ===
        JSON.stringify({ name: schedule.name, mode: schedule.mode, spec: schedule.spec })
    )
      return { kind: "no-changes", schedule, revision };
    return event(compileScheduleDefinitionEvent({ ...common, type: "schedule_updated", schedule: merged.schedule }));
  }
  if (!schedule) reject("entity_not_found", `Schedule ${text(action.scheduleId, "scheduleId")} does not exist.`);
  if (id === "delete") {
    if (schedule.status.activeRun)
      rejectCriterion(
        "delete",
        "schedule/delete-single-flight",
        "schedule_single_flight_active",
        `Schedule ${schedule.scheduleId} has an active occurrence; settle it before deletion.`,
      );
    const baseBlobSha256 = input.currentDocumentBlobSha256;
    if (typeof baseBlobSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(baseBlobSha256))
      reject("invalid_store", `Schedule ${schedule.scheduleId} has no projected declaration document.`);
    return event(
      compileScheduleDeletedEvent({
        ...common,
        type: "schedule_deleted",
        schedule,
        baseBlobSha256,
        ...(typeof action.reason === "string" ? { reason: text(action.reason, "reason") } : {}),
      }),
    );
  }
  if (id === "enable" || id === "disable") {
    const state = id === "enable" ? "armed" : "paused";
    if (schedule.state === state) return { kind: "no-changes", schedule, revision };
    return event(
      compileScheduleDefinitionEvent({
        ...common,
        type: id === "enable" ? "schedule_enabled" : "schedule_disabled",
        schedule: { ...schedule, state, updatedAt: input.occurredAt },
      }),
    );
  }
  if (id === "run-now" || id === "claim") return claimOccurrence(id, schedule, revision, input, common);
  if (id === "link") {
    const active = matchingClaim("link", schedule, action.claimFence);
    return event(
      compileScheduleRunEvent({
        ...common,
        type: "schedule_occurrence_dispatched",
        schedule: {
          ...schedule,
          status: {
            ...schedule.status,
            activeRun: {
              ...active,
              dispatchId: text(action.dispatchId, "dispatchId"),
              runtimeSessionId: text(action.runtimeSessionId, "runtimeSessionId"),
            },
          },
        },
      }),
    );
  }
  if (id === "record-missed") return missedOccurrences(schedule, revision, input, common);
  const active = matchingClaim("settle", schedule, action.claimFence),
    outcome = action.outcome as ScheduleRunOutcome;
  if (!scheduleRunOutcomes.includes(outcome) || !timestamp(action.endedAt))
    reject("invalid_command", "Schedule settlement requires one canonical outcome and UTC end time.");
  const settled: ScheduleV1 = {
    ...schedule,
    status: {
      ...schedule.status,
      activeRun: null,
      lastRun: {
        occurrenceId: active.occurrenceId,
        scheduledFor: active.scheduledFor,
        endedAt: action.endedAt,
        outcome,
        nodeId: active.nodeId,
        assignmentId: active.assignmentId,
        claimFence: active.claimFence,
        attemptIndex: active.attemptIndex,
        ...(active.dispatchId ? { dispatchId: active.dispatchId } : {}),
        ...(active.runtimeSessionId ? { runtimeSessionId: active.runtimeSessionId } : {}),
        ...(typeof action.detail === "string" ? { detail: action.detail.slice(0, 1024) } : {}),
      },
    },
  };
  return event(compileScheduleRunEvent({ ...common, type: "schedule_run_settled", schedule: settled }));
}

function claimOccurrence(
  actionId: "run-now" | "claim",
  schedule: ScheduleV1,
  revision: number,
  input: EntityActionCompileInput,
  common: CommonEventInput,
): ScheduleActionDraft {
  const action = input.action;
  if (schedule.state !== "armed")
    reject("schedule_paused", `Schedule ${schedule.scheduleId} is paused; enable it before claiming.`);
  if (typeof action.observedDefinitionRevision === "number" && action.observedDefinitionRevision !== revision)
    rejectCriterion(
      actionId,
      "schedule/definition-revision-fence",
      "schedule_definition_stale",
      `Schedule ${schedule.scheduleId} changed at revision ${revision}; refresh its definition before claiming.`,
    );
  if (schedule.status.activeRun)
    rejectCriterion(
      actionId,
      "schedule/occurrence-single-flight",
      "schedule_single_flight_active",
      `Schedule ${schedule.scheduleId} already has active occurrence ${schedule.status.activeRun.occurrenceId}.`,
    );
  if (schedule.spec.target.kind !== "agent")
    reject(
      "schedule_target_unavailable",
      `Schedule ${schedule.scheduleId} target ${schedule.spec.target.kind} is declared but has no dispatch route.`,
    );
  const scheduledFor = typeof action.scheduledFor === "string" ? action.scheduledFor : input.occurredAt,
    kind = typeof action.scheduledFor === "string" ? "scheduled" : "manual";
  if (!timestamp(scheduledFor))
    reject("invalid_command", "Schedule occurrence time must be an ISO-8601 UTC timestamp.");
  const idempotency = text(action.idempotencyKey, "idempotencyKey"),
    occurrenceHash = sha256Text(`${schedule.scheduleId}\0${kind}\0${scheduledFor}\0${idempotency}`),
    occurrenceId = `${kind === "manual" ? "manual" : "occurrence"}_${occurrenceHash.slice(0, 24)}`,
    claimFence = `claim_${sha256Text(`${occurrenceHash}\0${revision + 1}`).slice(0, 24)}`,
    assignment = typeof input.source === "object" && input.source.kind === "assignment" ? input.source : null,
    updated: ScheduleV1 = {
      ...schedule,
      status: {
        ...schedule.status,
        automaticEvaluatedThrough: kind === "scheduled" ? scheduledFor : schedule.status.automaticEvaluatedThrough,
        activeRun: {
          occurrenceId,
          kind,
          scheduledFor,
          claimedAt: input.occurredAt,
          nodeId: assignment?.nodeId ?? "local",
          assignmentId: assignment?.assignmentId ?? null,
          claimFence,
          attemptIndex: 0,
        },
      },
    };
  return event(compileScheduleRunEvent({ ...common, type: "schedule_occurrence_claimed", schedule: updated }));
}

function missedOccurrences(
  schedule: ScheduleV1,
  revision: number,
  input: EntityActionCompileInput,
  common: CommonEventInput,
): ScheduleActionDraft {
  const action = input.action;
  if (schedule.state !== "armed")
    reject("schedule_paused", `Schedule ${schedule.scheduleId} is paused; it cannot record a timer miss.`);
  if (action.observedDefinitionRevision !== revision)
    rejectCriterion(
      "record-missed",
      "schedule/missed-definition-fence",
      "schedule_definition_stale",
      `Schedule ${schedule.scheduleId} changed at revision ${revision}; refresh it before recording a timer miss.`,
    );
  const count = Number(action.count),
    reason = action.reason as ScheduleMissedReason;
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !timestamp(action.from) ||
    !timestamp(action.to) ||
    Date.parse(action.from) > Date.parse(action.to) ||
    !scheduleMissedReasons.includes(reason)
  )
    reject("invalid_command", "Missed occurrence evidence requires an ordered UTC range and count.");
  const updated: ScheduleV1 = {
    ...schedule,
    status: {
      ...schedule.status,
      automaticEvaluatedThrough: action.to,
      missedCount: schedule.status.missedCount + count,
      lastMissedAt: action.to,
      lastMissedReason: reason,
    },
  };
  return event(
    compileScheduleRunEvent({
      ...common,
      type: "schedule_occurrences_missed",
      schedule: updated,
      missed: { from: action.from, to: action.to, count, reason },
    }),
  );
}

type CommonEventInput = Pick<
  EntityActionCompileInput,
  "opId" | "workspaceRevision" | "actor" | "source" | "occurredAt"
> & { readonly eventId: string };

function currentSchedule(input: EntityActionCompileInput): ScheduleV1 | null {
  return validateScheduleV1(input.currentEntity).length === 0 ? (input.currentEntity as ScheduleV1) : null;
}

function matchingClaim(
  actionId: "link" | "settle",
  schedule: ScheduleV1,
  fence: unknown,
): NonNullable<ScheduleV1["status"]["activeRun"]> {
  const claimFence = text(fence, "claimFence"),
    active = schedule.status.activeRun;
  if (!active || active.claimFence !== claimFence)
    rejectCriterion(
      actionId,
      "schedule/active-claim-fence",
      "schedule_claim_stale",
      `Schedule ${schedule.scheduleId} no longer owns claim ${claimFence}.`,
    );
  return active;
}

function event(bundle: ScheduleEventBundle): ScheduleActionDraft {
  return { kind: "event", bundle };
}

function claimCriteria(): EntityActionContract["criteria"] {
  return Object.freeze([
    criterion(
      "schedule/definition-revision-fence",
      "schedule_definition_stale",
      "The observed Schedule projection revision still owns the occurrence definition.",
    ),
    criterion(
      "schedule/occurrence-single-flight",
      "schedule_single_flight_active",
      "No active occurrence already owns the Schedule single-flight slot.",
    ),
  ]);
}

function claimFenceCriteria(): EntityActionContract["criteria"] {
  return Object.freeze([
    criterion(
      "schedule/active-claim-fence",
      "schedule_claim_stale",
      "The active occurrence still owns the supplied claim fence.",
    ),
  ]);
}

function mergeScheduleUpdate(
  value: Readonly<Record<string, unknown>>,
  action: Readonly<Record<string, unknown>>,
  occurredAt: string,
): { readonly schedule: ScheduleV1 | null; readonly errors: readonly string[] } {
  const currentSpec = record(value.spec) ? value.spec : null,
    currentTarget = currentSpec && record(currentSpec.target) ? currentSpec.target : null,
    trigger = scheduleTriggerFromUpdate(action, currentSpec?.trigger, occurredAt),
    optionalTarget = (name: "model" | "reasoningEffort"): string | undefined =>
      Object.hasOwn(action, name)
        ? action[name] === null
          ? undefined
          : text(action[name], name)
        : currentTarget?.kind === "agent" && typeof currentTarget[name] === "string"
          ? currentTarget[name]
          : undefined,
    model = optionalTarget("model"),
    reasoningEffort = optionalTarget("reasoningEffort"),
    fast = Object.hasOwn(action, "fast")
      ? action.fast === true
      : currentTarget?.kind === "agent" && typeof currentTarget.fast === "boolean"
        ? currentTarget.fast
        : undefined,
    target =
      currentTarget?.kind === "agent" || Object.hasOwn(action, "agentId") || Object.hasOwn(action, "runtimeInstanceId")
        ? {
            kind: "agent",
            agentId: Object.hasOwn(action, "agentId") ? text(action.agentId, "agentId") : currentTarget?.agentId,
            runtimeInstanceId: Object.hasOwn(action, "runtimeInstanceId")
              ? text(action.runtimeInstanceId, "runtimeInstanceId")
              : currentTarget?.runtimeInstanceId,
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(fast === undefined ? {} : { fast }),
          }
        : currentSpec?.target,
    candidate = {
      ...value,
      name: Object.hasOwn(action, "name") ? text(action.name, "name").trim() : value.name,
      mode: Object.hasOwn(action, "mode") ? scheduleMode(action.mode) : value.mode,
      spec: {
        ...(currentSpec ?? {}),
        trigger,
        target,
        mission: Object.hasOwn(action, "mission") ? text(action.mission, "mission").trim() : currentSpec?.mission,
      },
      updatedAt: occurredAt,
    },
    errors = validateScheduleV1(candidate);
  return errors.length === 0 ? { schedule: candidate as ScheduleV1, errors } : { schedule: null, errors };
}

function scheduleTriggerFromCreate(action: Readonly<Record<string, unknown>>, occurredAt: string): ScheduleTriggerV1 {
  if (Object.hasOwn(action, "everyMs") === Object.hasOwn(action, "cronExpression"))
    reject("invalid_command", "Schedule creation requires exactly one interval or cron trigger.");
  return Object.hasOwn(action, "everyMs")
    ? { kind: "interval", everyMs: Number(action.everyMs), anchorAt: occurredAt }
    : { kind: "cron", expression: String(action.cronExpression), timezone: String(action.timezone) };
}

function scheduleTriggerFromUpdate(
  action: Readonly<Record<string, unknown>>,
  current: unknown,
  occurredAt: string,
): ScheduleTriggerV1 | unknown {
  if (
    Object.hasOwn(action, "everyMs") &&
    (Object.hasOwn(action, "cronExpression") || Object.hasOwn(action, "timezone"))
  )
    reject("invalid_command", "Schedule update cannot combine interval and cron trigger fields.");
  if (Object.hasOwn(action, "everyMs"))
    return { kind: "interval", everyMs: Number(action.everyMs), anchorAt: occurredAt };
  if (Object.hasOwn(action, "cronExpression"))
    return { kind: "cron", expression: String(action.cronExpression), timezone: String(action.timezone) };
  if (Object.hasOwn(action, "timezone")) {
    const currentTrigger = record(current) ? current : null;
    if (currentTrigger?.kind !== "cron") reject("invalid_command", "Schedule timezone can only update a cron trigger.");
    return { ...currentTrigger, timezone: String(action.timezone) };
  }
  return current;
}

function scheduleMode(value: unknown): ScheduleMode {
  if (value === "detect" || value === "remediate") return value;
  reject("invalid_command", "Schedule mode must be detect or remediate.");
}

function text(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  reject("invalid_command", `${name} must be a non-empty string.`);
}

function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function rejectCriterion(actionId: string, criterionRef: string, code: string, message: string): never {
  throw attributeEntityActionCriterion(Object.assign(new Error(message), { code }), actionId, criterionRef);
}
