import { Effect } from "effect";
import {
  evaluateDecisionReckonGate,
  type FactWriteRejected,
  type FactWriteService,
  readDecisionDocument
} from "@harness-anything/application";
import { queryConsentsBySourceStrength, queryConsentsBySourceStrengthWithWarnings, readDecisionFactCoverage, type ProjectionWarning, type WriteControl, type WriteError } from "@harness-anything/kernel";
import { harnessRuntimeRoot, type HarnessLayoutInput } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { demotedGateWarning } from "../../cli/demoted-gate-warning.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { mapFailurePreservingIndeterminate } from "../../cli/indeterminate-control.ts";

type ReckonAction = Extract<ParsedCommand["action"], { readonly kind: "decision-reckon" }>;
type ReckonReport = ReturnType<typeof evaluateDecisionReckonGate> & {
  readonly schema: "decision-reckon-report/v1";
  readonly coverageRows: unknown;
  readonly consentSourceHealth: {
    readonly assertedCount: number;
    readonly status: "verified-only" | "contains-asserted";
  };
  readonly projectionWarnings: ReadonlyArray<ProjectionWarning>;
};

export function runReckon(
  rootInput: HarnessLayoutInput,
  factService: FactWriteService,
  action: ReckonAction
): Effect.Effect<CliResult, WriteControl> {
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
      const consentOptions = {
        rootDir: harnessRuntimeRoot(rootInput),
        layoutOverrides: typeof rootInput === "string" ? undefined : rootInput.layoutOverrides,
        sourceStrength: "asserted"
      } as const;
      // Keep the legacy row API on the established read path; the sibling call is the
      // warning-bearing read required to keep this fact write fail-closed.
      const consentRows = queryConsentsBySourceStrength(consentOptions);
      const consentProjection = queryConsentsBySourceStrengthWithWarnings(consentOptions);
      const assertedCount = consentRows.filter((consent) => consent.taskId === action.taskId).length;
      const projectionWarnings = dedupeProjectionWarnings([...coverage.warnings, ...consentProjection.warnings]);
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
        },
        projectionWarnings
      };
      const withheldIdentityWarnings = projectionWarnings.filter((warning) => warning.code === "declared_identity_conflict");
      if (withheldIdentityWarnings.length > 0) return Effect.succeed(reckonProjectionBlocked(action, report, withheldIdentityWarnings));
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
        Effect.matchEffect({
          onFailure: (error) => mapFailurePreservingIndeterminate(error, (failure) => reckonFactFailure(action, report, failure)),
          onSuccess: (fact) => Effect.succeed(reckonResult(action, report, fact.factId, fact.ref, fact.path))
        })
      );
    }),
    Effect.catchAll((error) => mapFailurePreservingIndeterminate(error, () => ({
      ok: false,
      command: "decision-reckon",
      decisionId: action.decisionId,
      taskId: action.taskId,
      error: cliError(CliErrorCode.DecisionReadFailed, `decision document could not be read: ${action.decisionId}`)
    } satisfies CliResult)))
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
  return {
    ok: true,
    ...base,
    ...(!report.ok ? {
      warnings: [demotedGateWarning(
        "decision_reckon_uncovered",
        `Decision ${action.decisionId} has uncovered load-bearing claims: ${report.uncoveredClaimRefs.join(", ")}`
      )]
    } : {})
  };
}

function reckonProjectionBlocked(action: ReckonAction, report: ReckonReport, warnings: ReadonlyArray<ProjectionWarning>): CliResult {
  return {
    ok: false,
    command: "decision-reckon",
    decisionId: action.decisionId,
    taskId: action.taskId,
    report,
    warnings,
    error: cliError(
      CliErrorCode.ProjectionCheckFailed,
      `Decision reckon refused to write a fact because declared entity rows were withheld by ${warnings.length} projection conflict warning${warnings.length === 1 ? "" : "s"}. Run ha doctor --repair --json, then retry.`
    )
  };
}

function dedupeProjectionWarnings(warnings: ReadonlyArray<ProjectionWarning>): ReadonlyArray<ProjectionWarning> {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}\0${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
