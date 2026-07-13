import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { parseClaimFulfillments } from "./decision-fulfillment.ts";

const transitionOps = new Set(["accept", "reject", "defer", "supersede", "retire"]);

type TransitionAction = Extract<ParsedCommand["action"], { readonly kind:
  | "decision-accept"
  | "decision-reject"
  | "decision-defer"
  | "decision-supersede"
  | "decision-retire"
}>;

export function isDecisionTransitionOp(value: string | undefined): value is "accept" | "reject" | "defer" | "supersede" | "retire" {
  return transitionOps.has(value ?? "");
}

export function parseDecisionTransitionArgs(
  args: ReadonlyArray<string>,
  op: "accept" | "reject" | "defer" | "supersede" | "retire"
): { readonly ok: true; readonly value: TransitionAction } | { readonly ok: false; readonly error: CliResult["error"] } {
  const judgmentOnlyRationale = readOption(args, "--judgment-only");
  const fulfillments = parseClaimFulfillments(args);
  if (!fulfillments.ok) return fulfillments;
  if (op !== "accept" && fulfillments.value.length > 0) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, "--fulfillment is supported by decision accept, not other transitions.") };
  }
  if (op === "accept" && args.includes("--judgment-only") && (
    !judgmentOnlyRationale ||
    judgmentOnlyRationale.trim().length === 0 ||
    judgmentOnlyRationale.trim().startsWith("--")
  )) {
    return { ok: false, error: cliError(CliErrorCode.MissingReason, "Use decision accept <decision-id> --judgment-only <rationale>.") };
  }
  return {
    ok: true,
    value: {
      kind: `decision-${op}` as TransitionAction["kind"],
      decisionId: args[2]!,
      decidedAt: readOption(args, "--decided-at"),
      ...(op === "accept" && judgmentOnlyRationale ? { judgmentOnlyRationale } : {}),
      ...(op === "accept" && args.includes("--standing-policy") ? { standingPolicy: true } : {}),
      fulfillments: fulfillments.value,
      body: readOption(args, "--body"),
      dryRun: args.includes("--dry-run")
    }
  };
}
