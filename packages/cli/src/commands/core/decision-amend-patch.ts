import type { DecisionPackage } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, DecisionAmendPatchInput } from "../../cli/types.ts";
import { nextDecisionAnchorId } from "./decision-anchor-id.ts";

export function applyDecisionAmendPatches(
  current: DecisionPackage,
  patches: ReadonlyArray<DecisionAmendPatchInput>
): { readonly ok: true; readonly next: DecisionPackage } | { readonly ok: false; readonly result: CliResult } {
  let next: DecisionPackage = current;
  for (const patch of patches) {
    const applied = applyDecisionAmendPatch(next, patch);
    if (!applied.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          command: "decision-amend",
          decisionId: current.decision_id,
          error: cliError(CliErrorCode.InvalidDecisionAmendPatch, applied.reason)
        }
      };
    }
    next = applied.next;
  }
  return { ok: true, next };
}

function applyDecisionAmendPatch(
  current: DecisionPackage,
  patch: DecisionAmendPatchInput
): { readonly ok: true; readonly next: DecisionPackage } | { readonly ok: false; readonly reason: string } {
  if (patch.operation === "replace") {
    if (patch.field === "title") return { ok: true, next: { ...current, title: patch.value } };
    return { ok: false, reason: `replace is not supported for decision field: ${patch.field}` };
  }
  if (patch.operation === "metadata") {
    if (patch.field === "claims") return replaceClaimLoadBearing(current, patch.value);
    return { ok: false, reason: `metadata is not supported for decision field: ${patch.field}` };
  }
  if (patch.field === "chosen") {
    const entry = parseDecisionAnchorPatch(patch.value, nextDecisionAnchorId("CH", current.chosen.map((anchor) => anchor.id)));
    return entry ? { ok: true, next: { ...current, chosen: [...current.chosen, entry] } } : { ok: false, reason: "chosen append requires JSON object with id and text" };
  }
  if (patch.field === "claims") {
    const entry = parseDecisionAnchorPatch(patch.value, nextDecisionAnchorId("C", current.claims.map((anchor) => anchor.id)));
    return entry ? { ok: true, next: { ...current, claims: [...current.claims, entry] } } : { ok: false, reason: "claims append requires JSON object with id and text" };
  }
  if (patch.field === "rejected") {
    const entry = parseRejectedDecisionAnchorPatch(patch.value, nextDecisionAnchorId("RJ", current.rejected.map((anchor) => anchor.id)));
    return entry ? { ok: true, next: { ...current, rejected: [...current.rejected, entry] } } : { ok: false, reason: "rejected append requires JSON object with id, text, and why_not" };
  }
  return { ok: false, reason: `append is not supported for decision field: ${patch.field}` };
}

function replaceClaimLoadBearing(
  current: DecisionPackage,
  value: string
): { readonly ok: true; readonly next: DecisionPackage } | { readonly ok: false; readonly reason: string } {
  const parsed = parsePatchObject(value);
  if (!parsed) return { ok: false, reason: "claims replace requires JSON object with id and load_bearing" };
  const id = typeof parsed.id === "string" ? parsed.id : "";
  const loadBearing = typeof parsed.load_bearing === "boolean" ? parsed.load_bearing : undefined;
  if (!id || loadBearing === undefined) return { ok: false, reason: "claims replace requires JSON object with id and load_bearing" };
  let found = false;
  const claims = current.claims.map((claim) => {
    if (claim.id !== id) return claim;
    found = true;
    return { ...claim, load_bearing: loadBearing };
  });
  return found
    ? { ok: true, next: { ...current, claims } }
    : { ok: false, reason: `claim not found for load_bearing amendment: ${id}` };
}

function parseDecisionAnchorPatch(value: string, fallbackId: string): DecisionPackage["chosen"][number] | null {
  const parsed = parsePatchObject(value);
  if (!parsed) return null;
  const id = typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : fallbackId;
  const text = typeof parsed.text === "string" ? parsed.text : "";
  const loadBearing = typeof parsed.load_bearing === "boolean" ? parsed.load_bearing : undefined;
  return id && text ? { id, text, ...(loadBearing !== undefined ? { load_bearing: loadBearing } : {}) } : null;
}

function parseRejectedDecisionAnchorPatch(value: string, fallbackId: string): DecisionPackage["rejected"][number] | null {
  const parsed = parsePatchObject(value);
  if (!parsed) return null;
  const id = typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : fallbackId;
  const text = typeof parsed.text === "string" ? parsed.text : "";
  const whyNot = typeof parsed.why_not === "string" ? parsed.why_not : "";
  return id && text && whyNot ? { id, text, why_not: whyNot } : null;
}

function parsePatchObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
