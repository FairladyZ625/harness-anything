import { Effect } from "effect";
import { queryDecisionProjection } from "../../../../kernel/src/index.ts";
import type { DecisionProjectionRow } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

type DecisionQueryAction = Extract<ParsedCommand["action"], { readonly kind: "decision-list" | "decision-show" }>;

interface DecisionSummary {
  readonly decisionId: string;
  readonly legacyId?: string;
  readonly state: string;
  readonly title: string;
  readonly question: string;
  readonly chosen: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<{ readonly text: string; readonly whyNot: string }>;
  readonly path: string;
  readonly moduleKeys: ReadonlyArray<string>;
  readonly productLineKeys: ReadonlyArray<string>;
  readonly attribution: DecisionProjectionRow["attribution"];
}

interface CompactDecisionSummary {
  readonly legacyId?: string;
  readonly question: string;
  readonly chosen: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<string>;
}

export const runDecisionQueryCommand: CommandRunner = (context, command) => Effect.sync(() => {
  const action = command.action as DecisionQueryAction;
  if (action.kind === "decision-list") {
    const legacyRange = action.legacyRange ? parseLegacyRange(action.legacyRange) : undefined;
    if (action.legacyRange && !legacyRange) {
      return {
        ok: false,
        command: "decision-list",
        error: cliError(CliErrorCode.InvalidDecisionLegacyRange, `invalid legacy range: ${action.legacyRange}`)
      } satisfies CliResult;
    }
    const result = queryDecisionProjection({
      rootDir: context.rootDir,
      layoutOverrides: context.layoutOverrides,
      filters: {
        ...(action.search ? { search: action.search } : {}),
        ...(action.legacyId ? { legacyId: normalizeLegacySelector(action.legacyId) } : {}),
        ...(legacyRange ? { legacyRange } : {}),
        ...(action.state ? { state: action.state } : {}),
        ...(action.moduleKey ? { moduleKey: action.moduleKey } : {}),
        ...(action.productLine ? { productLine: action.productLine } : {})
      }
    });
    const filtered = result.rows.map(summarizeDecision);
    return {
      ok: true,
      command: "decision-list",
      rows: filtered.length,
      warnings: result.warnings,
      report: {
        schema: "decision-query-report/v1",
        filters: {
          ...(action.search ? { search: action.search } : {}),
          ...(action.legacyId ? { legacyId: normalizeLegacySelector(action.legacyId) } : {}),
          ...(legacyRange ? { legacyRange: `${legacyRange.startLabel}-${legacyRange.endLabel}` } : {}),
          ...(action.state ? { state: action.state } : {}),
          ...(action.moduleKey ? { module: action.moduleKey } : {}),
          ...(action.productLine ? { productLine: action.productLine } : {}),
          ...(action.compact ? { compact: true } : {})
        },
        decisions: action.compact ? filtered.map(compactDecisionSummary) : filtered
      }
    } satisfies CliResult;
  }

  const selector = normalizeDecisionSelector(action.selector);
  const result = queryDecisionProjection({
    rootDir: context.rootDir,
    layoutOverrides: context.layoutOverrides,
    filters: selector.startsWith("dec_") ? {} : { legacyId: normalizeLegacySelector(selector) }
  });
  const match = result.rows.map(summarizeDecision).find((entry) => matchesDecisionSelector(entry, selector));
  if (!match) {
    return {
      ok: false,
      command: "decision-show",
      decisionId: action.selector,
      error: cliError(CliErrorCode.DecisionReadFailed, `decision not found: ${action.selector}`)
    } satisfies CliResult;
  }
  return {
    ok: true,
    command: "decision-show",
    decisionId: match.decisionId,
    path: match.path,
    warnings: result.warnings,
    report: {
      schema: "decision-query-report/v1",
      selector: action.selector,
      decision: match
    }
  } satisfies CliResult;
});

function summarizeDecision(decision: DecisionProjectionRow): DecisionSummary {
  return {
    decisionId: decision.decisionId,
    ...(decision.legacyId ? { legacyId: decision.legacyId } : {}),
    state: decision.state,
    title: decision.title,
    question: decision.question,
    chosen: decision.chosen,
    rejected: decision.rejected,
    path: decision.path,
    moduleKeys: decision.moduleKeys,
    productLineKeys: decision.productLineKeys,
    attribution: decision.attribution
  };
}

function compactDecisionSummary(entry: DecisionSummary): CompactDecisionSummary {
  return {
    ...(entry.legacyId ? { legacyId: entry.legacyId } : {}),
    question: entry.question,
    chosen: entry.chosen,
    rejected: entry.rejected.map((rejected) => rejected.text)
  };
}

function matchesDecisionSelector(entry: DecisionSummary, selector: string): boolean {
  if (entry.decisionId === selector) return true;
  return entry.legacyId === normalizeLegacySelector(selector);
}

function normalizeDecisionSelector(value: string): string {
  return value.startsWith("dec_") ? value : normalizeLegacySelector(value);
}

function normalizeLegacySelector(value: string): string {
  const trimmed = value.trim().toUpperCase();
  const match = /^E?(\d+)$/u.exec(trimmed);
  return match ? `E${Number(match[1])}` : trimmed;
}

function parseLegacyRange(value: string): { readonly start: number; readonly end: number; readonly startLabel: string; readonly endLabel: string } | undefined {
  const match = /^\s*E?(\d+)\s*-\s*E?(\d+)\s*$/iu.exec(value);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return undefined;
  return { start, end, startLabel: `E${start}`, endLabel: `E${end}` };
}
