import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/**
 * Todo stacking is a soft limit, never an admission gate: the todo is written either way, and
 * the receipt carries this advisory so every surface renders one sentence from one place.
 * 0 disables the reminder, which is how a repository says "let the list grow on purpose".
 */
export const DEFAULT_TODO_SOFT_LIMIT = 30;

export const TODO_SOFT_LIMIT_SETTING = "settings.todos.softLimit";

/** The reminder for an add that pushed the open list past the limit; null when it stays quiet. */
export function todoSoftLimitAdvisory(openTodos: number, softLimit: number): string | null {
  if (softLimit <= 0 || openTodos <= softLimit) return null;
  return (
    `${openTodos} unfinished todos exceed the soft limit of ${softLimit} (${TODO_SOFT_LIMIT_SETTING}). ` +
    "Review the list with `ha todo list`, close finished ones with `ha todo done <todo-id>`, " +
    "and turn work that needs fixing into a task with `ha task create`. " +
    "This todo was still added; set the soft limit to 0 to turn this reminder off."
  );
}

// dec_7E44897ECDCAEF2B92EC66A260/CH1: the advisory threshold is declared beside the constants it binds.
export const todoSoftLimitPolicy = {
  id: "todo-soft-limit",
  ownerRef: "todo",
  unit: "open todos",
  bounds:
    "The advisory appears only when the open todo count exceeds a positive soft limit (default 30, settings.todos.softLimit); 0 or less disables it. The todo is written either way.",
  defaultValue: { openTodos: DEFAULT_TODO_SOFT_LIMIT, settingPath: TODO_SOFT_LIMIT_SETTING },
  version: 1,
  scope: "todo add receipts",
  reason: "The soft limit is a reminder, never an admission gate; one declaration names its default and setting.",
  fixtures: ["packages/kernel/test/domain/todo-soft-limit.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/todo-soft-limit.ts#DEFAULT_TODO_SOFT_LIMIT:990da769f67c471c724109fb86bd766c",
    "policy:packages/kernel:packages/kernel/src/domain/todo-soft-limit.ts#TODO_SOFT_LIMIT_SETTING:e30151ad5df756409e3110f21b14acd6",
    "policy:packages/kernel:packages/kernel/src/domain/todo-soft-limit.ts#todoSoftLimitAdvisory:994691b3d0d36b8f62066039eea2268a",
  ].map((candidateId) => ({ candidateId, route: "todoSoftLimitAdvisory" })),
} as const satisfies OntologyPolicyDeclaration;
// Source identities and values for daemon policy declarations registered by EntityKindContract.
export const daemonTodoPolicySources = [
  [
    "policy:packages/daemon:packages/daemon/src/todo-read.ts#todoRelations.page.limit:281836eca24c2eb78d50f8542399ca4d",
    "packages/daemon/src/todo-read.ts#todoRelations.page.limit",
    'const page = projection.readRelationQuery({ ...query, state: "active", limit: 100, ...(cursor ? { cursor } : {}) });',
  ],
] as const;
