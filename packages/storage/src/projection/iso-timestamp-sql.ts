/** Millisecond instant for validated UTC timestamps, matching Date.parse (including optional
 * and sub-millisecond fractions). SQLite's date functions round fractions, so give unixepoch
 * only whole seconds and truncate the fractional part separately. */
export function isoTimestampMillisecondsSql(value: string): string {
  return `(unixepoch(substr(${value}, 1, 19) || 'Z') * 1000 + CAST(substr(substr(${value}, 21, 3) || '000', 1, 3) AS INTEGER))`;
}

// SQLite and PostgreSQL both index this fixed-width UTC millisecond key. Truncating the
// fraction matches Date.parse, including inputs such as .1Z and .123456Z.
export function isoTimestampMillisecondsKeySql(value: string): string {
  return `(substr(${value},1,19) || '.' || substr(rtrim(substr(${value},21,3),'Z') || '000',1,3) || 'Z')`;
}
