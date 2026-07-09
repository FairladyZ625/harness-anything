import { Effect } from "effect";
import {
  type DecisionCreateInput,
  type DecisionWriteService
} from "../../../../application/src/index.ts";
import {
  deriveRelationId,
  type EntityRelationRecord,
  type WriteError
} from "../../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { nextDecisionAnchorId } from "./decision-anchor-id.ts";
import { decisionFailure, decisionResult, parseActor } from "./decision-shared.ts";

type ProposeAction = Extract<ParsedCommand["action"], { readonly kind: "decision-propose" }>;

export function runPropose(
  rootInput: HarnessLayoutInput,
  service: DecisionWriteService,
  action: ProposeAction
): Effect.Effect<CliResult, WriteError> {
  const now = new Date().toISOString();
  const baseDecision = proposedDecision(action, now, []);
  const relations = decisionEvidenceRelations(baseDecision, action.evidenceRelations);
  if (!relations.ok) {
    return Effect.succeed({
      ok: false,
      command: "decision-propose",
      decisionId: baseDecision.decision_id,
      error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, relations.reason)
    } satisfies CliResult);
  }
  const decision = { ...baseDecision, relations: relations.records };
  if (action.dryRun) return Effect.succeed(decisionResult(rootInput, "decision-propose", decision.decision_id, decision.state, true));
  return service.propose({ decision, body: action.body }).pipe(
    Effect.match({
      onFailure: (error): CliResult => decisionFailure("decision-propose", decision.decision_id, error),
      onSuccess: (result): CliResult => decisionResult(rootInput, "decision-propose", result.decisionId, result.state, false)
    })
  );
}

function proposedDecision(action: ProposeAction, now: string, relations: ReadonlyArray<EntityRelationRecord>): DecisionCreateInput {
  return {
    schema: "decision-package/v1",
    decision_id: action.decisionId ?? `dec_${Date.now().toString(36)}`,
    title: action.title,
    state: "proposed",
    riskTier: action.riskTier,
    urgency: action.urgency,
    vertical: "software/coding",
    preset: "architecture-decision",
    applies_to: { modules: [...action.modules], productLines: [...action.productLines] },
    proposedBy: parseActor(action.proposedBy) ?? { kind: "agent", id: "decision-cli" },
    proposedAt: now,
    arbiter: parseActor(action.arbiter) ?? { kind: "human", id: process.env.USER || "local-human" },
    question: action.question,
    chosen: proposedChosen(action),
    rejected: proposedRejected(action),
    claims: proposedClaims(action),
    relations
  };
}

function proposedChosen(action: ProposeAction): DecisionCreateInput["chosen"] {
  const used = new Set<string>();
  return action.chosen.map((choice, index) => {
    const id = choice.id && !used.has(choice.id) ? choice.id : nextDecisionAnchorId("CH", [...used], index + 1);
    used.add(id);
    return {
      id,
      text: choice.text,
      ...(choice.load_bearing === false ? { load_bearing: false } : {})
    };
  });
}

function proposedRejected(action: ProposeAction): DecisionCreateInput["rejected"] {
  const used = new Set<string>();
  return action.rejected.map((rejected, index) => {
    const id = rejected.id && !used.has(rejected.id) ? rejected.id : nextDecisionAnchorId("RJ", [...used], index + 1);
    used.add(id);
    return {
      id,
      text: rejected.text,
      why_not: rejected.why_not ?? ""
    };
  });
}

function proposedClaims(action: ProposeAction): DecisionCreateInput["claims"] {
  const inputs = action.claims.length > 0 ? action.claims : [{ text: action.claim ?? action.chosen[0]?.text ?? "", ...(action.claimLoadBearing ? {} : { load_bearing: false }) }];
  const used = new Set<string>();
  return inputs.map((claim, index) => {
    const id = claim.id && !used.has(claim.id) ? claim.id : nextDecisionAnchorId("C", [...used], index + 1);
    used.add(id);
    return {
      id,
      text: claim.text,
      ...(claim.load_bearing === false ? { load_bearing: false } : {})
    };
  });
}

function decisionEvidenceRelations(
  decision: DecisionCreateInput,
  inputs: ProposeAction["evidenceRelations"]
): { readonly ok: true; readonly records: ReadonlyArray<EntityRelationRecord> } | { readonly ok: false; readonly reason: string } {
  const anchorIds = new Set([
    ...decision.claims.map((entry) => entry.id),
    ...decision.chosen.map((entry) => entry.id),
    ...decision.rejected.map((entry) => entry.id)
  ]);
  const records: EntityRelationRecord[] = [];
  for (const input of inputs) {
    if (!anchorIds.has(input.anchor)) return { ok: false, reason: `decision evidence relation source anchor does not exist: ${input.anchor}` };
    const base = {
      source: `decision/${decision.decision_id}/${input.anchor}`,
      target: input.target,
      type: input.type,
      strength: "strong",
      direction: "directed",
      origin: "declared",
      rationale: input.rationale,
      state: "active"
    } satisfies Omit<EntityRelationRecord, "relation_id">;
    records.push({ relation_id: deriveRelationId(base), ...base });
  }
  return { ok: true, records };
}
