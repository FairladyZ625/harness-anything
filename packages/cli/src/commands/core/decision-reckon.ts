import { Effect } from "effect";
import {
  evaluateDecisionReckonGate,
  type FactWriteRejected,
  type FactWriteService,
  readDecisionDocument
} from "@harness-anything/application";
import { queryConsentsBySourceStrength, readDecisionFactCoverage, type WriteError } from "@harness-anything/kernel";
import { harnessRuntimeRoot, type HarnessLayoutInput } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

type ReckonAction = Extract<ParsedCommand["action"], { readonly kind: "decision-reckon" }>;
type ReckonReport = ReturnType<typeof evaluateDecisionReckonGate> & {
  readonly schema: "decision-reckon-report/v1";
  readonly coverageRows: unknown;
  readonly consentSourceHealth: {
    readonly assertedCount: number;
    readonly status: "verified-only" | "contains-asserted";
  };
};

export function runReckon(
  rootInput: HarnessLayoutInput,
  factService: FactWriteService,
  action: ReckonAction
): Effect.Effect<CliResult, WriteError> {
  return readDecisionDocument(rootInput, action.decisionId).pipe(
    Effect.map((document) => document.decision),
    Effect.flatMap((decision) => {
      const reckonedAt = new Date().toISOString();
      const coverage = readDecisionFactCoverage({
        rootDir: harnessRuntimeRoot(rootInput),
        layoutOverrides: typeof rootInput === "string" ? undefined : rootInput.layoutOverrides,
        decisionId: decision.decision_id
      });
      const gate = evaluateDecisionReckonGate({
        decisionId: decision.decision_id,
        claims: decision.claims,
        coverageRows: coverage.rows,
        reckonedAt
      });
      const assertedCount = queryConsentsBySourceStrength({
        rootDir: harnessRuntimeRoot(rootInput),
        layoutOverrides: typeof rootInput === "string" ? undefined : rootInput.layoutOverrides,
        sourceStrength: "asserted"
      }).filter((consent) => consent.taskId === action.taskId).length;
      const claimCoverageStatement = gate.ok
        ? `Decision ${decision.decision_id} reckon passed: load-bearing claims all covered @${reckonedAt}.`
        : `Decision ${decision.decision_id} reckon failed: uncovered load-bearing claims ${gate.uncoveredClaimRefs.join(", ")} @${reckonedAt}.`;
      const statement = `${claimCoverageStatement} Consent source weakness: ${assertedCount} asserted consent record(s).`;
      const report = {
        schema: "decision-reckon-report/v1" as const,
        ...gate,
        coverageRows: coverage.rows,
        consentSourceHealth: {
          assertedCount,
          status: assertedCount === 0 ? "verified-only" as const : "contains-asserted" as const
        }
      };
      if (action.dryRun) return Effect.succeed(reckonResult(action, report, undefined, undefined, undefined));
      return factService.record({
        ownerTaskId: action.taskId,
        statement,
        source: `ha decision reckon ${decision.decision_id}`,
        observedAt: reckonedAt,
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: []
      }).pipe(
        Effect.match({
          onFailure: (error): CliResult => reckonFactFailure(action, report, error),
          onSuccess: (fact): CliResult => reckonResult(action, report, fact.factId, fact.ref, fact.path)
        })
      );
    }),
    Effect.catchAll(() => Effect.succeed({
      ok: false,
      command: "decision-reckon",
      decisionId: action.decisionId,
      taskId: action.taskId,
      error: cliError(CliErrorCode.DecisionReadFailed, `decision document could not be read: ${action.decisionId}`)
    } satisfies CliResult))
  );
}

function reckonResult(
  action: ReckonAction,
  report: ReckonReport,
  factId: string | undefined,
  factRef: string | undefined,
  factPath: string | undefined
): CliResult {
  const base = {
    command: "decision-reckon",
    decisionId: action.decisionId,
    taskId: action.taskId,
    ...(factId ? { factId } : {}),
    ...(factRef ? { factRef } : {}),
    ...(factPath ? { path: factPath } : {}),
    report
  };
  return report.ok ? { ok: true, ...base } : {
    ok: false,
    ...base,
    error: cliError(CliErrorCode.DecisionReckonUncovered, `Decision ${action.decisionId} has uncovered load-bearing claims: ${report.uncoveredClaimRefs.join(", ")}`)
  };
}

function reckonFactFailure(action: ReckonAction, report: ReckonReport, error: FactWriteRejected | WriteError): CliResult {
  const reason = "_tag" in error && error._tag === "FactWriteRejected" ? error.reason : JSON.stringify(error);
  return {
    ok: false,
    command: "decision-reckon",
    decisionId: action.decisionId,
    taskId: action.taskId,
    report,
    error: cliError(CliErrorCode.FactWriteRejected, reason)
  };
}
