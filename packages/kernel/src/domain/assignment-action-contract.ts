import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";
import type { EntityActionCompileHook } from "./entity-action-execution.ts";
import { withDerivedActionReturns } from "./entity-action-descriptor.ts";
import { compileRelationCreatedEvent, compileRelationRetiredEvent } from "./relation-event.ts";
import { deriveRelationId } from "./entity-relation.ts";
import { assignmentRationale } from "./entity-relation.ts";
import { CONTRACT_VERSION_1_0 } from "./contract-version.ts";

function assignmentIdField(kind: string): string {
  return `${kind.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())}Id`;
}

const assignmentFields = (kind: string, includeTarget: boolean): EntityActionInputField[] => [
  {
    field: assignmentIdField(kind),
    type: "string" as const,
    required: true,
    value: { kind: "string" as const },
  },
  { field: "expectedVersion", type: "number" as const, required: true, value: { kind: "number" as const } },
  ...(includeTarget
    ? [
        { field: "personId", type: "string" as const, required: false },
        { field: "nodeId", type: "string" as const, required: false },
        { field: "teamId", type: "string" as const, required: false },
        { field: "expiresAt", type: "string" as const, required: false },
      ]
    : []),
];

const assignmentInput = (kind: string, includeTarget: boolean): EntityActionInputContract =>
  Object.freeze({
    schema: "entity-action-input/v1",
    fields: Object.freeze(assignmentFields(kind, includeTarget)),
    exactlyOneOf: Object.freeze(includeTarget ? [["personId", "nodeId", "teamId"]] : []),
  });

function targetRef(input: Readonly<Record<string, unknown>>): string {
  if (typeof input.personId === "string" && input.personId.trim()) return `person/${input.personId}`;
  if (typeof input.nodeId === "string" && input.nodeId.trim()) return `node/${input.nodeId}`;
  if (typeof input.teamId === "string" && input.teamId.trim()) return `team/${input.teamId}`;
  throw Object.assign(new Error("Assignment requires personId, nodeId or teamId."), { code: "invalid_field" });
}

function subjectRef(input: Readonly<Record<string, unknown>>, kind: string): string {
  if (typeof input.entityRef === "string" && input.entityRef.startsWith(`${kind}/`)) return input.entityRef;
  const idField = assignmentIdField(kind);
  if (typeof input[idField] === "string" && input[idField].trim()) return `${kind}/${input[idField]}`;
  throw Object.assign(new Error(`Assignment entityRef must be a ${kind} reference.`), { code: "invalid_field" });
}

export function assignmentActionCompiler(kind: string, id: "assign" | "unassign"): EntityActionCompileHook {
  return (input) => {
    const source = subjectRef(input.action, kind),
      target = id === "assign" ? targetRef(input.action) : null,
      identity =
        target === null ? null : { source, target, type: "assigned-to" as const, direction: "directed" as const },
      relationId = identity ? deriveRelationId(identity) : String(input.action.relationId ?? "");
    if (id === "unassign")
      return {
        kind: "relation",
        event: compileRelationRetiredEvent({
          relationId,
          reason: "assignment removed",
          actor: input.actor,
          source: input.source,
          opId: input.opId,
          occurredAt: input.occurredAt,
          workspaceRevision: input.workspaceRevision,
        }),
      };
    const expiresAt = typeof input.action.expiresAt === "string" ? input.action.expiresAt : null;
    if (!expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(input.occurredAt))
      throw Object.assign(new Error("Assignment expiry must be a future ISO timestamp."), { code: "invalid_field" });
    return {
      kind: "relation",
      event: compileRelationCreatedEvent({
        record: {
          relation_id: relationId,
          source,
          target: target!,
          type: "assigned-to",
          direction: "directed",
          origin: "declared",
          state: "active",
          rationale: assignmentRationale(expiresAt),
          targetObservedVersion: input.currentTargetVersion ?? null,
        },
        actor: input.actor,
        source: input.source,
        opId: input.opId,
        occurredAt: input.occurredAt,
        workspaceRevision: input.workspaceRevision,
        ...(input.relationDirections ? { directions: input.relationDirections } : {}),
      }),
    };
  };
}

export function createAssignmentActionCatalog(
  kind: string,
  refTemplate: string,
  baseAction: (id: string) => EntityActionContract,
): readonly EntityActionContract[] {
  const idField = assignmentIdField(kind);
  const action = (id: "assign" | "unassign") => {
    const declaration = baseAction(id);
    return withDerivedActionReturns({
      ...declaration,
      id,
      version: CONTRACT_VERSION_1_0,
      input: assignmentInput(kind, id === "assign"),
      policy: Object.freeze({ ...declaration.policy, action: `${kind}/${id}` }),
      criteria: Object.freeze([
        {
          ref: "assignment/entity-revision",
          failureCode: "revision_conflict",
          explain: "The subject revision must match the canonical cut.",
        },
        ...(kind === "task"
          ? [
              {
                ref: "task-assignment/no-held-lease",
                failureCode: "lease_conflict",
                explain: "Task assignment changes require no held execution lease.",
              },
            ]
          : []),
      ]),
      failureCodes: Object.freeze([
        {
          code: "revision_conflict",
          source: "criterion" as const,
          explain: "The entity assignment revision changed at the center before this write arrived.",
          nextCapabilityRef: "entity.read",
        },
        ...(kind === "task"
          ? [
              {
                code: "lease_conflict",
                source: "criterion" as const,
                explain: "The task has a reserving or held execution lease.",
                nextCapabilityRef: "task.release",
              },
            ]
          : []),
      ]),
      concurrency: Object.freeze({
        expectedVersion: Object.freeze({ authority: "entity-assignment-revision", required: true }),
        leasePolicy: Object.freeze({ authority: kind === "task" ? "task-lease/v1" : "none" }),
        occurrenceClaim: Object.freeze({ authority: "not-applicable" }),
        idempotency: Object.freeze({ authority: "operation-id" }),
        artifactOwnership: Object.freeze({ owner: "entity", refTemplate }),
      }),
      effects: Object.freeze([{ ref: `assignment/${id}`, projection: "relation/v1" }]),
      explain: `${kind}.${id} manages the canonical assigned-to relation through the center writer.`,
      execution: Object.freeze({
        ingress: `${kind}-${id}`,
        compile: assignmentActionCompiler(kind, id),
        read: false,
        implementation: "compiled-event" as const,
        topology: "center-forward-write" as const,
        remoteEdgeAdmission: "via-center-forward" as const,
        targetIdField: idField,
      }),
    });
  };
  return Object.freeze([action("assign"), action("unassign")]);
}
