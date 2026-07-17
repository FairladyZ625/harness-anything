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
import { acceptEvidenceFloorHint, decisionFailure, decisionHasAcceptEvidenceFloor, decisionResult, withDecisionBodyEmptyWarning } from "./decision-shared.ts";
import { applyClaimFulfillments } from "./decision-claim-fulfillment.ts";
import { verifyDecisionContentPins } from "./decision-content-pin-verifier.ts";

type DecisionAction = Extract<ParsedCommand["action"], { readonly kind:
  | "decision-verify" | "decision-repin" | "decision-propose" | "decision-transition" | "decision-amend" | "decision-relate" | "decision-reckon" | "decision-relation-retire" | "decision-relation-replace"
}>;
type TransitionAction = Extract<DecisionAction, { readonly kind: "decision-transition" }>;

export const runDecisionCommand: CommandRunner = (context, command) => {
  if (command.action.kind === "decision-list" || command.action.kind === "decision-show") {
    return runDecisionQueryCommand(context, command);
  }
  const action = command.action as DecisionAction;
  if (action.kind === "decision-verify") return runDecisionVerify(context.layoutInput, action);
  const service = context.decisionWriteService;
  switch (action.kind) {
    case "decision-propose":
      return runPropose(context.layoutInput, service, action);
    case "decision-repin":
      return runDecisionRepin(context.layoutInput, service, action);
    case "decision-transition":
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

function runDecisionRepin(
  rootInput: Parameters<typeof readDecisionDocument>[0],
  service: DecisionWriteService,
  action: Extract<DecisionAction, { readonly kind: "decision-repin" }>
): Effect.Effect<CliResult, WriteError> {
  return readDecisionDocument(rootInput, action.decisionId).pipe(
    Effect.flatMap((document) => service.repinForMigration({
      current: document.decision,
      opIdPrefix: `amend-after-pin-${action.decisionId}`
    }).pipe(Effect.match({
      onFailure: (error): CliResult => decisionFailure("decision-repin", action.decisionId, error),
      onSuccess: (result): CliResult => decisionResult(rootInput, "decision-repin", result.decisionId, result.state, false)
    }))),
    Effect.catchAll(() => Effect.succeed({
      ok: false,
      command: "decision-repin",
      decisionId: action.decisionId,
      error: cliError(CliErrorCode.DecisionReadFailed, `decision document could not be read: ${action.decisionId}`)
    } satisfies CliResult))
  );
}

function runDecisionVerify(
  rootInput: Parameters<typeof readDecisionDocument>[0],
  action: Extract<DecisionAction, { readonly kind: "decision-verify" }>
): Effect.Effect<CliResult> {
  return Effect.sync(() => {
    const report = verifyDecisionContentPins(rootInput, { decisionIds: action.decisionIds });
    const decisionId = action.decisionIds?.[0];
    if (decisionId && report.checkedDecisionCount === 0) {
      return {
        ok: false,
        command: "decision-verify",
        decisionId,
        error: cliError(CliErrorCode.DecisionReadFailed, `decision not found: ${decisionId}`)
      } satisfies CliResult;
    }
    return {
      ok: true,
      command: "decision-verify",
      ...(decisionId ? { decisionId } : {}),
      rows: report.checkedDecisionCount,
      warnings: report.warnings.map((warning) => ({
        severity: "warning" as const,
        code: warning.code,
        message: warning.message
      })),
      report
    } satisfies CliResult;
  });
}

function runTransition(
  rootInput: Parameters<typeof readDecisionDocument>[0],
  service: DecisionWriteService,
  action: TransitionAction
): Effect.Effect<CliResult, WriteError> {
  const command = transitionCommand(action);
  return readDecisionDocument(rootInput, action.decisionId).pipe(
    Effect.flatMap((document) => {
      const current = document.decision;
      const fulfilled = applyClaimFulfillments(current, action.fulfillments);
      if (!fulfilled.ok) return Effect.succeed(fulfillmentFailure(command, current.decision_id, fulfilled.reason));
      const request = {
        current,
        claims: fulfilled.decision.claims,
        decidedAt: action.decidedAt,
        judgmentOnlyRationale: action.judgmentOnlyRationale,
        ...(action.transition === "accept" && action.standingPolicy ? { decisionClass: "standing-policy" as const } : {}),
        body: action.body
      };
      const withBodyWarning = (result: CliResult): CliResult => withDecisionBodyEmptyWarning(
        result,
        action.judgmentOnlyRationale?.trim() ? action.judgmentOnlyRationale : action.body ?? document.body,
        current.title
      );
      if (action.dryRun) {
        if (action.transition === "accept" && current.state === "proposed" && !action.judgmentOnlyRationale?.trim() && !decisionHasAcceptEvidenceFloor(current)) {
          return Effect.succeed({
            ok: false,
            command,
            decisionId: current.decision_id,
            error: cliError(CliErrorCode.DecisionWriteRejected, acceptEvidenceFloorHint(current))
          } satisfies CliResult);
        }
        const result = decisionResult(rootInput, command, current.decision_id, transitionState(action.transition), true);
        return Effect.succeed(action.transition === "accept" ? withBodyWarning(result) : result);
      }
      switch (action.transition) {
        case "accept":
          return service.accept(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(command, current.decision_id, error, current), onSuccess: (result) => withBodyWarning(decisionResult(rootInput, command, result.decisionId, result.state, false)) }));
        case "reject":
          return service.reject(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(command, current.decision_id, error), onSuccess: (result) => decisionResult(rootInput, command, result.decisionId, result.state, false) }));
        case "defer":
          return service.defer(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(command, current.decision_id, error), onSuccess: (result) => decisionResult(rootInput, command, result.decisionId, result.state, false) }));
        case "supersede":
          return service.supersede(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(command, current.decision_id, error), onSuccess: (result) => decisionResult(rootInput, command, result.decisionId, result.state, false) }));
        case "retire":
          return service.retire(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(command, current.decision_id, error), onSuccess: (result) => decisionResult(rootInput, command, result.decisionId, result.state, false) }));
      }
    }),
    Effect.catchAll(() => Effect.succeed({
      ok: false,
      command,
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
      const fulfilled = applyClaimFulfillments(current, action.fulfillments);
      if (!fulfilled.ok) return Effect.succeed(fulfillmentFailure("decision-amend", current.decision_id, fulfilled.reason));
      const patchResult = applyDecisionAmendPatches(fulfilled.decision, [
        ...(action.title ? [{ field: "title", operation: "replace", value: action.title } satisfies DecisionAmendPatchInput] : []),
        ...(action.standingPolicy ? [{ field: "decisionClass", operation: "metadata", value: "standing-policy" } satisfies DecisionAmendPatchInput] : []),
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

function transitionState(transition: TransitionAction["transition"]): DecisionState {
  switch (transition) {
    case "accept":
      return "active";
    case "reject":
      return "rejected";
    case "defer":
      return "deferred";
    case "supersede":
    case "retire":
      return "retired";
  }
}

function transitionCommand(action: TransitionAction): `decision-${TransitionAction["transition"]}` {
  return `decision-${action.transition}`;
}

function fulfillmentFailure(command: string, decisionId: string, reason: string): CliResult {
  return {
    ok: false,
    command,
    decisionId,
    error: cliError(CliErrorCode.InvalidDecisionAmendPatch, reason)
  };
}
