function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateHomeOverviewResult(value: unknown): readonly string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["home overview result must be an object"];
  }
  if (value.schema !== "daemon.gui.home-overview/v1") {
    errors.push("home overview schema is invalid");
  }
  if (value.ok !== true) {
    errors.push("home overview ok must be true");
  }
  if (typeof value.observedAt !== "string") {
    errors.push("home overview observedAt must be a string");
  }
  if (!Array.isArray(value.repos)) {
    errors.push("home overview repos must be an array");
  } else {
    for (let i = 0; i < value.repos.length; i++) {
      const repo = value.repos[i];
      if (!isRecord(repo)) {
        errors.push(`repos[${i}] must be an object`);
        continue;
      }
      if (typeof repo.repoId !== "string") errors.push(`repos[${i}].repoId must be a string`);
      if (typeof repo.displayName !== "string") errors.push(`repos[${i}].displayName must be a string`);
      if (typeof repo.isQuiet !== "boolean") errors.push(`repos[${i}].isQuiet must be a boolean`);
      if (!Array.isArray(repo.topMatters)) errors.push(`repos[${i}].topMatters must be an array`);
    }
  }
  return errors;
}
