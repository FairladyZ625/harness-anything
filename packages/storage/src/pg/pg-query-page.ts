export function checkedPageLimit(value: number, maximum = 500): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`query page limit must be an integer between 1 and ${maximum}`);
  return value;
}
