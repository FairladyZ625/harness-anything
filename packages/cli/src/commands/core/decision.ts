import { Effect } from "effect";
import {
  readDecisionDocument,
  type DecisionWriteService,
  type DecisionCreateInput,
  type DecisionWriteRejected
} from "../../../../application/src/index.ts";
import type { DecisionPackage, DecisionState, WriteError } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

type DecisionAction = Extract<ParsedCommand["action"], { readonly kind:
  | "decision-propose"
  | "decision-accept"
  | "decision-reject"
  | "decision-defer"
  | "decision-supersede"
  | "decision-amend"
  | "decision-retire"
}>;
type TransitionAction = Extract<DecisionAction, { readonly kind: "decision-accept" | "decision-reject" | "decision-defer" | "decision-supersede" | "decision-retire" }>;

export const runDecisionCommand: CommandRunner = (context, command) => {
  const action = command.action as DecisionAction;
  const service = context.decisionWriteService;
  switch (action.kind) {
    case "decision-propose":
      return runPropose(service, action);
    case "decision-accept":
    case "decision-reject":
    case "decision-defer":
    case "decision-supersede":
    case "decision-retire":
      return runTransition(context.layoutInput, service, action);
    case "decision-amend":
      return runAmend(context.layoutInput, service, action);
  }
};

function runPropose(
  service: DecisionWriteService,
  action: Extract<DecisionAction, { readonly kind: "decision-propose" }>
): Effect.Effect<CliResult, WriteError> {
  const now = new Date().toISOString();
  const decision = proposedDecision(action, now);
  if (action.dryRun) return Effect.succeed(decisionResult("decision-propose", decision.decision_id, decision.state, true));
  return service.propose({ decision, body: action.body }).pipe(
    Effect.match({
      onFailure: (error): CliResult => decisionFailure("decision-propose", decision.decision_id, error),
      onSuccess: (result): CliResult => decisionResult("decision-propose", result.decisionId, result.state, false)
    })
  );
}

function runTransition(
  rootInput: Parameters<typeof readDecisionDocument>[0],
  service: DecisionWriteService,
  action: TransitionAction
): Effect.Effect<CliResult, WriteError> {
  return Effect.try({
    try: () => readDecisionDocument(rootInput, action.decisionId).decision,
    catch: (cause) => ({ _tag: "DecisionReadFailed" as const, cause })
  }).pipe(
    Effect.flatMap((current) => {
      const arbiter = parseActor(action.arbiter) ?? current.arbiter;
      const request = { current, arbiter, decidedAt: action.decidedAt, body: action.body };
      if (action.dryRun) return Effect.succeed(decisionResult(action.kind, current.decision_id, transitionState(action.kind), true));
      switch (action.kind) {
        case "decision-accept":
          return service.accept(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(action.kind, current.decision_id, error), onSuccess: (result) => decisionResult(action.kind, result.decisionId, result.state, false) }));
        case "decision-reject":
          return service.reject(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(action.kind, current.decision_id, error), onSuccess: (result) => decisionResult(action.kind, result.decisionId, result.state, false) }));
        case "decision-defer":
          return service.defer(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(action.kind, current.decision_id, error), onSuccess: (result) => decisionResult(action.kind, result.decisionId, result.state, false) }));
        case "decision-supersede":
          return service.supersede(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(action.kind, current.decision_id, error), onSuccess: (result) => decisionResult(action.kind, result.decisionId, result.state, false) }));
        case "decision-retire":
          return service.retire(request).pipe(Effect.match({ onFailure: (error) => decisionFailure(action.kind, current.decision_id, error), onSuccess: (result) => decisionResult(action.kind, result.decisionId, result.state, false) }));
      }
    }),
    Effect.catchTag("DecisionReadFailed", () => Effect.succeed({
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
  return Effect.try({
    try: () => readDecisionDocument(rootInput, action.decisionId).decision,
    catch: (cause) => ({ _tag: "DecisionReadFailed" as const, cause })
  }).pipe(
    Effect.flatMap((current) => {
      const next = { ...current, ...(action.title ? { title: action.title } : {}) };
      if (action.dryRun) return Effect.succeed(decisionResult("decision-amend", current.decision_id, current.state, true));
      return service.amend({ current, next, body: action.body }).pipe(
        Effect.match({
          onFailure: (error): CliResult => decisionFailure("decision-amend", current.decision_id, error),
          onSuccess: (result): CliResult => decisionResult("decision-amend", result.decisionId, result.state, false)
        })
      );
    }),
    Effect.catchTag("DecisionReadFailed", () => Effect.succeed({
      ok: false,
      command: "decision-amend",
      decisionId: action.decisionId,
      error: cliError(CliErrorCode.DecisionReadFailed, `decision document could not be read: ${action.decisionId}`)
    } satisfies CliResult))
  );
}

function proposedDecision(action: Extract<DecisionAction, { readonly kind: "decision-propose" }>, now: string): DecisionCreateInput {
  return {
    schema: "decision-package/v1",
    decision_id: action.decisionId ?? `dec_${Date.now().toString(36)}`,
    title: action.title,
    state: "proposed",
    riskTier: action.riskTier,
    urgency: action.urgency,
    vertical: "software/coding",
    preset: "architecture-decision",
    applies_to: {
      modules: [...action.modules],
      productLines: [...action.productLines]
    },
    proposedBy: parseActor(action.proposedBy) ?? { kind: "agent", id: "decision-cli" },
    proposedAt: now,
    arbiter: parseActor(action.arbiter) ?? { kind: "human", id: process.env.USER || "local-human" },
    question: action.question,
    chosen: [{ id: "CH1", text: action.chosen }],
    rejected: [{ id: "RJ1", text: action.rejected, why_not: action.whyNot }],
    claims: [{ id: "C1", text: action.claim ?? action.chosen }],
    relations: []
  };
}

function parseActor(value: string | undefined): DecisionPackage["arbiter"] | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const kind = value.slice(0, separator);
  if (kind !== "agent" && kind !== "human" && kind !== "system") return null;
  return { kind, id: value.slice(separator + 1) };
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

function decisionResult(command: string, decisionId: string, state: string, dryRun: boolean): CliResult {
  return {
    ok: true,
    command,
    decisionId,
    decisionState: state,
    path: `harness/decisions/decision-${decisionId}/decision.md`,
    report: { schema: "decision-write-cli-report/v1", dryRun }
  };
}

function decisionFailure(command: string, decisionId: string, error: DecisionWriteRejected | WriteError): CliResult {
  const reason = "_tag" in error && error._tag === "DecisionWriteRejected" ? error.reason : JSON.stringify(error);
  return {
    ok: false,
    command,
    decisionId,
    error: cliError(CliErrorCode.DecisionWriteRejected, reason)
  };
}
