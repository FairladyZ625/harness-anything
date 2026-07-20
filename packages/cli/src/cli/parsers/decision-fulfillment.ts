import { decisionClaimFulfillments, type DecisionClaimFulfillment } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, DecisionClaimFulfillmentInput } from "../types.ts";

export function parseClaimFulfillments(
  args: ReadonlyArray<string>,
  input: ReadonlyArray<unknown> = []
): { readonly ok: true; readonly value: ReadonlyArray<DecisionClaimFulfillmentInput> } | { readonly ok: false; readonly error: CliResult["error"] } {
  const fulfillments: DecisionClaimFulfillmentInput[] = [];
  for (const raw of [...input, ...readRepeatedRawOption(args, "--fulfillment")]) {
    const value = typeof raw === "string" ? raw : "";
    const separator = value.indexOf(":");
    const claimId = value.slice(0, separator).trim();
    const fulfillment = value.slice(separator + 1).trim();
    if (separator <= 0 || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(claimId) || !isClaimFulfillment(fulfillment)) {
      return {
        ok: false,
        error: cliError(CliErrorCode.InvalidDecisionAmendPatch, "Use --fulfillment <claim-id>:<evidenced|delivered|standing-policy>.")
      };
    }
    if (fulfillments.some((declaration) => declaration.claimId === claimId)) {
      return {
        ok: false,
        error: cliError(CliErrorCode.InvalidDecisionAmendPatch, `Claim fulfillment is declared more than once: ${claimId}.`)
      };
    }
    fulfillments.push({ claimId, fulfillment });
  }
  return { ok: true, value: fulfillments };
}

function isClaimFulfillment(value: string): value is DecisionClaimFulfillment {
  return decisionClaimFulfillments.some((candidate) => candidate === value);
}
