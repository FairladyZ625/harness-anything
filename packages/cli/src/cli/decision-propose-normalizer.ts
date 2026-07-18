import { generateTaskId } from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "./types.ts";

type ProposeAction = Extract<ParsedCommand["action"], { readonly kind: "decision-propose" }>;

export function normalizeDecisionProposeAction(
  action: Omit<ProposeAction, "decisionId" | "proposedAt"> & {
    readonly decisionId?: string;
    readonly proposedAt?: string;
  }
): ProposeAction {
  const chosen = normalizeAnchors("CH", action.chosen);
  const rejected = normalizeAnchors("RJ", action.rejected);
  const claimInputs = action.claims.length > 0
    ? action.claims
    : [{
        text: action.claim ?? chosen[0]?.text ?? "",
        ...(action.claimLoadBearing ? {} : { load_bearing: false as const })
      }];
  return {
    ...action,
    decisionId: action.decisionId ?? generateTaskId().replace(/^task_/u, "dec_"),
    proposedAt: action.proposedAt ?? new Date().toISOString(),
    chosen,
    rejected,
    claims: normalizeAnchors("C", claimInputs)
  };
}

export function nextDecisionAnchorId(prefix: string, existingIds: ReadonlyArray<string>, minimum = 1): string {
  const max = existingIds.reduce((current, id) => {
    const match = new RegExp(`^${prefix}(\\d+)$`, "u").exec(id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, minimum - 1);
  return `${prefix}${max + 1}`;
}

function normalizeAnchors<Entry extends { readonly id?: string }>(
  prefix: "CH" | "RJ" | "C",
  entries: ReadonlyArray<Entry>
): ReadonlyArray<Entry & { readonly id: string }> {
  const used = new Set<string>();
  return entries.map((entry, index) => {
    const id = entry.id && !used.has(entry.id)
      ? entry.id
      : nextDecisionAnchorId(prefix, [...used], index + 1);
    used.add(id);
    return { ...entry, id };
  });
}
