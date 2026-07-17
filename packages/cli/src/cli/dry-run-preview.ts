import { cliError, CliErrorCode } from "./error-codes.ts";
import type { CliResult, ParsedCommand } from "./types.ts";

type Action = ParsedCommand["action"];

export interface DryRunPreview {
  readonly schema: "command-dry-run-preview/v1";
  readonly operation: string;
  readonly paths: ReadonlyArray<{
    readonly operation: "create" | "modify" | "delete";
    readonly path: string;
  }>;
  readonly summary: Record<string, unknown>;
  readonly checks: ReadonlyArray<string>;
}

export function finalizeDryRunResult(action: Action, result: CliResult): CliResult {
  if (!result.ok || !isDryRunAction(action)) return result;
  const report = reportRecord(result.report);
  const candidate: CliResult = {
    ...result,
    report: {
      ...report,
      preview: buildDryRunPreview(action, result)
    }
  };
  const violation = dryRunPreviewContractViolation(action, candidate);
  return violation ? {
    ok: false,
    command: result.command,
    error: cliError(CliErrorCode.CommandReceiptContractMismatch, violation)
  } : candidate;
}

/** Daemon dry-runs stop before canonical ingress, so they cannot enqueue or commit. */
export function dryRunResult(action: Action): CliResult {
  return finalizeDryRunResult(action, {
    ok: true,
    command: action.kind,
    ...(dryRunTaskId(action) ? { taskId: dryRunTaskId(action) } : {}),
    ...(action.kind === "progress-append" ? { path: "progress.md" } : {})
  });
}

function dryRunTaskId(action: Action): string | undefined {
  return "taskId" in action && typeof action.taskId === "string" ? action.taskId : undefined;
}

export function dryRunPreviewContractViolation(action: Action, result: CliResult): string | undefined {
  if (!result.ok || !isDryRunAction(action)) return undefined;
  const preview = reportRecord(result.report).preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    return `dry-run receipt for command ${action.kind} must include preview. Next: emit command-dry-run-preview/v1 with paths, summary, and checks.`;
  }
  const value = preview as Partial<DryRunPreview>;
  if (value.schema !== "command-dry-run-preview/v1" || !Array.isArray(value.paths) || !value.summary || !Array.isArray(value.checks)) {
    return `dry-run receipt for command ${action.kind} emitted an invalid preview. Next: emit command-dry-run-preview/v1 with paths, summary, and checks.`;
  }
  return undefined;
}

function reportRecord(report: unknown): Record<string, unknown> {
  if (report && typeof report === "object" && !Array.isArray(report)) return report as Record<string, unknown>;
  return report === undefined ? {} : { value: report };
}

export function isDryRunAction(action: Action): boolean {
  if ("dryRun" in action && action.dryRun === true) return true;
  if ("mode" in action && action.mode === "dry-run") return true;
  return action.kind === "doc-sync" && action.mode === "dry-run";
}

function buildDryRunPreview(action: Action, result: CliResult): DryRunPreview {
  return {
    schema: "command-dry-run-preview/v1",
    operation: action.kind,
    paths: previewPaths(action, result),
    summary: previewSummary(action),
    checks: previewChecks(action)
  };
}

function previewPaths(action: Action, result: CliResult): DryRunPreview["paths"] {
  const operation = pathOperation(action);
  const values = [
    result.path,
    result.packagePath,
    result.projectionPath,
    ...(result.generated ?? [])
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(values)].map((path) => ({ operation, path }));
}

function pathOperation(action: Action): DryRunPreview["paths"][number]["operation"] {
  if (action.kind === "preset-uninstall") return "delete";
  if (
    action.kind.includes("amend") ||
    action.kind.includes("invalidate") ||
    action.kind.includes("relate") ||
    action.kind.includes("relation") ||
    action.kind.includes("migrate") ||
    action.kind.includes("sync") ||
    action.kind.includes("rebuild") ||
    action.kind.includes("accept") ||
    action.kind.includes("reject") ||
    action.kind.includes("defer") ||
    action.kind.includes("supersede") ||
    action.kind.includes("retire")
  ) return "modify";
  return "create";
}

function previewSummary(action: Action): Record<string, unknown> {
  if (action.kind === "decision-propose") {
    return {
      decisionId: action.decisionId ?? "generated",
      title: action.title,
      question: action.question,
      chosenCount: action.chosen.length,
      rejectedCount: action.rejected.length,
      claimCount: action.claims.length || 1,
      fulfillmentCount: action.fulfillments.length,
      evidenceRelationCount: action.evidenceRelations.length
    };
  }
  return Object.fromEntries(Object.entries(action)
    .filter(([key]) => !["kind", "dryRun", "mode"].includes(key))
    .map(([key, value]) => [key, summarizeValue(key, value)]));
}

function summarizeValue(key: string, value: unknown): unknown {
  if (Array.isArray(value)) return { count: value.length, items: value };
  if (value && typeof value === "object") return { fieldCount: Object.keys(value).length, fields: value };
  if (key === "body" && typeof value === "string") return { characterCount: value.length };
  return value;
}

function previewChecks(action: Action): ReadonlyArray<string> {
  if (action.kind.startsWith("decision-")) return ["decision-schema", "decision-write-policy", "write-coordinator"];
  if (action.kind === "record-fact" || action.kind === "fact-invalidate") return ["fact-schema", "fact-write-policy", "write-coordinator"];
  if (action.kind === "new-task" || action.kind === "task-relate") return ["task-contract", "write-coordinator"];
  if (action.kind === "script-run") return ["script-contract", "read-write-scopes", "output-boundary"];
  if (action.kind.startsWith("migrate-") || action.kind === "task-contract-migrate") return ["migration-plan", "write-coordinator"];
  return [];
}
