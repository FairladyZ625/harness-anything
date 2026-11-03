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
