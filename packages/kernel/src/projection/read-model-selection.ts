/** SQL predicates over keys touched by a projection transaction; absent tables produce no rows. */
export type ReadModelSelection = ReadonlyMap<string, string>;

export function selectReadModelRows(sql: string, table: string, selection?: ReadModelSelection): string {
  if (!selection) return sql;
  const order = sql.lastIndexOf(" ORDER BY "),
    query = order < 0 ? sql : sql.slice(0, order),
    predicate = selection.get(table) ?? "0",
    where = query.search(/\bWHERE\b/u);
  return (
    (where < 0
      ? `${query} WHERE ${predicate}`
      : `${query.slice(0, where)} WHERE (${query.slice(where + 5)}) AND (${predicate})`) +
    (order < 0 ? "" : sql.slice(order))
  );
}
