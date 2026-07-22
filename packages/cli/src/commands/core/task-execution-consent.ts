import { Effect } from "effect";
import { makeRecordExecutionConsentService } from "@harness-anything/application";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { resolveExecutionConsentTtlMs } from "../project-policy-settings.ts";

type Action = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-consent-record" }>;

export function runExecutionConsent(context: Parameters<CommandRunner>[0], action: Action): ReturnType<CommandRunner> {
  const consentTtl = resolveExecutionConsentTtlMs(context.layoutInput, process.env, action.kind);
  if (!consentTtl.ok) return Effect.succeed(consentTtl.result);
  const service = makeRecordExecutionConsentService({
    rootInput: context.layoutInput,
    coordinator: context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "execution-consent" }),
    artifactStore: context.artifactStore,
    ttlMs: consentTtl.ttlMs
  });
  return context.currentSessionProbe.currentSession.pipe(
    Effect.flatMap((session) => Effect.tryPromise({
      try: () => service.recordConsent({
        taskId: action.taskId,
        executionId: action.executionId,
        actor: context.taskHolderPrincipal(),
        session,
        utterance: action.utterance,
        standingPolicyDecisionId: action.standingPolicyDecisionId,
        assertedRationale: action.assertedRationale,
        actions: action.consentActions
      }),
      catch: (error) => error
    })),
    Effect.match({
      onFailure: (error): CliResult => ({
        ok: false,
        command: action.kind,
        taskId: action.taskId,
        executionId: action.executionId,
        error: cliError(CliErrorCode.WriteRejected, error instanceof Error ? error.message : String(error))
      }),
      onSuccess: ({ consent }): CliResult => ({
        ok: true,
        command: action.kind,
        taskId: action.taskId,
        executionId: action.executionId,
        consentId: consent.consent_id,
        report: {
          schema: "execution-consent-result/v1",
          consentId: consent.consent_id,
          contentPin: consent.scope.content_pin.digest,
          actions: consent.scope.actions,
          channel: consent.channel,
          source: consent.source,
          expiresAt: consent.expires_at,
          state: consent.state
        }
      })
    })
  );
}
