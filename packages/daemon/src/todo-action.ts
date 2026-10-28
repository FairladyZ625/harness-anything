import { createHash, randomBytes } from "node:crypto";
import {
  changeTodo,
  todoIsOpen,
  compileEntityUpsert,
  compileRelationCreatedEvent,
  deriveRelationId,
  compileRelationDocumentWrite,
  parseEntityRef,
  type Todo,
  type CanonicalWriteBundle,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoTaskAction, RepoCellBinding } from "./repo-cell-types.ts";
import { applyPreparedTaskCreate, prepareTaskCreateAt, type PreparedTaskCreate } from "./repo-cell-task-create.ts";
import { relationDocumentUpdates } from "./entity-action-relation.ts";
import { relationDirectionRegistry } from "./artifact-entity-action.ts";
import { noChanges, reject } from "./entity-action-write-helpers.ts";

import { readTodos, todoRelations } from "./todo-read.ts";

export function runTodoAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  opId: string,
): WriteReceiptDraft {
  const head = cell.store.readHead()?.revision ?? 0;
  if (action.kind === "todo-list") {
    const flags = [action.open, action.done, action.archived, action.all].filter((value) => value === true);
    if (flags.length > 1) reject("invalid_field", "Choose one of --open, --done, --archived or --all.");
    const attached =
      typeof action.targetRef === "string"
        ? new Set(todoRelations(cell.projection, { target: action.targetRef }).map((edge) => edge.sourceRef))
        : null;
    const todos = readTodos(cell.projection).filter(
      (todo) =>
        (!attached || attached.has(todo.ref)) &&
        (action.all === true ||
          (action.done === true ? todo.completed : action.archived === true ? todo.archived : todoIsOpen(todo))),
    );
    return cell.readResult(opId, { todos }, head, null);
  }
  const adding = action.kind === "todo-add",
    todoId = adding
      ? `todo_${typeof action.idempotencyKey === "string" ? createHash("sha256").update(`${cell.input.repoId}:${binding.actor.principal.personId}:${action.idempotencyKey}`).digest("hex").slice(0, 24) : randomBytes(12).toString("hex")}`
      : String(action.todoId ?? ""),
    row = cell.projection.getEntity("todo", todoId),
    current = row?.value as unknown as Todo | undefined;
  if (!adding && !current) reject("entity_not_found", `Todo ${todoId} does not exist.`);
  const ref = `todo/${todoId}`,
    relations = () => todoRelations(cell.projection, { source: ref });
  if (action.kind === "todo-show")
    return cell.readResult(
      opId,
      { todo: { ...current!, revision: row!.workspaceRevision, ref }, relations: relations() },
      head,
      null,
    );
  if (!adding && cell.store.readEvent(opId)) return unchanged(current!);
  if (action.expectedVersion !== undefined && action.expectedVersion !== (row?.workspaceRevision ?? 0))
    reject("revision_conflict", `Todo ${todoId} changed; read its current version and retry.`);
  let next: Todo;
  if (adding) {
    if (typeof action.text !== "string" || !action.text.trim() || action.text.trim().length > 2000)
      reject("invalid_field", "Todo text must contain 1–2000 characters.");
    next = { id: todoId, text: action.text.trim(), completed: false, archived: false };
    if (current) {
      if (
        current.text !== next.text ||
        (typeof action.relate === "string" && !relations().some((edge) => edge.targetRef === action.relate))
      )
        reject("revision_conflict", "This idempotency key already names another todo.");
      return unchanged(current);
    }
  } else next = current!;
  const preceding: CanonicalWriteBundle[] = [];
  let prepared: PreparedTaskCreate | undefined;
  if (action.kind === "todo-promote") {
    if (next.promotedTaskId) return unchanged(next, { taskRef: `task/${next.promotedTaskId}` });
    const work = typeof action.work === "string" ? action.work : "";
    const root = cell.projection.read(work).snapshot.task;
    if (!root || root.taskClass !== "work") reject("invalid_field", "--work must identify an existing work root task.");
    const taskAction = cell.taskCreateAction(cell.rootDir, {
      kind: "task-create",
      title: next.text,
      parentTaskId: work,
      idempotencyKey: `todo-promote:${todoId}`,
    });
    const result = prepareTaskCreateAt(cell, taskAction, binding, { workspaceRevision: head + 1 });
    if (!("compiled" in result)) return result;
    prepared = result;
    preceding.push(result.compiled);
    preceding.push(
      relationBundle(`task/${result.fields.taskId}`, "relates", head + 2, result.compiled.event.workspaceRevision),
    );
    next = { ...changeTodo(next, "done"), promotedTaskId: result.fields.taskId };
  } else if (action.kind === "todo-relate") {
    const target = requiredTarget(action.targetRef);
    if (relations().some((edge) => edge.relationType === "relates" && edge.targetRef === target))
      return unchanged(next);
    preceding.push(relationBundle(target, "relates", head + 1));
  } else if (adding && action.relate !== undefined) {
    // Validate before accepting either event. The entity precedes its relation in the atomic batch.
    requiredTarget(action.relate);
  } else if (action.kind === "todo-done" || action.kind === "todo-reopen" || action.kind === "todo-archive") {
    next = changeTodo(
      next,
      action.kind === "todo-done" ? "done" : action.kind === "todo-archive" ? "archive" : "reopen",
    );
    if (next.completed === current!.completed && next.archived === current!.archived) return unchanged(next);
  }
  const bundle = compileEntityUpsert({
    entityKind: "todo",
    entity: next,
    eventId: `event-${opId}`,
    opId: adding && action.relate ? `${opId}-todo` : opId,
    workspaceRevision: head + preceding.length + 1,
    actor: binding.actor,
    source: binding.source,
    occurredAt: cell.now(),
  });
  const batch: CanonicalWriteBundle[] =
    adding && typeof action.relate === "string"
      ? [bundle, relationBundle(action.relate, "relates", head + 2)]
      : [...preceding, bundle];
  const final = batch[batch.length - 1]!;
  cell.store.append({ ...final, preceding: batch.slice(0, -1) });
  // Once append accepts the batch, a projection/publication failure is indeterminate, never a rejection.
  try {
    for (const item of batch) {
      if (prepared && item === prepared.compiled) applyPreparedTaskCreate(cell, prepared);
      else cell.projection.apply(item.event, item.plan);
    }
    cell.input.killpoint?.("after_sqlite_commit");
    return {
      ...cell.readResult(
        opId,
        { todo: next, relations: relations(), ...(prepared ? { taskRef: `task/${prepared.fields.taskId}` } : {}) },
        final.event.workspaceRevision,
        null,
      ),
      authorizationDecision: binding.authorizationDecision,
    };
  } catch (error) {
    throw Object.assign(
      cell.cellCodedError("publication_indeterminate", error instanceof Error ? error.message : String(error)),
      { opId, cause: error },
    );
  }

  function unchanged(todo: Todo, extra = {}): WriteReceiptDraft {
    return noChanges({
      opId: `noop:${opId}`,
      revision: row!.workspaceRevision,
      headRevision: head,
      evidence: JSON.stringify({ todo, ...extra }),
      authorizationDecision: binding.authorizationDecision,
    });
  }
  function requiredTarget(value: unknown): string {
    if (typeof value !== "string" || !parseEntityRef(value) || parseEntityRef(value)!.externalHarness)
      reject("invalid_entity_ref", "Use a local entity ref such as task/<id>.");
    if (value === ref) reject("relation_invalid", "A todo cannot be attached to itself.");
    if (cell.projection.readEntityVersionWitness(value).currentVersion === null)
      reject("entity_not_found", `Relation target ${value} does not exist.`);
    return value;
  }
  function relationBundle(
    target: string,
    type: "relates",
    revision: number,
    targetVersion?: number,
  ): CanonicalWriteBundle {
    if (targetVersion === undefined) requiredTarget(target);
    const relationId = deriveRelationId({ source: ref, target, type, direction: "directed" });
    const previous = cell.projection.readRelationEdge(relationId);
    if (previous && previous.state !== "active")
      reject(
        "revision_conflict",
        `Use ha relation relate with --expected-version ${previous.workspaceRevision} to restore the retired relation.`,
      );
    const event = compileRelationCreatedEvent({
      record: {
        relation_id: relationId,
        source: ref,
        target,
        type,
        direction: "directed",
        origin: "declared",
        state: "active",
        rationale: "Attached repository todo.",
        targetObservedVersion: targetVersion ?? cell.projection.readEntityVersionWitness(target).currentVersion,
      },
      directions: relationDirectionRegistry(cell.projection, cell.input.repoId),
      actor: binding.actor,
      source: binding.source,
      opId: adding ? opId : `${opId}-relation`,
      occurredAt: cell.now(),
      workspaceRevision: revision,
    });
    return compileRelationDocumentWrite(event, relationDocumentUpdates(cell.projection, event, previous));
  }
}
