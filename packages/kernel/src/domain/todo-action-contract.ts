import type { EntityActionContract, EntityActionInputField } from "./entity-kind-registry.ts";

const text = (field: string, required: boolean, flag?: string): EntityActionInputField => ({
  field,
  type: "string",
  required,
  ...(flag ? { cli: { name: flag, kind: "single", error: { code: "invalid_field" } } } : {}),
});
const target = text("todoId", true);
const expected: EntityActionInputField = {
  field: "expectedVersion",
  type: "number",
  required: false,
  cli: { name: "--expected-version", kind: "single", error: { code: "invalid_field" }, projection: "number" },
};
const key = text("idempotencyKey", false, "--idempotency-key");
export const todoActionDefinitions = [
  {
    id: "add",
    read: false,
    summary: "Add a one-line repository todo; relationships are optional.",
    fields: [text("text", true), text("relate", false, "--relate"), key],
  },
  {
    id: "list",
    read: true,
    summary: "List open todos by default; completed and archived items remain recoverable.",
    fields: [
      ...["open", "done", "archived", "all"].map(
        (field): EntityActionInputField => ({
          field,
          type: "boolean",
          required: false,
          cli: { name: `--${field}`, kind: "boolean", error: { code: "invalid_field" } },
        }),
      ),
      text("targetRef", false, "--target-ref"),
    ],
  },
  { id: "show", read: true, summary: "Show a todo and its relationships.", fields: [target] },
  {
    id: "done",
    read: false,
    summary: "Complete a todo; repeating completion has no effect.",
    fields: [target, expected, key],
  },
  {
    id: "reopen",
    read: false,
    summary: "Return a completed or archived todo to the open list.",
    fields: [target, expected, key],
  },
  {
    id: "archive",
    read: false,
    summary: "Archive a todo without deleting it or changing completion.",
    fields: [target, expected, key],
  },
  {
    id: "relate",
    read: false,
    summary: "Attach a todo to another entity with an optional relationship.",
    fields: [target, text("targetRef", true, "--target-ref"), key],
  },
  {
    id: "promote",
    read: false,
    summary: "Create a task in a work and link it to this todo atomically.",
    fields: [target, text("work", true, "--work"), key],
  },
] as const;

export function createTodoActionCatalog(baseAction: (id: string) => EntityActionContract) {
  return {
    ref: "kernel/todo-action/v1",
    actions: todoActionDefinitions.map(
      ({ id, read, fields, summary }): EntityActionContract => ({
        ...baseAction(id),
        input: { schema: "entity-action-input/v1", fields, exactlyOneOf: [] },
        explain: summary,
        concurrency: {
          expectedVersion: {
            authority: "canonical-entity-revision",
            required: false,
            arbitration: "center-single-write-queue",
          },
          leasePolicy: { authority: "repository-writer-epoch" },
          occurrenceClaim: { authority: "not-applicable" },
          idempotency: { authority: "operation-id", input: "idempotencyKey" },
          artifactOwnership: { owner: "todo/{id}", path: "todos/{id}.json" },
        },
        effects: read ? [] : [{ ref: "entity_upserted", projection: "entity/v1" }],
        execution: {
          ingress: `todo-${id}`,
          compile: null,
          read,
          implementation: "catalog-runtime",
          topology: "center-forward-write",
          targetIdField: "todoId",
        },
      }),
    ),
  };
}
