import type {
  DecisionMutationResult,
  DecisionProposePayload,
  DecisionTransitionPayload,
  LocalControllerCallContext,
  LocalControllerDecisionMutationPort,
  LocalControllerServiceOptions
} from "../../../../application/src/index.ts";
import type { AuthenticatedActor, JsonObject } from "../../../../daemon/src/index.ts";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode, isCliErrorCode } from "../../cli/error-codes.ts";
import { createCliCommandService, type CliCommandServiceOptions } from "../../daemon/command-service.ts";
import type { CliDaemonRuntime } from "../../daemon/queued-write-coordinator.ts";
import { readCatalogSnapshot } from "./catalog-snapshot.ts";

export function makeDaemonGuiControllerOptions(
  runtime: CliDaemonRuntime,
  rootInput: Exclude<HarnessLayoutInput, string>,
  commandOptions: CliCommandServiceOptions
): Pick<LocalControllerServiceOptions, "catalogSnapshotReader" | "decisionMutationPort"> {
  return {
    catalogSnapshotReader: () => readCatalogSnapshot(rootInput),
    decisionMutationPort: makeDaemonDecisionMutationPort(runtime, rootInput, commandOptions)
  };
}

function makeDaemonDecisionMutationPort(
  runtime: CliDaemonRuntime,
  rootInput: Exclude<HarnessLayoutInput, string>,
  commandOptions: CliCommandServiceOptions
): LocalControllerDecisionMutationPort {
  const commands = createCliCommandService(runtime, commandOptions);
  const run = async (
    action: Record<string, unknown>,
    context?: LocalControllerCallContext
  ): Promise<DecisionMutationResult> => {
    if (!context?.actor) {
      return { ok: false, error: cliError(CliErrorCode.AuthMissing, "Decision writes require a transport-authenticated actor.") };
    }
    const receipt = await commands.runCommand({
      command: {
        rootDir: rootInput.rootDir,
        ...(rootInput.layoutOverrides ? { layoutOverrides: rootInput.layoutOverrides } : {}),
        json: true,
        action
      } as unknown as JsonObject
    }, { actor: context.actor as AuthenticatedActor, executor: null });
    if (!receipt.ok) {
      return {
        ok: false,
        error: cliError(
          isCliErrorCode(receipt.error?.code) ? receipt.error.code : CliErrorCode.DecisionWriteRejected,
          receipt.error?.hint ?? receipt.summary
        )
      };
    }
    const data = receipt.details?.data;
    const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const decisionId = typeof record.decisionId === "string" ? record.decisionId : undefined;
    const state = typeof record.decisionState === "string" ? record.decisionState : undefined;
    return decisionId && state
      ? { ok: true, decisionId, state }
      : { ok: false, error: cliError(CliErrorCode.CommandReceiptContractMismatch, "Decision command returned no decision id or state.") };
  };
  const transition = (transition: "accept" | "reject" | "defer") => (
    payload: DecisionTransitionPayload,
    context?: LocalControllerCallContext
  ) => run({
    kind: "decision-transition",
    transition,
    decisionId: payload.decisionId,
    fulfillments: [],
    dryRun: false,
    ...(payload.decidedAt ? { decidedAt: payload.decidedAt } : {}),
    ...(payload.judgmentOnlyRationale ? { judgmentOnlyRationale: payload.judgmentOnlyRationale } : {}),
    ...(payload.standingPolicy !== undefined ? { standingPolicy: payload.standingPolicy } : {}),
    ...(payload.body !== undefined ? { body: payload.body } : {})
  }, context);
  return {
    propose: (payload: DecisionProposePayload, context) => run({
      kind: "decision-propose",
      ...(payload.decisionId ? { decisionId: payload.decisionId } : {}),
      title: payload.title,
      question: payload.question,
      chosen: payload.chosen,
      rejected: payload.rejected,
      claims: payload.claims ?? [],
      claimLoadBearing: true,
      fulfillments: [],
      riskTier: payload.riskTier,
      urgency: payload.urgency,
      modules: payload.modules ?? [],
      productLines: payload.productLines ?? [],
      evidenceRelations: payload.evidenceRelations ?? [],
      ...(payload.body !== undefined ? { body: payload.body } : {}),
      dryRun: false
    }, context),
    accept: transition("accept"),
    reject: transition("reject"),
    defer: transition("defer")
  };
}
