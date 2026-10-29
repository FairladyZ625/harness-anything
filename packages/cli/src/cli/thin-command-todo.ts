function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function renderTodoList(receipt: Record<string, unknown>): string {
  let payload: unknown;
  try {
    payload = JSON.parse(typeof receipt.evidence === "string" ? receipt.evidence : "{}");
  } catch (error) {
    throw new TypeError("Todo list receipt evidence must be valid JSON.", { cause: error });
  }
  const todos = record(payload) && Array.isArray(payload.todos) ? payload.todos.filter(record) : [];
  return todos.length === 0
    ? "No todos."
    : todos
        .map((todo) => {
          const id = typeof todo.id === "string" ? todo.id : "todo_unknown",
            marker = todo.completed === true ? "✓" : "○",
            text = typeof todo.text === "string" ? todo.text : "",
            relations = Array.isArray(todo.relations) ? todo.relations.filter(record) : [],
            relationText = relations
              .map((relation) => (typeof relation.title === "string" ? relation.title : ""))
              .filter(Boolean)
              .map((title) => `[关联: ${title}]`)
              .join(" "),
            shortId = id.startsWith("todo_") ? `todo_${id.slice(5, 9)}` : id.slice(0, 9);
          return [marker, text, relationText, shortId].filter(Boolean).join("  ");
        })
        .join("\n");
}
