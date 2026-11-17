import {
  collectQueryEvents,
  migrateTaskAssignments,
  relationEventWritePlan,
  isRelationEvent,
  type TaskEventV1,
} from "@harness-anything/kernel";
import type { AssignmentMigrationCommandCell, CommandAction, CommandBinding } from "./command-ports.ts";

/** One-shot migration boundary: legacy task events are input, Relation events are the only live output. */
export function runAssignmentMigrationAction(
  cell: AssignmentMigrationCommandCell,
  action: CommandAction,
  binding: CommandBinding,
) {
  const legacy = collectQueryEvents(cell.store, [
    { eventType: "task_assigned" },
    { eventType: "task_unassigned" },
  ]).filter((event): event is TaskEventV1 => event.schema === "task-event/v1");
  const report = migrateTaskAssignments(legacy),
    opId = cell.operationId(action, binding, cell.input.repoId, cell.store.readHead()?.revision ?? 0),
    already = new Set<string>(),
    appended: string[] = [];
  if (action.dryRun === true)
    return cell.previewResult(
      opId,
      {
        schema: "assignment-migration/v1",
        dryRun: true,
        assigned: report.assigned,
        unassigned: report.unassigned,
        invalid: report.invalid,
        converted: report.converted.length,
        sourceEvents: legacy.length,
      },
      cell.store.readHead()?.revision ?? 0,
      "ha migrate assignment",
    );
  let revision = cell.store.readHead()?.revision ?? 0;
  for (const original of report.converted) {
    if (!isRelationEvent(original) || already.has(original.opId)) continue;
    already.add(original.opId);
    if (cell.store.readEvent(original.opId)) continue;
    revision += 1;
    const event = { ...original, eventId: `event-${original.opId}`, workspaceRevision: revision };
    const plan = relationEventWritePlan(event);
    cell.store.append({ event, plan, blobs: [] });
    cell.projection.apply(event, plan);
    appended.push(event.opId);
  }
  return cell.readResult(
    opId,
    {
      schema: "assignment-migration/v1",
      dryRun: false,
      assigned: report.assigned,
      unassigned: report.unassigned,
      invalid: report.invalid,
      converted: report.converted.length,
      appended: appended.length,
      sourceEvents: legacy.length,
      parity: appended.every((entry) => cell.store.readEvent(entry) !== null),
    },
    revision,
    true,
  );
}
