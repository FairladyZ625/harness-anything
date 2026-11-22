export type OrderedFacetRow<Row> = Row & { readonly order?: number };

// Existing rows carry their original array positions. New rows without a position
// follow them in key order, so an addition never renumbers another package's rows.
export function facetRowsInOrder<Row extends object>(
  rows: OrderedFacetRow<Row>[],
  key: (row: Row) => string,
): readonly Row[] {
  rows.sort((left, right) => {
    const difference = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
    if (difference !== 0) return difference;
    const a = key(left),
      b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return Object.freeze(rows.map(({ order: _order, ...row }) => Object.freeze(row) as Row));
}
