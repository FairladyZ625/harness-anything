const entityValueFilterField = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Validate the caller's value-equality filter before a field name becomes a SQL identifier. */
export function entityValueFilterEntries(
  valueEquals: Readonly<Record<string, string | number | boolean>>,
): readonly (readonly [string, string | number | boolean])[] {
  const entries = Object.entries(valueEquals);
  for (const [field] of entries)
    if (!entityValueFilterField.test(field))
      throw new Error(`entity value filter field is not a plain identifier: ${field}`);
  return entries;
}
