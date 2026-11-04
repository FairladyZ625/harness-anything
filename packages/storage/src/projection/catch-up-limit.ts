export function projectionCatchUpLimit(value = 4096): number {
  if (!Number.isInteger(value) || value < 1 || value > 4096)
    throw new Error("task projection catch-up limit must be between 1 and 4096");
  return value;
}
