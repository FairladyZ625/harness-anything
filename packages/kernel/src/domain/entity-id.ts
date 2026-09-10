import type { TaskId } from "./task.ts";

export type EntityId = `task/${string}` | `decision/${string}` | `module/${string}`;

export interface ParsedWriteEntityId {
  readonly kind: "task" | "decision" | "module";
  readonly id: string;
}

const writeEntityIdPattern = /^(?<kind>task|decision|module)\/(?<id>[A-Za-z0-9._-]+)$/u;

export function taskEntityId(taskId: TaskId): EntityId {
  return `task/${taskId}`;
}

export function decisionEntityId(decisionId: string): EntityId {
  return `decision/${decisionId}`;
}

export function moduleEntityId(moduleKey: string): EntityId {
  return `module/${moduleKey}`;
}

export function parseWriteEntityId(entityId: EntityId): ParsedWriteEntityId | null {
  const match = entityId.match(writeEntityIdPattern);
  const kind = match?.groups?.kind;
  const id = match?.groups?.id;
  if ((kind !== "task" && kind !== "decision" && kind !== "module") || !id) return null;
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

export function moduleKeyFromEntityId(entityId: EntityId): string | null {
  const parsed = parseWriteEntityId(entityId);
  return parsed?.kind === "module" ? parsed.id : null;
}
