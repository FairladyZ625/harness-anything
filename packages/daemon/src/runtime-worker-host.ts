import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { consumeKnownError } from "@harness-anything/kernel";
import { dispatchStreamPath, openDispatchStreamAppender, scrubProviderValue } from "./dispatch-stream.ts";
import { createRuntimeCallbackRelay } from "./runtime-callback-relay.ts";
import { runAcpProviderSession } from "./runtime-worker-acp.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import type { RuntimeCallbackRelay } from "./runtime-spawn-types.ts";

type RuntimeWorkerManifest = {
  readonly rootDir: string;
  readonly dispatchId: string;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly windowsVerbatimArguments: boolean;
  readonly callbackRelay?: RuntimeCallbackRelay;
  readonly kindId?: string;
  readonly protocolFamily?: string;
  readonly permissionMode?: string;
  readonly providerSessionId?: string;
  readonly acpApiKey?: string;
};

const providerGitCredentialEnvironment = new Set([
  "GH_TOKEN",
  "HARNESS_GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "HARNESS_GITLAB_TOKEN",
  "GIT_ASKPASS",
  "GIT_ASKPASS_REQUIRE",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_SSH",
  "GIT_SSH_VARIANT",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "SSH_AUTH_SOCK",
]);

/**
 * Provider processes retain their own authentication environment, while Git gets no host
 * credential sources. Settlement invokes the daemon-side push path with its own environment.
 */
