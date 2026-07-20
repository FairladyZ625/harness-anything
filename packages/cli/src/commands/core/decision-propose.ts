import { Effect } from "effect";
import {
  type DecisionCreateInput,
  type DecisionWriteService
} from "@harness-anything/application";
import {
  deriveRelationId,
  type EntityRelationRecord,
  type WriteError
} from "@harness-anything/kernel";
import type { HarnessLayoutInput } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { normalizeDecisionProposeAction } from "../../cli/decision-propose-normalizer.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { docSyncDirtyWarnings } from "./doc-sync.ts";
import { decisionFailure, decisionResult, withDecisionBodyEmptyWarning } from "./decision-shared.ts";
import { applyClaimFulfillments } from "./decision-claim-fulfillment.ts";

type ProposeAction = Extract<ParsedCommand["action"], { readonly kind: "decision-propose" }>;

export function runPropose(
  rootInput: HarnessLayoutInput,
  service: DecisionWriteService,
  action: ProposeAction
): Effect.Effect<CliResult, WriteError> {
  action = normalizeDecisionProposeAction(action);
  const materialized = materializeProposedDecision(action);
  if (!materialized.ok) {
    return Effect.succeed({
      ok: false,
      command: "decision-propose",
      decisionId: action.decisionId,
      error: cliError(materialized.code, materialized.reason)
    } satisfies CliResult);
  }
  const decision = materialized.decision;
  if (action.dryRun) return Effect.succeed(withDocSyncWarning(rootInput, action, decisionResult(rootInput, "decision-propose", decision.decision_id, decision.state, true)));
  return service.propose({ decision, body: action.body }).pipe(
    Effect.match({
      onFailure: (error): CliResult => decisionFailure("decision-propose", decision.decision_id, error),
      onSuccess: (result): CliResult => withDocSyncWarning(rootInput, action, decisionResult(rootInput, "decision-propose", result.decisionId, result.state, false))
    })
  );
}

export function materializeProposedDecision(action: ProposeAction):
  | { readonly ok: true; readonly decision: DecisionCreateInput }
  | { readonly ok: false; readonly code: CliErrorCode; readonly reason: string } {
  const baseDecision = proposedDecision(action, []);
  const fulfilled = applyClaimFulfillments(baseDecision, action.fulfillments);
  if (!fulfilled.ok) return { ok: false, code: CliErrorCode.InvalidDecisionAmendPatch, reason: fulfilled.reason };
  const relations = decisionEvidenceRelations(fulfilled.decision, action.evidenceRelations);
  if (!relations.ok) return { ok: false, code: CliErrorCode.InvalidDecisionEvidenceRelation, reason: relations.reason };
  return { ok: true, decision: { ...fulfilled.decision, relations: relations.records } };
}

function withDocSyncWarning(rootInput: HarnessLayoutInput, action: ProposeAction, result: CliResult): CliResult {
  const bodyWarning = withDecisionBodyEmptyWarning(result, action.body, action.title);
  return { ...bodyWarning, warnings: [...(bodyWarning.warnings ?? []), ...(docSyncDirtyWarnings(rootInput) ?? [])] };
}

function proposedDecision(action: ProposeAction, relations: ReadonlyArray<EntityRelationRecord>): DecisionCreateInput {
  return {
    schema: "decision-package/v1",
    decision_id: action.decisionId,
    title: action.title,
    state: "proposed",
    riskTier: action.riskTier,
    urgency: action.urgency,
    vertical: "software/coding",
    preset: "architecture-decision",
    applies_to: { modules: [...action.modules], productLines: [...action.productLines] },
    proposedAt: action.proposedAt,
    question: action.question,
    chosen: proposedChosen(action),
    rejected: proposedRejected(action),
    claims: proposedClaims(action),
    relations
  };
}

function proposedChosen(action: ProposeAction): DecisionCreateInput["chosen"] {
  return action.chosen.map((choice) => ({
      id: normalizedAnchorId(choice.id, "chosen"),
      text: choice.text,
      ...(choice.load_bearing === undefined ? {} : { load_bearing: choice.load_bearing })
    }));
}

function proposedRejected(action: ProposeAction): DecisionCreateInput["rejected"] {
  return action.rejected.map((rejected) => ({
      id: normalizedAnchorId(rejected.id, "rejected"),
      text: rejected.text,
      why_not: rejected.why_not ?? ""
    }));
}

function proposedClaims(action: ProposeAction): DecisionCreateInput["claims"] {
  return action.claims.map((claim) => ({
      id: normalizedAnchorId(claim.id, "claim"),
      text: claim.text,
      ...(claim.load_bearing === undefined ? {} : { load_bearing: claim.load_bearing }),
      ...(claim.fulfillment ? { fulfillment: claim.fulfillment } : {})
    }));
}

function normalizedAnchorId(id: string | undefined, kind: string): string {
  if (!id) throw new Error(`decision propose ${kind} anchor was not normalized by the command parser`);
  return id;
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
