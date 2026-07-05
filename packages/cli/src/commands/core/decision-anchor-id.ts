export function nextDecisionAnchorId(prefix: string, existingIds: ReadonlyArray<string>, minimum = 1): string {
  const max = existingIds.reduce((current, id) => {
    const match = new RegExp(`^${prefix}(\\d+)$`, "u").exec(id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, minimum - 1);
  return `${prefix}${max + 1}`;
}