export function runtimeWorkerProviderEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of providerGitCredentialEnvironment) delete environment[name];
  for (const name of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)) delete environment[name];
  }
  const nullDevice = platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_SSH_COMMAND: `ssh -F ${nullDevice} -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o IdentityFile=${nullDevice}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function runRuntimeWorkerHost(): Promise<void> {
  const control = { handler: null as ((prompt: string) => void) | null };
  const lines = createInterface({ input: process.stdin }),
    iterator = lines[Symbol.asyncIterator](),
    first = await iterator.next();
  if (first.done) throw new Error("runtime worker manifest is missing");
  const manifest = parseManifest(first.value);
  void (async () => {
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      const value = JSON.parse(line) as { kind?: unknown; prompt?: unknown };
      if (value.kind === "steer" && typeof value.prompt === "string") control.handler?.(value.prompt);
    }
  })();
  const stream = dispatchStreamPath(manifest.rootDir, manifest.dispatchId),
    // One descriptor for the host's whole lifetime: provider output appends once per line.
    appender = openDispatchStreamAppender(stream);
  const append = (value: Readonly<Record<string, unknown>>): void =>
    appender.append({
      occurredAt: new Date().toISOString(),
      ...value,
    });
  const relay = manifest.callbackRelay
    ? createRuntimeCallbackRelay({
        rootDir: manifest.rootDir,
        dispatchId: manifest.dispatchId,
        route: {
          userRoot: manifest.env.HARNESS_DAEMON_USER_ROOT ?? "",
          daemonId: manifest.env.HARNESS_DAEMON_ID ?? "",
          endpoint: manifest.callbackRelay.endpoint,
        },
        relayPath: manifest.callbackRelay.path,
      })
    : null;
  let child: ReturnType<typeof spawn> | undefined,
    providerSessionId = manifest.providerSessionId ?? null,
    queuedPrompt: string | null = null,
    interruptTimer: NodeJS.Timeout | undefined;
  const activeTools = new Set<string>();
  let settled = false,
    terminationRequested = false;
  process.once("SIGTERM", () => {
    terminationRequested = true;
    queuedPrompt = null;
    clearTimeout(interruptTimer);
    if (!settled) child?.kill("SIGTERM");
  });
  try {
    await relay?.start();
    // This host owns the provider's lifetime. WINDSURF_EXT_HOST_PID comes from the editor terminal that started
    // the daemon, and devin's ACP server exits 0 as soon as that editor process is gone.
    const { WINDSURF_EXT_HOST_PID: _editorHostPid, ...hostEnvironment } = manifest.env,
      // The callback route is provenance, not authority. The CLI still needs its registry namespace.
      providerEnv = runtimeWorkerProviderEnvironment(
        relay ? { ...hostEnvironment, HARNESS_DAEMON_ENDPOINT: relay.endpoint } : hostEnvironment,
      );
    const declaration = manifest.kindId ? runtimeKindForId(manifest.kindId) : null;
    const baseArgs = [...manifest.args];
    let args = [...baseArgs],
      prompt = manifest.prompt,
      interrupted = false;
    const interrupt = (): void => {
      if (child && !interrupted) {
        interrupted = true;
        child.kill("SIGINT");
      }
    };
    control.handler = (nextPrompt) => {
      if (!declaration?.steer) return;
      queuedPrompt = nextPrompt;
      if (activeTools.size === 0) interrupt();
      else if (!interruptTimer)
        interruptTimer = setTimeout(() => {
          if (queuedPrompt !== null) {
            append({ kind: "steer_forced_interrupt", occurredAt: new Date().toISOString() });
            interrupt();
          }
        }, 5_000);
    };
    for (;;) {
      child = spawn(manifest.executablePath, args, {
        cwd: manifest.cwd,
        env: providerEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(manifest.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) =>
        append({
          kind: "provider_stderr",
          chunk: scrubProviderValue(chunk) as string,
        }),
      );
      // ACP providers speak bidirectional JSON-RPC on stdout; the acp session loop
      // owns stdout parsing and stdin writes instead of the line-relay path.
      const acp =
        manifest.protocolFamily === "acp" && typeof manifest.kindId === "string"
          ? runAcpProviderSession(child, manifest as RuntimeWorkerManifest & { readonly kindId: string }, append)
          : null;
      let outputBuffer = "";
      const consumeOutput = (chunk: string, flush = false): void => {
        outputBuffer += chunk;
        const lines = outputBuffer.split(/\r?\n/u);
        const trailing = lines.pop() ?? "";
        outputBuffer = flush ? "" : trailing;
        for (const line of [...lines, ...(flush && trailing.trim() ? [trailing] : [])]) {
          if (!line.trim()) continue;
          const parsed = appendProviderLine(append, line),
            state = parsed ? providerSteerState(parsed, manifest.kindId) : {};
          if (state.sessionId) providerSessionId = state.sessionId;
          if (state.toolStart) activeTools.add(state.toolStart);
          if (state.toolEnd === "") activeTools.clear();
          else if (state.toolEnd) activeTools.delete(state.toolEnd);
          if (queuedPrompt !== null && activeTools.size === 0) interrupt();
        }
      };
      if (!acp) {
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => consumeOutput(chunk));
      }
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(interruptTimer);
        lines.close();
        if (!acp) consumeOutput("", true);
        append({ kind: "process_exit", exitCode, signal });
      };
      child.once("error", (error) => {
        append({ kind: "provider_stderr", chunk: scrubProviderValue(error.message) as string });
      });
      if (!acp) child.stdin!.end(prompt);
      const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
        child!.once("close", (code: number | null, closeSignal: NodeJS.Signals | null) => resolve([code, closeSignal])),
      );
      // The daemon stops reading at process_exit, so the ACP session's last frame must land first.
      await acp?.done;
      if (!terminationRequested && queuedPrompt !== null && declaration?.steer && providerSessionId) {
        clearTimeout(interruptTimer);
        interruptTimer = undefined;
        args = [...declaration.steer.resumeArgs(baseArgs, providerSessionId)];
        prompt = queuedPrompt;
        queuedPrompt = null;
        activeTools.clear();
        interrupted = false;
        append({ kind: "steer_resumed", providerSessionId, occurredAt: new Date().toISOString() });
        continue;
      }
      finish(child.pid === undefined ? null : exitCode, signal);
      break;
    }
  } finally {
    appender.close();
    await relay?.stop();
  }
}

function appendProviderLine(
  append: (value: Readonly<Record<string, unknown>>) => void,
  line: string,
): Record<string, unknown> | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    append({ kind: "provider_event", event: scrubProviderValue(event) });
    return event;
  } catch (error) {
    consumeKnownError(error);
    append({ kind: "provider_output_invalid", output: scrubProviderValue(line) });
    return null;
  }
}

function providerSteerState(
  value: Record<string, unknown>,
  kindId?: string,
): { sessionId?: string; toolStart?: string; toolEnd?: string } {
  if (kindId === "codex") {
    const item = value.item as Record<string, unknown> | undefined;
    if (value.type === "thread.started" && typeof value.thread_id === "string") return { sessionId: value.thread_id };
    if (
      item &&
      ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(String(item.type)) &&
      typeof item.id === "string"
    )
      return value.type === "item.started"
        ? { toolStart: item.id }
        : value.type === "item.completed"
          ? { toolEnd: item.id }
          : {};
  }
  if (kindId === "claude") {
    if (value.type === "system" && value.subtype === "init" && typeof value.session_id === "string")
      return { sessionId: value.session_id };
    const message = value.message as Record<string, unknown> | undefined,
      content = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [],
      tool = content.find((item) => item.type === "tool_use" && typeof item.id === "string");
    if (tool) return { toolStart: String(tool.id) };
    if (value.type === "user") return { toolEnd: "" };
  }
  return {};
}
function parseManifest(value: string): RuntimeWorkerManifest {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRuntimeWorkerRecord(parsed) ||
    typeof parsed.rootDir !== "string" ||
    typeof parsed.dispatchId !== "string" ||
    typeof parsed.executablePath !== "string" ||
    !Array.isArray(parsed.args) ||
    !parsed.args.every((arg) => typeof arg === "string") ||
    typeof parsed.cwd !== "string" ||
    !isRuntimeWorkerRecord(parsed.env) ||
    typeof parsed.prompt !== "string" ||
    typeof parsed.windowsVerbatimArguments !== "boolean" ||
    (parsed.callbackRelay !== undefined &&
      (!isRuntimeWorkerRecord(parsed.callbackRelay) ||
        typeof parsed.callbackRelay.endpoint !== "string" ||
        typeof parsed.callbackRelay.path !== "string"))
  )
    throw new Error("runtime worker manifest is invalid");
  return parsed as RuntimeWorkerManifest;
}
function isRuntimeWorkerRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
