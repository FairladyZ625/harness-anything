import { readFileSync } from "node:fs";
import path from "node:path";

export function validateTestQuarantine(value) {
  const errors = [];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== "harness-test-quarantine/v1" ||
    !Array.isArray(value.tests)
  ) {
    return ["test quarantine must be a harness-test-quarantine/v1 object with a tests array"];
  }
  const seen = new Set();
  for (const [index, entry] of value.tests.entries()) {
    const label = `test quarantine entry ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const fields = Object.keys(entry);
    if (fields.some((field) => !["test", "ownerTask", "quarantinedAt"].includes(field)))
      errors.push(`${label} has unknown fields`);
    if (typeof entry.test !== "string" || !entry.test.trim()) errors.push(`${label} requires a non-empty test name`);
    if (typeof entry.ownerTask !== "string" || !/^task_[a-zA-Z0-9]+$/u.test(entry.ownerTask))
      errors.push(`${label} requires ownerTask task_<id>`);
    if (
      typeof entry.quarantinedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(entry.quarantinedAt) ||
      !Number.isFinite(Date.parse(`${entry.quarantinedAt}T00:00:00.000Z`))
    )
      errors.push(`${label} requires quarantinedAt YYYY-MM-DD`);
    if (typeof entry.test === "string") {
      if (seen.has(entry.test)) errors.push(`${label} duplicates ${entry.test}`);
      seen.add(entry.test);
    }
  }
  return errors;
}

export function readTestQuarantine(repoRoot) {
  const value = JSON.parse(readFileSync(path.join(repoRoot, "tools/test-quarantine.json"), "utf8"));
  const errors = validateTestQuarantine(value);
  if (errors.length) throw new Error(errors.join("\n"));
  return value.tests;
}
