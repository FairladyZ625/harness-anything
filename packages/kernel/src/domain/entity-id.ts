import type { TaskId } from "./task.ts";

export type EntityId = `task/${string}` | `decision/${string}`;

export interface ParsedWriteEntityId {
  readonly kind: "task" | "decision";
  readonly id: string;
}

const writeEntityIdPattern = /^(?<kind>task|decision)\/(?<id>[A-Za-z0-9_-]+)$/u;

export function taskEntityId(taskId: TaskId): EntityId {
  return `task/${taskId}`;
}

export function decisionEntityId(decisionId: string): EntityId {
  return `decision/${decisionId}`;
}

export function parseWriteEntityId(entityId: EntityId): ParsedWriteEntityId | null {
  const match = entityId.match(writeEntityIdPattern);
  const kind = match?.groups?.kind;
  const id = match?.groups?.id;
  if ((kind !== "task" && kind !== "decision") || !id) return null;
  return { kind, id };
}

export function taskIdFromEntityId(entityId: EntityId): TaskId | null {
  const parsed = parseWriteEntityId(entityId);
  return parsed?.kind === "task" ? parsed.id : null;
}

export function decisionIdFromEntityId(entityId: EntityId): string | null {
  const parsed = parseWriteEntityId(entityId);
  return parsed?.kind === "decision" ? parsed.id : null;
}
