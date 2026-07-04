import type { DecisionPackage } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, DecisionAmendPatchInput } from "../../cli/types.ts";

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
    if (patch.field !== "title") return { ok: false, reason: `replace is not supported for decision field: ${patch.field}` };
    return { ok: true, next: { ...current, title: patch.value } };
  }
  if (patch.field === "chosen") {
    const entry = parseDecisionAnchorPatch(patch.value);
    return entry ? { ok: true, next: { ...current, chosen: [...current.chosen, entry] } } : { ok: false, reason: "chosen append requires JSON object with id and text" };
  }
  if (patch.field === "claims") {
    const entry = parseDecisionAnchorPatch(patch.value);
    return entry ? { ok: true, next: { ...current, claims: [...current.claims, entry] } } : { ok: false, reason: "claims append requires JSON object with id and text" };
  }
  if (patch.field === "rejected") {
    const entry = parseRejectedDecisionAnchorPatch(patch.value);
    return entry ? { ok: true, next: { ...current, rejected: [...current.rejected, entry] } } : { ok: false, reason: "rejected append requires JSON object with id, text, and why_not" };
  }
  return { ok: false, reason: `append is not supported for decision field: ${patch.field}` };
}

function parseDecisionAnchorPatch(value: string): DecisionPackage["chosen"][number] | null {
  const parsed = parsePatchObject(value);
  if (!parsed) return null;
  const id = typeof parsed.id === "string" ? parsed.id : "";
  const text = typeof parsed.text === "string" ? parsed.text : "";
  return id && text ? { id, text } : null;
}

function parseRejectedDecisionAnchorPatch(value: string): DecisionPackage["rejected"][number] | null {
  const parsed = parsePatchObject(value);
  if (!parsed) return null;
  const id = typeof parsed.id === "string" ? parsed.id : "";
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
