import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { relayRuntimeAuthTerminal, runCommandThroughDaemon } from "./daemon/client.ts";
import { randomUUID } from "node:crypto";

// Sign-in is interactive by design: the daemon spawns the provider CLI on the instance's isolated
// state root inside a daemon-owned PTY, and this bridge puts the operator's terminal in front of
// it. The person completes the provider's own prompts; the CLI never sees or handles credentials.
export async function runRuntimeAuthCommand(
  command: ThinCommand,
  writeActivity: (text: string) => void,
): Promise<JsonObject> {
  const spawned = await runCommandThroughDaemon({
    ...command,
    action: {
      ...command.action,
      idempotencyKey:
        typeof command.action.idempotencyKey === "string"
          ? command.action.idempotencyKey
          : `runtime-auth-${randomUUID()}`,
    },
  });
  if (spawned.ok !== true || typeof spawned.sessionId !== "string") return spawned;
  try {
    const exitCode = await relayRuntimeAuthTerminal(command, spawned.sessionId, writeActivity);
    return {
      ...spawned,
      command: command.action.kind,
      exitCode,
      summary: `${command.action.kind}: provider terminal exited ${exitCode}`,
    };
  } catch (error) {
    return runtimeRejected(
      command.action.kind,
      "daemon_disconnect",
      `The sign-in terminal stream failed: ${error instanceof Error ? error.message : String(error)}. ` +
        `The isolated state root keeps whatever the provider already stored; re-run the command to try again.`,
    );
  }
}

export function renderRuntimeStatus(value: JsonObject): string {
  if (value.session && typeof value.session === "object") {
    const session = value.session as Record<string, unknown>,
      activity = session.activity as Record<string, unknown>,
      attemptChain = session.attemptChain as Record<string, unknown> | undefined,
      attempts = Array.isArray(attemptChain?.attempts) ? (attemptChain.attempts as Record<string, unknown>[]) : [];
    return [
      `session: ${session.runtimeSessionId}`,
      `instance: ${session.instanceId}`,
      `provider-session: ${session.providerSessionId ?? "-"}`,
      `liveness: ${session.liveness}`,
      `outcome: ${activity.outcome ?? "-"}`,
      `result: ${activity.resultRef ?? "-"}`,
      ...(attempts.length
        ? [
            `attempt-group: ${String(attemptChain?.attemptGroupId)}`,
            "ATTEMPT\tPROVIDER\tMODEL\tCLASSIFICATION\tFALLBACK\tREASON",
            ...attempts.map((attempt) => {
              const provider = attempt.provider as Record<string, unknown>;
              return [
                attempt.attemptIndex,
                provider.instance,
                provider.model ?? "-",
                attempt.classification ?? "-",
                attempt.fallbackState ?? "-",
                attempt.reason ?? "-",
              ]
                .map(String)
                .join("\t");
            }),
          ]
        : []),
    ].join("\n");
  }
  const sessions = Array.isArray(value.sessions) ? (value.sessions as Record<string, unknown>[]) : [];
  return sessions.length
    ? [
        "SESSION\tINSTANCE\tLIVENESS\tOUTCOME\tRESULT",
        ...sessions.map((session) => {
          const activity = session.activity as Record<string, unknown>;
          return [
            session.runtimeSessionId,
            session.instanceId,
            session.liveness,
            activity.outcome ?? "-",
            activity.resultRef ?? "-",
          ]
            .map(String)
            .join("\t");
        }),
      ].join("\n")
    : "No runtime sessions.";
}

export function runtimeRejected(command: string, code: string, hint: string): JsonObject {
  return {
    schema: "command-receipt/v2",
    ok: false,
    command,
    outcome: "op_rejected",
    opId: "N/A",
    origin: "cli",
    code,
    evidence: `rejection:${code}`,
    error: { code, hint },
    nextAction: hint,
  };
}
