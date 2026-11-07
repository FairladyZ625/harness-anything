/** Millisecond instant for validated UTC timestamps, matching Date.parse (including optional
 * and sub-millisecond fractions). SQLite's date functions round fractions, so give unixepoch
 * only whole seconds and truncate the fractional part separately. */
export function isoTimestampMillisecondsSql(value: string): string {
  return `(unixepoch(substr(${value}, 1, 19) || 'Z') * 1000 + CAST(substr(substr(${value}, 21, 3) || '000', 1, 3) AS INTEGER))`;
}
