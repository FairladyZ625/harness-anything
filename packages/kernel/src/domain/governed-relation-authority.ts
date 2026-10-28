import type { DecisionDocumentState } from "./decision-event-types.ts";
import {
  canonicalGovernedRelationAuthority,
  type GovernedRelationCompilationAuthority,
  type GovernedRelationDecision,
} from "./governed-relation-direction.ts";
import type { VerticalDefinition } from "./vertical-definition.ts";

/** The one projection read the authority needs; a caller without decision documents keeps the
 *  accepted canonical receipt as its authority instead. */
export interface GovernedRelationDecisionReader {
  readonly readDecisionDocumentState?: (decisionId: string) => DecisionDocumentState | null;
}

const decisionClaimRefPattern = /^decision\/(?<decisionId>dec_[A-Za-z0-9_-]+)\/(?<claimId>(?:CH|C)[1-9][0-9]*)$/u;

/**
 * Compile authority from the decisions the declaration actually cites, so a relation may pin any
 * accepted decision claim rather than only the receipt shipped with the kernel. A declared pin is
 * honoured when it is one of that decision's recorded content pins (a declaration keeps citing the
 * interpretation it was accepted against); a pin outside that set is compiled against the latest
 * pin on purpose, so the compiler answers "pin mismatch" instead of "unknown decision". Decisions
 * the projection cannot show fall back to the canonical receipt; anything in neither set stays out
 * of the authority and the compiler names the unreachable claim.
 */
export function resolveGovernedRelationAuthority(
  reader: GovernedRelationDecisionReader,
  definition: VerticalDefinition,
): GovernedRelationCompilationAuthority {
  const decisions = new Map<string, GovernedRelationDecision>(
    canonicalGovernedRelationAuthority.decisions.map((decision) => [decision.decisionId, decision]),
  );
  for (const declared of declaredDecisionPins(definition)) {
    const state = reader.readDecisionDocumentState?.(declared.decisionId),
      canonical = decisions.get(declared.decisionId);
    if (!state) continue;
    const pins = (state.contentPins ?? []).map(({ digest }) => digest),
      contentPin = pins.includes(declared.contentPin) ? declared.contentPin : (pins.at(-1) ?? canonical?.contentPin);
    if (contentPin === undefined) continue;
    decisions.set(declared.decisionId, {
      decisionId: declared.decisionId,
      state: state.state,
      contentPin,
      // A governed relation cites the decision's chosen option (`CH1`), not a fulfillment claim
      // (`C1`); DecisionDocumentState.claims is the latter. The shipped canonical vertical and every
      // accepted relation use chosen ids, so this authority must read the same field.
      claimIds: state.chosen.map(({ id }) => id),
    });
  }
  return { decisions: [...decisions.values()] };
}

function* declaredDecisionPins(
  definition: VerticalDefinition,
): Generator<{ readonly decisionId: string; readonly contentPin: `sha256:${string}` }> {
  for (const kind of definition.entityKinds) {
    if (kind.entityType !== "artifact") continue;
    for (const relation of kind.relations ?? []) {
      const match = decisionClaimRefPattern.exec(relation.decisionClaimRef);
      if (!match?.groups?.decisionId) continue;
      yield { decisionId: match.groups.decisionId, contentPin: relation.decisionContentPin as `sha256:${string}` };
    }
  }
}
