import type { EntityDocumentJsonSchema } from "./entity-json-schema.ts";

/** Completion and archival are independent: archiving never changes whether the work was done. */
export interface Todo {
  readonly id: string;
  readonly text: string;
  readonly completed: boolean;
  readonly archived: boolean;
  readonly promotedTaskId?: string;
}

export const todoSchema: EntityDocumentJsonSchema<Todo> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "todo/v1",
  type: "object",
  properties: {
    id: { type: "string", pattern: "^todo_[a-f0-9]{24}$" },
    text: { type: "string", minLength: 1 },
    completed: { type: "boolean" },
    archived: { type: "boolean" },
    promotedTaskId: { type: "string", minLength: 1 },
  },
  required: ["id", "text", "completed", "archived"],
  additionalProperties: false,
};

export function todoIsOpen(todo: Todo): boolean {
  return !todo.completed && !todo.archived;
}

export function changeTodo(todo: Todo, action: "done" | "reopen" | "archive"): Todo {
  if (action === "done") return { ...todo, completed: true };
  if (action === "archive") return { ...todo, archived: true };
  return { ...todo, completed: false, archived: false };
}
