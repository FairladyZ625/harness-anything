import { Effect } from "effect";
import { AttributionBackfillDeclarationError, applyAttributionBackfill, planAttributionBackfill } from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CommandRunner } from "../cli/runner-registry.ts";
import type { CliResult } from "../cli/types.ts";

export const runMigrateAttribution: CommandRunner = (context, command) => Effect.sync(() => {
  const action = command.action as Extract<typeof command.action, { readonly kind: "migrate-attribution" }>;
  const declaration = action.declarePrincipal && action.declareAuthority
    ? { personId: action.declarePrincipal, authority: action.declareAuthority }
    : undefined;
  let plan: ReturnType<typeof planAttributionBackfill>;
  try {
    plan = planAttributionBackfill(context.layoutInput, declaration);
  } catch (error) {
    if (!(error instanceof AttributionBackfillDeclarationError)) throw error;
    return {
      ok: false,
      command: "migrate-attribution",
      migrationMode: action.mode === "dry-run" ? "plan" : "apply",
      rows: 0,
      report: { mode: action.mode, appliedEvents: 0 },
      error: cliError(
        CliErrorCode.AttributionDeclarationInvalid,
        error instanceof Error ? error.message : "Attribution declaration is invalid."
      )
    } satisfies CliResult;
  }
  if (action.mode === "dry-run") return attributionBackfillResult("plan", plan, 0);
  if (action.confirmPlan !== plan.planId) {
    return {
      ok: false,
      command: "migrate-attribution",
      migrationMode: "apply",
      rows: 0,
      report: { ...plan, mode: "apply", appliedEvents: 0 },
      error: cliError(
        CliErrorCode.PlanConfirmationRequired,
        `Inspect the dry-run and rerun with --apply --confirm-plan ${plan.planId}.`
      )
    } satisfies CliResult;
  }
  const applied = applyAttributionBackfill(context.layoutInput, action.confirmPlan, declaration);
  return attributionBackfillResult("apply", applied.plan, applied.appliedEvents, applied.recordedAt);
});

function attributionBackfillResult(
  mode: "plan" | "apply",
  plan: ReturnType<typeof planAttributionBackfill>,
  appliedEvents: number,
  recordedAt?: string
): CliResult {
  return {
    ok: true,
    command: "migrate-attribution",
    migrationMode: mode,
    rows: appliedEvents,
    report: {
      ...plan,
      mode: mode === "plan" ? "dry-run" : "apply",
      appliedEvents,
      ...(recordedAt ? { recordedAt } : {})
    }
  };
}
