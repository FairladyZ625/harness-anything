import type { DecisionPackage } from "@harness-anything/kernel";
import type { DecisionClaimFulfillmentInput } from "../../cli/types.ts";

export function applyClaimFulfillments<Decision extends { readonly claims: DecisionPackage["claims"] }>(
  decision: Decision,
  declarations: ReadonlyArray<DecisionClaimFulfillmentInput>
): { readonly ok: true; readonly decision: Decision } | { readonly ok: false; readonly reason: string } {
  const byClaim = new Map(declarations.map((declaration) => [declaration.claimId, declaration.fulfillment]));
  const claimIds = new Set(decision.claims.map((claim) => claim.id));
  const missing = declarations.find((declaration) => !claimIds.has(declaration.claimId));
  if (missing) return { ok: false, reason: `claim not found for fulfillment declaration: ${missing.claimId}` };
  return {
    ok: true,
    decision: {
      ...decision,
      claims: decision.claims.map((claim) => {
        const fulfillment = byClaim.get(claim.id);
        return fulfillment ? { ...claim, fulfillment } : claim;
      })
    }
  };
}
