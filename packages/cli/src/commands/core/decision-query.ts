import { Effect } from "effect";
import { listDecisionDocuments } from "../../../../application/src/index.ts";
import type { DecisionPackage } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

type DecisionQueryAction = Extract<ParsedCommand["action"], { readonly kind: "decision-list" | "decision-show" }>;

interface DecisionSummary {
  readonly decisionId: string;
  readonly legacyId?: string;
  readonly state: DecisionPackage["state"];
  readonly title: string;
  readonly question: string;
  readonly chosen: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<{ readonly text: string; readonly whyNot: string }>;
  readonly path: string;
}

interface CompactDecisionSummary {
  readonly legacyId?: string;
  readonly question: string;
  readonly chosen: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<string>;
}

export const runDecisionQueryCommand: CommandRunner = (context, command) => Effect.sync(() => {
  const action = command.action as DecisionQueryAction;
  const decisions = listDecisionDocuments(context.layoutInput).decisions.map((entry) => summarizeDecision(entry.decision, entry.path));
  if (action.kind === "decision-list") {
    const legacyRange = action.legacyRange ? parseLegacyRange(action.legacyRange) : undefined;
    if (action.legacyRange && !legacyRange) {
      return {
        ok: false,
        command: "decision-list",
        error: cliError(CliErrorCode.InvalidDecisionLegacyRange, `invalid legacy range: ${action.legacyRange}`)
      } satisfies CliResult;
    }
    const filtered = decisions.filter((entry) => matchesDecisionListFilter(entry, action));
    return {
      ok: true,
      command: "decision-list",
      rows: filtered.length,
      report: {
        schema: "decision-query-report/v1",
        filters: {
          ...(action.search ? { search: action.search } : {}),
          ...(action.legacyId ? { legacyId: normalizeLegacySelector(action.legacyId) } : {}),
          ...(legacyRange ? { legacyRange: `${legacyRange.startLabel}-${legacyRange.endLabel}` } : {}),
          ...(action.compact ? { compact: true } : {})
        },
        decisions: action.compact ? filtered.map(compactDecisionSummary) : filtered
      }
    } satisfies CliResult;
  }

  const selector = normalizeDecisionSelector(action.selector);
  const match = decisions.find((entry) => matchesDecisionSelector(entry, selector));
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
    report: {
      schema: "decision-query-report/v1",
      selector: action.selector,
      decision: match
    }
  } satisfies CliResult;
});

function summarizeDecision(decision: DecisionPackage, documentPath: string): DecisionSummary {
  return {
    decisionId: decision.decision_id,
    ...(legacyIdFromDecisionId(decision.decision_id) ? { legacyId: legacyIdFromDecisionId(decision.decision_id)! } : {}),
    state: decision.state,
    title: decision.title,
    question: decision.question,
    chosen: decision.chosen.map((entry) => entry.text),
    rejected: decision.rejected.map((entry) => ({ text: entry.text, whyNot: entry.why_not })),
    path: documentPath
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

function matchesDecisionListFilter(entry: DecisionSummary, action: Extract<DecisionQueryAction, { readonly kind: "decision-list" }>): boolean {
  if (action.legacyId && entry.legacyId !== normalizeLegacySelector(action.legacyId)) return false;
  if (action.legacyRange) {
    const range = parseLegacyRange(action.legacyRange);
    const legacyNumber = entry.legacyId ? legacyNumberFromSelector(entry.legacyId) : undefined;
    if (!range || legacyNumber === undefined || legacyNumber < range.start || legacyNumber > range.end) return false;
  }
  if (!action.search) return true;
  const needle = action.search.toLowerCase();
  return [
    entry.decisionId,
    entry.legacyId ?? "",
    entry.title,
    entry.question,
    ...entry.chosen,
    ...entry.rejected.flatMap((rejected) => [rejected.text, rejected.whyNot])
  ].some((value) => value.toLowerCase().includes(needle));
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

function legacyNumberFromSelector(value: string): number | undefined {
  const match = /^E?(\d+)$/iu.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function legacyIdFromDecisionId(decisionId: string): string | undefined {
  const match = /(?:^|_)E(\d+)(?:_|$)/u.exec(decisionId);
  return match ? `E${Number(match[1])}` : undefined;
}
