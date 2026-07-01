import assert from "node:assert/strict";

const disallowedSuccessTopLevel = [
  "taskId",
  "slug",
  "status",
  "path",
  "packagePath",
  "projectionPath",
  "mode",
  "migrationMode",
  "tasks",
  "templates",
  "presets",
  "preset",
  "modules",
  "module",
  "document",
  "evidenceBundle",
  "issues",
  "rows",
  "version",
  "report",
  "snapshot",
  "profile",
  "generated",
  "reviewContract",
  "completionGate",
  "forced",
  "forceAudit",
  "commands",
  "launchPlan"
] as const;

export function unwrapCommandReceipt(value: Record<string, any>): Record<string, any> {
  assert.equal(value.ok, true);
  assert.equal(value.receipt, "CommandReceipt/v1");
  assert.equal(typeof value.command, "string");
  assert.equal(typeof value.summary, "string");

  for (const key of disallowedSuccessTopLevel) {
    assert.equal(Object.prototype.hasOwnProperty.call(value, key), false, `receipt leaked old top-level field ${key}`);
  }

  const data = isRecord(value.data) ? value.data : {};
  const paths = isRecord(value.paths) ? value.paths : {};
  return {
    ...data,
    ok: value.ok,
    command: value.command,
    receipt: value.receipt,
    receiptSummary: value.summary,
    paths,
    warnings: Array.isArray(value.warnings) ? value.warnings : [],
    path: paths.primary,
    packagePath: paths.package,
    projectionPath: paths.projection
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
