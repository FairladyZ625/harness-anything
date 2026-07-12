import { Effect } from "effect";
import { applyAttributionBackfill, planAttributionBackfill } from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CommandRunner } from "../cli/runner-registry.ts";
import type { CliResult } from "../cli/types.ts";

export const runMigrateAttribution: CommandRunner = (context, command) => Effect.sync(() => {
  const action = command.action as Extract<typeof command.action, { readonly kind: "migrate-attribution" }>;
  const plan = planAttributionBackfill(context.layoutInput);
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
  const applied = applyAttributionBackfill(context.layoutInput, action.confirmPlan);
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
