/** Millisecond instant for validated UTC timestamps, matching Date.parse (including optional
 * and sub-millisecond fractions). SQLite's date functions round fractions, so give unixepoch
 * only whole seconds and truncate the fractional part separately. */
export function isoTimestampMillisecondsSql(value: string): string {
  return `(unixepoch(substr(${value}, 1, 19) || 'Z') * 1000 + CAST(substr(substr(${value}, 21, 3) || '000', 1, 3) AS INTEGER))`;
}

/** ISO instant in UTC milliseconds. Parse whole seconds and apply the numeric offset explicitly
 * so fractions truncate like Date.parse and offsets have the same range in both engines. */
export function isoOffsetTimestampMillisecondsSql(value: string, epochSeconds: string): string {
  const zone = `substr(${value},length(${value})-5,6)`,
    hasOffset = `length(${value})>=25 AND substr(${value},length(${value}),1)<>'Z'`,
    offsetMinutes = `(CAST(substr(${zone},2,2) AS INTEGER)*60 + CAST(substr(${zone},5,2) AS INTEGER))`,
    fraction = `substr(${value},21,length(${value})-CASE WHEN ${hasOffset} THEN 26 ELSE 21 END)`;
  return `((${epochSeconds})*1000
    + CASE WHEN substr(${value},20,1)='.' THEN CAST(substr(${fraction} || '000',1,3) AS INTEGER) ELSE 0 END
    + CASE WHEN ${hasOffset} THEN (CASE WHEN substr(${zone},1,1)='+' THEN -60000 ELSE 60000 END)*${offsetMinutes} ELSE 0 END)`;
}
