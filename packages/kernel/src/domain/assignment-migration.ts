import { assignmentRationale, deriveRelationId } from "./entity-relation.ts";
import { compileRelationCreatedEvent, compileRelationRetiredEvent, type RelationEventV1 } from "./relation-event.ts";
import type { TaskEventV1 } from "./task-lifecycle-event.ts";
import type { TaskAssignment } from "./task-assignment.ts";

export interface AssignmentMigrationReport {
  readonly converted: readonly RelationEventV1[];
  readonly assigned: number;
  readonly unassigned: number;
  readonly invalid: number;
}

/** Convert legacy Task assignment mutations into replay-only Relation facts. */
export function migrateTaskAssignments(events: readonly TaskEventV1[]): AssignmentMigrationReport {
  const current = new Map<
      string,
      { readonly relationId: string; readonly target: string; readonly expiresAt: string }
    >(),
    converted: RelationEventV1[] = [];
  let assigned = 0,
    unassigned = 0,
    invalid = 0;
  for (const event of events) {
    if (event.schema !== "task-event/v1" || !["task_assigned", "task_unassigned"].includes(event.type)) continue;
    const task = event.payload.task,
      source = `task/${task.taskId}`,
      assignment = task.assignment;
    if (event.type === "task_assigned") {
      const target = targetRef(assignment);
      if (!target || !assignment || !futureExpiry(assignment.expiresAt, event.occurredAt)) {
        invalid += 1;
        continue;
      }
      const prior = current.get(source);
      if (prior !== undefined) {
        if (prior.target === target && prior.expiresAt === assignment.expiresAt) {
          assigned += 1;
          continue;
        }
        // Legacy Task assignment was a single field. Preserve that invariant in the Relation
        // stream by retiring the prior edge before creating a replacement, including expiry-only
        // changes for the same principal.
        converted.push(
          compileRelationRetiredEvent({
            relationId: prior.relationId,
            reason: "legacy task assignment replaced",
            actor: event.actor,
            source: event.source,
            opId: `assignment-migration-${event.opId}-retire-${prior.relationId}`,
            occurredAt: event.occurredAt,
            workspaceRevision: event.workspaceRevision,
          }),
        );
      }
      const identity = { source, target, type: "assigned-to" as const, direction: "directed" as const },
        relationId = deriveRelationId(identity),
        relation = compileRelationCreatedEvent({
          record: {
            relation_id: relationId,
            source,
            target,
            type: "assigned-to",
            direction: "directed",
            origin: "declared",
            state: "active",
            rationale: assignmentRationale(assignment.expiresAt),
            targetObservedVersion: null,
          },
          actor: event.actor,
          source: event.source,
          opId: `assignment-migration-${event.opId}`,
          occurredAt: event.occurredAt,
          workspaceRevision: event.workspaceRevision,
        });
      converted.push(relation);
      current.set(source, { relationId, target, expiresAt: assignment.expiresAt });
      assigned += 1;
      continue;
    }
    const prior = current.get(source);
    if (!prior) {
      invalid += 1;
      continue;
    }
    converted.push(
      compileRelationRetiredEvent({
        relationId: prior.relationId,
        reason: "legacy task assignment removed",
        actor: event.actor,
        source: event.source,
        opId: `assignment-migration-${event.opId}`,
        occurredAt: event.occurredAt,
        workspaceRevision: event.workspaceRevision,
      }),
    );
    current.delete(source);
    unassigned += 1;
  }
  return { converted: Object.freeze(converted), assigned, unassigned, invalid };
}

function targetRef(assignment: TaskAssignment | null | undefined): string | null {
  if (!assignment) return null;
  if (assignment.assignee.kind === "team") return `team/${assignment.assignee.teamId}`;
  if (assignment.assignee.kind === "node") return `node/${assignment.assignee.nodeId}`;
  return assignment.assignee.nodeId ? `node/${assignment.assignee.nodeId}` : `person/${assignment.assignee.personId}`;
}

function futureExpiry(value: string, occurredAt: string): boolean {
  const expiry = Date.parse(value),
    occurred = Date.parse(occurredAt);
  return Number.isFinite(expiry) && Number.isFinite(occurred) && expiry > occurred;
}
