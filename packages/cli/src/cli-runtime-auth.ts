import { renderLifecyclePhase } from "./cli-render.ts";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { cliErrorMessage } from "./cli-error.ts";
import { cliFailure } from "./cli-meta.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { relayRuntimeAuthTerminal, runCommandThroughDaemon } from "./daemon/client.ts";
import { randomUUID } from "node:crypto";

// Sign-in is interactive by design: the daemon spawns the provider CLI on the instance's isolated
// state root inside a daemon-owned PTY, and this bridge puts the operator's terminal in front of
// it. The person completes the provider's own prompts; the CLI never sees or handles credentials.
export async function runRuntimeAuthCommand(
  command: ThinCommand,
  writeActivity: (text: string) => void,
  ports: {
    readonly runCommandThroughDaemon?: typeof runCommandThroughDaemon;
    readonly relayRuntimeAuthTerminal?: typeof relayRuntimeAuthTerminal;
  } = {},
): Promise<JsonObject> {
  const runCommand = ports.runCommandThroughDaemon ?? runCommandThroughDaemon,
    relayTerminal = ports.relayRuntimeAuthTerminal ?? relayRuntimeAuthTerminal,
    spawned = await runCommand({
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
  let exitCode: number;
  try {
    exitCode = await relayTerminal(command, spawned.sessionId, writeActivity);
  } catch (error) {
    return runtimeRejected(
      command.action.kind,
      "daemon_disconnect",
      `The sign-in terminal stream failed: ${cliErrorMessage(error)}. ` +
        `The isolated state root keeps whatever the provider already stored; re-run the command to try again.`,
    );
  }
  const receipt: JsonObject = {
    ...spawned,
    command: command.action.kind,
    exitCode,
    summary: `${command.action.kind}: provider terminal exited ${exitCode}`,
  };
  if (exitCode !== 0 || command.action.kind !== "runtime-instance-login") return receipt;

  const instanceId = command.action.instanceId;
  if (typeof instanceId !== "string") return receipt;
  const showCommand: ThinCommand = {
    ...command,
    id: "runtime-instance-show",
    method: "daemon.runtimeInstance.show",
    action: { kind: "runtime-instance-show", instanceId },
  };
  try {
    const observed = await runCommand(showCommand),
      instance = observed.instance as Record<string, unknown> | undefined;
    if (observed.ok !== true || !instance)
      return {
        ...receipt,
        accountProbeError: "Could not inspect the runtime instance after sign-in.",
        summary: `${receipt.summary}\nCould not inspect the runtime instance after sign-in.`,
      };
    if (instance.kindId !== "agy" && instance.kindId !== "agy-acp") return receipt;

    const accountProbe = await runCommand({
        ...showCommand,
        action: { ...showCommand.action, probe: true },
      }),
      probeSummary =
        typeof accountProbe.summary === "string"
          ? accountProbe.summary
          : accountProbe.ok === true
            ? "AGY account probe finished."
            : `AGY account probe failed (${String(accountProbe.code ?? "unknown")}).`;
    return {
      ...receipt,
      accountProbe,
      summary: `${receipt.summary}\n${probeSummary}`,
    };
  } catch (error) {
    const detail = cliErrorMessage(error);
    return {
      ...receipt,
      accountProbeError: detail,
      summary: `${receipt.summary}\nAGY account probe could not complete: ${detail}`,
    };
  }
}

export function renderRuntimeStatus(value: JsonObject): string {
  if (value.session && typeof value.session === "object") {
    const session = value.session as Record<string, unknown>,
      activity = session.activity as Record<string, unknown>,
      providerUnreachable = activity.providerUnreachable as Record<string, unknown> | undefined,
      cancelledBy = activity.cancelledBy as Record<string, unknown> | undefined,
      cancelPrincipal = cancelledBy?.principal as Record<string, unknown> | undefined,
      cancelExecutor = cancelledBy?.executor as Record<string, unknown> | null | undefined,
      attemptChain = session.attemptChain as Record<string, unknown> | undefined,
      attempts = Array.isArray(attemptChain?.attempts) ? (attemptChain.attempts as Record<string, unknown>[]) : [];
    return [
      `session: ${session.runtimeSessionId}`,
      `instance: ${session.instanceId}`,
      `provider-session: ${session.providerSessionId ?? "-"}`,
      `lifecycle: ${renderLifecyclePhase(session.lifecycle)}`,
      `outcome: ${activity.outcome ?? "-"}`,
      `result: ${activity.resultRef ?? "-"}`,
      ...(providerUnreachable
        ? [
            `provider: ${String(providerUnreachable.state)}`,
            `last-progress: ${String(providerUnreachable.lastProgressAt)}`,
            `provider-error-at: ${String(providerUnreachable.lastErrorAt)}`,
            `provider-error: ${String(providerUnreachable.lastError)}`,
          ]
        : []),
      ...(cancelledBy
        ? [
            `cancelled-by-principal: ${String(cancelPrincipal?.personId ?? "-")}`,
            `cancelled-by-executor: ${String(cancelExecutor?.id ?? "-")}`,
          ]
        : []),
      ...(attempts.length
        ? [
            `attempt-group: ${String(attemptChain?.attemptGroupId)}`,
            "ATTEMPT\tPROVIDER\tMODEL\tCLASSIFICATION\tLIFECYCLE\tREASON",
            ...attempts.map((attempt) => {
              const provider = attempt.provider as Record<string, unknown>;
              return [
                attempt.attemptIndex,
                provider.instance,
                provider.model ?? "-",
                attempt.classification ?? "-",
                renderLifecyclePhase(attempt.lifecycle),
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
        "SESSION\tINSTANCE\tLIFECYCLE\tACTIVITY\tOUTCOME\tRESULT",
        ...sessions.map((session) => {
          const activity = session.activity as Record<string, unknown>,
            providerUnreachable = activity.providerUnreachable as Record<string, unknown> | undefined;
          return [
            session.runtimeSessionId,
            session.instanceId,
            renderLifecyclePhase(session.lifecycle),
            providerUnreachable?.state ?? "-",
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
  return cliFailure(command, code, hint);
}
