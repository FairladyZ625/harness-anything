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
  assert.equal(typeof value.ok, "boolean");
  assert.equal(value.schema, "command-receipt/v2");
  assert.equal(typeof value.command, "string");
  assert.equal(typeof value.summary, "string");

  if (value.ok === true) {
    for (const key of disallowedSuccessTopLevel) {
      if (key === "rows") continue;
      assert.equal(Object.prototype.hasOwnProperty.call(value, key), false, `receipt leaked old top-level field ${key}`);
    }
  }

  const data = isRecord(value.details?.data) ? value.details.data : {};
  const paths = Object.fromEntries(Array.isArray(value.paths) ? value.paths.map((entry: Record<string, unknown>) => [entry.role, entry.path]) : []);
  return {
    ...data,
    ok: value.ok,
    command: legacyCommandForDisplay(value.command),
    receipt: value.schema,
    receiptSummary: value.summary,
    error: value.error,
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

function legacyCommandForDisplay(command: string): string {
  const legacy: Record<string, string> = {
    "task create": "new-task",
    "task transition": "status-set",
    "fact record": "record-fact",
    "distill promote": "distill-commit",
    "event append": "runtime-event-append",
    "event list": "runtime-event-list",
    "migrate plan": "migrate-plan",
    "migrate structure": "migrate-structure",
    "migrate provenance": "migrate-provenance",
    "migrate run": "migrate-run",
    "migrate verify": "migrate-verify",
    "legacy plan": "legacy-intake-plan",
    "legacy copy-docs": "legacy-copy-safe-docs",
    "git diff": "git-diff",
    "module step": "module-step"
  };
  return legacy[command] ?? command.replace(/ /gu, "-");
}
