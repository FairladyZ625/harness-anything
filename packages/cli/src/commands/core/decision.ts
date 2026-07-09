import { Effect } from "effect";
import {
  readDecisionDocument,
  type DecisionWriteService,
} from "../../../../application/src/index.ts";
import { type DecisionState, type WriteError } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, DecisionAmendPatchInput, ParsedCommand } from "../../cli/types.ts";
import { applyDecisionAmendPatches } from "./decision-amend-patch.ts";
import { runPropose } from "./decision-propose.ts";
import { runDecisionQueryCommand } from "./decision-query.ts";
import { runReckon } from "./decision-reckon.ts";
import { runDecisionRelate, runDecisionRelationReplace, runDecisionRelationRetire } from "./decision-relate.ts";
import { acceptEvidenceFloorHint, decisionFailure, decisionHasAcceptEvidenceFloor, decisionResult, parseActor } from "./decision-shared.ts";

type DecisionAction = Extract<ParsedCommand["action"], { readonly kind:
  | "decision-propose" | "decision-accept" | "decision-reject" | "decision-defer" | "decision-supersede" | "decision-amend" | "decision-relate" | "decision-reckon" | "decision-relation-retire" | "decision-relation-replace" | "decision-retire"
}>;
type TransitionAction = Extract<DecisionAction, { readonly kind: "decision-accept" | "decision-reject" | "decision-defer" | "decision-supersede" | "decision-retire" }>;

export const runDecisionCommand: CommandRunner = (context, command) => {
  if (command.action.kind === "decision-list" || command.action.kind === "decision-show") {
    return runDecisionQueryCommand(context, command);
  }
  const action = command.action as DecisionAction;
  const service = context.decisionWriteService;
  switch (action.kind) {
    case "decision-propose":
      return runPropose(context.layoutInput, service, action);
    case "decision-accept":
    case "decision-reject":
    case "decision-defer":
    case "decision-supersede":
    case "decision-retire":
      return runTransition(context.layoutInput, service, action);
    case "decision-amend":
      return runAmend(context.layoutInput, service, action);
    case "decision-relate":
      return runDecisionRelate(context, service, action);
    case "decision-reckon":
      return runReckon(context.layoutInput, context.factWriteService, action);
    case "decision-relation-retire":
      return runDecisionRelationRetire(context.layoutInput, service, action);
    case "decision-relation-replace":
      return runDecisionRelationReplace(context, service, action);
  }
};

function runTransition(
  rootInput: Parameters<typeof readDecisionDocument>[0],
  service: DecisionWriteService,
  action: TransitionAction
): Effect.Effect<CliResult, WriteError> {
  return readDecisionDocument(rootInput, action.decisionId).pipe(
    Effect.map((document) => document.decision),
    Effect.flatMap((current) => {
      const arbiter = parseActor(action.arbiter) ?? current.arbiter;
      const request = { current, arbiter, decidedAt: action.decidedAt, judgmentOnlyRationale: action.judgmentOnlyRationale, body: action.body };
      if (action.dryRun) {
        if (action.kind === "decision-accept" && current.state === "proposed" && !action.judgmentOnlyRationale?.trim() && !decisionHasAcceptEvidenceFloor(current)) {
          return Effect.succeed({
            ok: false,
            command: action.kind,
            decisionId: current.decision_id,
            error: cliError(CliErrorCode.DecisionWriteRejected, acceptEvidenceFloorHint(current))
          } satisfies CliResult);
        }
        return Effect.succeed(decisionResult(rootInput, action.kind, current.decision_id, transitionState(action.kind), true));
      }
      switch (action.kind) {
        case "decision-accept":
          return service.accept(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(action.kind, current.decision_id, error, current), onSuccess: (result) => decisionResult(rootInput, action.kind, result.decisionId, result.state, false) }));
        case "decision-reject":
          return service.reject(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(action.kind, current.decision_id, error), onSuccess: (result) => decisionResult(rootInput, action.kind, result.decisionId, result.state, false) }));
        case "decision-defer":
          return service.defer(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(action.kind, current.decision_id, error), onSuccess: (result) => decisionResult(rootInput, action.kind, result.decisionId, result.state, false) }));
        case "decision-supersede":
          return service.supersede(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(action.kind, current.decision_id, error), onSuccess: (result) => decisionResult(rootInput, action.kind, result.decisionId, result.state, false) }));
        case "decision-retire":
          return service.retire(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(action.kind, current.decision_id, error), onSuccess: (result) => decisionResult(rootInput, action.kind, result.decisionId, result.state, false) }));
      }
    }),
    Effect.catchAll(() => Effect.succeed({
      ok: false,
      command: action.kind,
      decisionId: action.decisionId,
      error: cliError(CliErrorCode.DecisionReadFailed, `decision document could not be read: ${action.decisionId}`)
    } satisfies CliResult))
  );
}

function runAmend(
  rootInput: Parameters<typeof readDecisionDocument>[0],
  service: DecisionWriteService,
  action: Extract<DecisionAction, { readonly kind: "decision-amend" }>
): Effect.Effect<CliResult, WriteError> {
  return readDecisionDocument(rootInput, action.decisionId).pipe(
    Effect.map((document) => document.decision),
    Effect.flatMap((current) => {
      const patchResult = applyDecisionAmendPatches(current, [
        ...(action.title ? [{ field: "title", operation: "replace", value: action.title } satisfies DecisionAmendPatchInput] : []),
        ...action.patches
      ]);
      if (!patchResult.ok) return Effect.succeed(patchResult.result);
      if (action.dryRun) return Effect.succeed(decisionResult(rootInput, "decision-amend", current.decision_id, current.state, true));
      return service.amend({ current, next: patchResult.next, body: action.body }).pipe(
        Effect.match({
          onFailure: (error): CliResult => decisionFailure("decision-amend", current.decision_id, error),
          onSuccess: (result): CliResult => decisionResult(rootInput, "decision-amend", result.decisionId, result.state, false)
        })
      );
    }),
    Effect.catchAll(() => Effect.succeed({
      ok: false,
      command: "decision-amend",
      decisionId: action.decisionId,
      error: cliError(CliErrorCode.DecisionReadFailed, `decision document could not be read: ${action.decisionId}`)
    } satisfies CliResult))
  );
}

function transitionState(kind: TransitionAction["kind"]): DecisionState {
  switch (kind) {
    case "decision-accept":
      return "active";
    case "decision-reject":
      return "rejected";
    case "decision-defer":
      return "deferred";
    case "decision-supersede":
    case "decision-retire":
      return "retired";
  }
}
