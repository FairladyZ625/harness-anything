import type { CommandFailureReceipt, CommandReceipt } from "../../../application/src/index.ts";
import {
  requestLocalDaemonJsonRpcForTarget,
  resolveLocalDaemonTarget,
  type JsonObject
} from "../../../daemon/src/index.ts";
import { readOption, stripGlobalOptions } from "../cli/parse-options.ts";
import { daemonClientCliEntrypointPath, readDaemonClientConfig } from "../daemon/client.ts";

type Receipt = CommandReceipt | CommandFailureReceipt;
type AgentRuntimeRequester = (method: string, payload: JsonObject | undefined, rootDir: string) => Promise<Receipt>;

export async function runAgentRuntimeCommand(
  argv: ReadonlyArray<string>,
  request: AgentRuntimeRequester = requestAgentRuntimeDaemon
): Promise<{ readonly receipt: Receipt; readonly json: boolean }> {
  const stripped = stripGlobalOptions(argv);
  const action = stripped.args[1] ?? "help";
  if (action === "help") return { receipt: agentCommandSuccess("agent help", agentHelp()), json: stripped.json };
  const runtimeSessionId = readOption(stripped.args, "--session");
  let method: string;
  let payload: JsonObject | undefined;
  if (action === "profiles") {
    method = "repo.agent-runtimes.profiles";
  } else if (action === "run" || action === "resume") {
    const kindId = readOption(stripped.args, "--runtime");
    const prompt = readOption(stripped.args, "--prompt");
    const authenticationProfileKind = readOption(stripped.args, "--profile");
    const providerSessionId = readOption(stripped.args, "--provider-session");
    if ((kindId !== "claude-code" && kindId !== "codex") || !prompt || !authenticationProfileKind || (action === "resume" && !providerSessionId)) {
      return { receipt: failure("agent", "invalid_agent_command", agentHelp()), json: stripped.json };
    }
    method = "repo.agent-runtimes.spawn";
    payload = {
      kindId,
      prompt,
      cwd: readOption(stripped.args, "--cwd") ?? stripped.rootDir,
      authenticationProfileKind,
      ...(providerSessionId ? { resumeProviderSessionId: providerSessionId } : {}),
      ...(readOption(stripped.args, "--task") ? { taskId: readOption(stripped.args, "--task") as string } : {}),
      ...(readOption(stripped.args, "--execution") ? { executionId: readOption(stripped.args, "--execution") as string } : {})
    };
  } else if (["attach", "events", "result"].includes(action)) {
    if (!runtimeSessionId) return { receipt: failure("agent", "runtime_session_required", "Pass --session <runtime-session-id>."), json: stripped.json };
    method = `repo.agent-runtimes.${action}`;
    payload = {
      runtimeSessionId,
      ...(action === "events" && readOption(stripped.args, "--cursor") ? { cursor: Number(readOption(stripped.args, "--cursor")) } : {})
    };
  } else if (action === "status") {
    method = "repo.agent-runtimes.status";
    payload = runtimeSessionId ? { runtimeSessionId } : undefined;
  } else {
    return { receipt: failure("agent", "unknown_agent_command", agentHelp()), json: stripped.json };
  }
  return { receipt: await request(method, payload, stripped.rootDir), json: stripped.json };
}

async function requestAgentRuntimeDaemon(method: string, payload: JsonObject | undefined, rootDir: string): Promise<Receipt> {
  const config = readDaemonClientConfig(process.env, rootDir);
  if (config.mode !== "local") return failure("agent", "agent_runtime_requires_local_daemon", "Agent runtime commands require the local daemon; omit HARNESS_DAEMON_MODE=direct or remote.");
  const target = resolveLocalDaemonTarget({
    rootDir,
    userRoot: config.userRoot,
    daemonId: config.daemonId,
    autoRegisterSingleRepo: true
  });
  const response = await requestLocalDaemonJsonRpcForTarget(target, method, {
    repo: { repoId: target.repoId },
    payload: payload ?? {}
  }, 200, {
    entryPath: daemonClientCliEntrypointPath(),
    idleExitMs: config.idleExitMs,
    timeoutMs: config.autostartTimeoutMs
  });
  if (isReceipt(response)) return response;
  return failure("agent", "agent_runtime_response_invalid", `${method} did not return command-receipt/v2.`);
}

function agentHelp(): string {
  return "Use `ha agent profiles|run|resume|status|result|events|attach`; run/resume require --runtime, --profile, --prompt, and resume also requires --provider-session.";
}

function agentCommandSuccess(command: string, summary: string): CommandReceipt {
  return { ok: true, schema: "command-receipt/v2", command, action: command, summary, details: {}, meta: metadata() };
}

function failure(command: string, code: string, hint: string): CommandFailureReceipt {
  return { ok: false, schema: "command-receipt/v2", command, action: command, summary: hint, error: { code, hint }, meta: metadata() };
}

function metadata() {
  return { generatedAt: new Date().toISOString(), compatibility: { legacyReceipt: "CommandReceipt/v1" as const } };
}

function isReceipt(value: unknown): value is Receipt {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "ok" in value && "schema" in value;
}
