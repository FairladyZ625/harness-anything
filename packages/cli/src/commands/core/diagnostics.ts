import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import { runDoctor } from "../doctor.ts";
import { runGitDiffEvidence } from "../git-diff.ts";
import { runGraphCommand } from "../graph.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type DiagnosticsAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "git-diff" | "doctor" | "graph" | "diagnostics-command-usage" }>;

export const runDiagnosticsCommand: CommandRunner = (context, command) => {
  const action = command.action as DiagnosticsAction;
  if (action.kind === "git-diff") return Effect.sync(() => runGitDiffEvidence(command.rootDir, action.baseRef));
  if (action.kind === "graph") return Effect.sync(() => runGraphCommand(command.rootDir, action));
  if (action.kind === "diagnostics-command-usage") return Effect.sync(() => runCommandUsageDiagnostics(command.rootDir, context.commandSpecs));
  return Effect.sync(() => runDoctor(context.layoutInput));
};

interface CommandUsageRow {
  readonly commandKind: string;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly unknown: number;
  readonly total: number;
  readonly deprecated: number;
  readonly failureRate: number;
  readonly errorCodes: ReadonlyArray<{ readonly errorCode: string; readonly count: number }>;
}

type CountedStatus = "succeeded" | "failed" | "cancelled" | "unknown";

function runCommandUsageDiagnostics(rootDir: string, commandSpecs: Parameters<CommandRunner>[0]["commandSpecs"]) {
  const layout = resolveHarnessLayout(rootDir);
  const ledgerRoot = layout.runtimeEventLedgerRoot;
  const warnings: string[] = [];
  const stats = new Map<string, { succeeded: number; failed: number; cancelled: number; unknown: number; errorCodes: Map<string, number> }>();
  const deprecatedStats = new Map<string, number>();
  let totalEvents = 0;
  let resultEvents = 0;
  const sessions = new Set<string>();
  if (existsSync(ledgerRoot)) {
    for (const fileName of readdirSync(ledgerRoot).filter((entry) => entry.endsWith(".jsonl")).sort()) {
      const filePath = path.join(ledgerRoot, fileName);
      const lines = readFileSync(filePath, "utf8").split(/\r?\n/u).filter((line) => line.trim().length > 0);
      for (const [index, line] of lines.entries()) {
        totalEvents += 1;
        try {
          const event = JSON.parse(line) as Record<string, any>;
          const sessionId = typeof event.session?.sessionId === "string" ? event.session.sessionId : fileName.replace(/\.jsonl$/u, "");
          sessions.add(sessionId);
          if (event.kind !== "result" || !event.result) continue;
          resultEvents += 1;
          const commandKind = eventCommandKind(event);
          if (event.tool?.deprecated === true) {
            deprecatedStats.set(commandKind, (deprecatedStats.get(commandKind) ?? 0) + 1);
          }
          const status: CountedStatus = event.result.status === "succeeded" || event.result.status === "failed" || event.result.status === "cancelled"
            ? event.result.status
            : "unknown";
          const row = stats.get(commandKind) ?? { succeeded: 0, failed: 0, cancelled: 0, unknown: 0, errorCodes: new Map<string, number>() };
          row[status] += 1;
          const errorCode = typeof event.result.errorCode === "string" ? event.result.errorCode
            : typeof event.tool?.errorCode === "string" ? event.tool.errorCode
              : undefined;
          if (status === "failed" && errorCode) row.errorCodes.set(errorCode, (row.errorCodes.get(errorCode) ?? 0) + 1);
          stats.set(commandKind, row);
        } catch (error) {
          warnings.push(`${fileName}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  const rows: CommandUsageRow[] = [...stats.entries()].map(([commandKind, row]) => {
    const total = row.succeeded + row.failed + row.cancelled + row.unknown;
    return {
      commandKind,
      succeeded: row.succeeded,
      failed: row.failed,
      cancelled: row.cancelled,
      unknown: row.unknown,
      total,
      deprecated: deprecatedStats.get(commandKind) ?? 0,
      failureRate: total === 0 ? 0 : row.failed / total,
      errorCodes: [...row.errorCodes.entries()]
        .map(([errorCode, count]) => ({ errorCode, count }))
        .sort((left, right) => right.count - left.count || left.errorCode.localeCompare(right.errorCode))
    };
  }).sort((left, right) => right.total - left.total || right.deprecated - left.deprecated || left.commandKind.localeCompare(right.commandKind));
  const used = new Set(rows.map((row) => row.commandKind));
  const unusedEventedCommands = commandSpecs
    .filter((entry) => entry.kind !== "diagnostics-command-usage" && ["auto", "deferred"].includes(entry.eventPolicy.runtimeEvent) && !used.has(entry.kind))
    .map((entry) => ({ commandKind: entry.kind, policy: entry.eventPolicy.runtimeEvent }));
  const report = {
    schema: "command-usage-diagnostics/v1",
    totalEvents,
    resultEvents,
    sessions: sessions.size,
    rows,
    topUsed: rows.slice(0, 10),
    topFailed: rows.filter((row) => row.failed > 0).sort((left, right) => right.failed - left.failed || left.commandKind.localeCompare(right.commandKind)).slice(0, 10),
    deprecatedUsage: rows.filter((row) => row.deprecated > 0).map((row) => ({ commandKind: row.commandKind, count: row.deprecated })),
    unusedEventedCommands,
    warnings
  };
  return {
    ok: true,
    command: "diagnostics-command-usage",
    rows: rows.length,
    report,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

function eventCommandKind(event: Record<string, any>): string {
  if (typeof event.tool?.toolName === "string") return event.tool.toolName;
  const summary = typeof event.result?.summary === "string" ? event.result.summary : "";
  const match = /^CLI command (?:succeeded|failed): ([a-z0-9-]+)$/u.exec(summary);
  return match?.[1] ?? "unknown";
}
