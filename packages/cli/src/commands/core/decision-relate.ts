import path from "node:path";
import { Effect } from "effect";
import { readDecisionDocument, type DecisionWriteService, type DecisionWriteRejected } from "../../../../application/src/index.ts";
import { deriveRelationId, type DecisionPackage, type EntityRelationRecord, type WriteError } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../../kernel/src/layout/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

type DecisionRelateAction = Extract<ParsedCommand["action"], { readonly kind: "decision-relate" }>;

export function runDecisionRelate(
  rootInput: Parameters<typeof readDecisionDocument>[0],
  service: DecisionWriteService,
  action: DecisionRelateAction
): Effect.Effect<CliResult, WriteError> {
  let current: DecisionPackage;
  try {
    current = readDecisionDocument(rootInput, action.decisionId).decision;
  } catch {
    return Effect.succeed({
      ok: false,
      command: "decision-relate",
      decisionId: action.decisionId,
      error: cliError(CliErrorCode.DecisionReadFailed, `decision document could not be read: ${action.decisionId}`)
    } satisfies CliResult);
  }

  const relation = decisionRelation(current, action);
  if (!relation.ok) {
    return Effect.succeed({
      ok: false,
      command: "decision-relate",
      decisionId: current.decision_id,
      error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, relation.reason)
    } satisfies CliResult);
  }
  if (action.dryRun) return Effect.succeed(decisionRelateResult(rootInput, current.decision_id, current.state, true));
  return service.relate({ current, relation: relation.record, body: action.body }).pipe(
    Effect.match({
      onFailure: (error): CliResult => decisionRelateFailure(current.decision_id, error),
      onSuccess: (result): CliResult => decisionRelateResult(rootInput, result.decisionId, result.state, false)
    })
  );
}

function decisionRelation(
  decision: DecisionPackage,
  action: DecisionRelateAction
): { readonly ok: true; readonly record: EntityRelationRecord } | { readonly ok: false; readonly reason: string } {
  const anchorIds = new Set([
    ...decision.claims.map((entry) => entry.id),
    ...decision.chosen.map((entry) => entry.id),
    ...decision.rejected.map((entry) => entry.id)
  ]);
  if (!anchorIds.has(action.anchor)) {
    return { ok: false, reason: `decision relation source anchor does not exist: ${action.anchor}` };
  }
  const base = {
    source: `decision/${decision.decision_id}/${action.anchor}`,
    target: action.target,
    type: action.relationType,
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: action.rationale,
    state: "active"
  } satisfies Omit<EntityRelationRecord, "relation_id">;
  return {
    ok: true,
    record: {
      relation_id: deriveRelationId(base),
      ...base
    }
  };
}

function decisionRelateResult(rootInput: HarnessLayoutInput, decisionId: string, state: string, dryRun: boolean): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const documentPath = layout.decisionDocumentPath(decisionId);
  return {
    ok: true,
    command: "decision-relate",
    decisionId,
    decisionState: state,
    path: path.relative(layout.rootDir, documentPath).split(path.sep).join("/"),
    report: { schema: "decision-write-cli-report/v1", dryRun }
  };
}

function decisionRelateFailure(decisionId: string, error: DecisionWriteRejected | WriteError): CliResult {
  const reason = "_tag" in error && error._tag === "DecisionWriteRejected" ? error.reason : JSON.stringify(error);
  return {
    ok: false,
    command: "decision-relate",
    decisionId,
    error: cliError(CliErrorCode.DecisionWriteRejected, reason)
  };
}
