import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { consumeKnownError } from "@harness-anything/kernel";
import { dispatchStreamPath, openDispatchStreamAppender, scrubProviderValue } from "./dispatch-stream.ts";
import { createRuntimeCallbackRelay } from "./runtime-callback-relay.ts";
import { tailRuntimeSteerCommands } from "./runtime-worker-control.ts";
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
  readonly handshakeTimeoutMs?: number;
  readonly model?: string;
};

// Codex compacts inside the turn (core/src/session/turn.rs keeps looping after a mid-turn
// compaction), but the sampling request that follows a compaction can return no assistant
// message; Codex then ends that turn normally with `task_complete.last_agent_message: null`
// and `exec` exits 0. A dispatched worker still owns its task at that point, so the host
// resumes the same thread rather than letting settlement read a stop. The judgment is only
// the observable shape — a completed compaction, no non-empty agent message after it, a clean
// exit — and every later resume must reproduce that shape, so this is not a retry on failure.
// The bound matches Codex's own empty-continuation breaker (three turns without activity), and
// it stops a session that answers every compaction with nothing from looping forever.
const compactionContinuationPrompt = "Continue the current task from where it left off.",
  maxCompactionContinuations = 3;

// `exec` drops the app-server's ContextCompaction item (`map_completed_item_mut` has no arm
// for it), so the only compaction trace in the JSON stream is the warning Codex emits right
// after replacing history (core/src/compact.rs), which exec maps to an error item. The wording
// is therefore the discriminator, and it must tolerate upstream renaming "threads" to
// "conversations" — the phrase "multiple compactions" is what the warning is about.
const codexCompactionWarning = /^Heads up: Long (?:threads|conversations) and multiple compactions\b/u;

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
 * Full-permission providers inherit the operator environment. Restricted providers lose host
 * Git credential sources; settlement still invokes the daemon-side push path independently.
 */
export function runtimeWorkerProviderEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  permissionMode: "full" | "restricted" = "full",
): NodeJS.ProcessEnv {
  const environment = { ...source };
  if (permissionMode === "restricted") {
    for (const name of providerGitCredentialEnvironment) delete environment[name];
    for (const name of Object.keys(environment)) {
      if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)) delete environment[name];
    }
  }
  const nullDevice = platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...environment,
    ...(permissionMode === "restricted"
      ? {
          GIT_CONFIG_GLOBAL: nullDevice,
          GIT_CONFIG_SYSTEM: nullDevice,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: "",
          GIT_SSH_COMMAND: `ssh -F ${nullDevice} -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o IdentityFile=${nullDevice}`,
          GIT_TERMINAL_PROMPT: "0",
        }
      : {}),
  };
}

export async function runRuntimeWorkerHost(): Promise<void> {
  const lines = createInterface({ input: process.stdin }),
    iterator = lines[Symbol.asyncIterator](),
    first = await iterator.next();
  if (first.done) throw new Error("runtime worker manifest is missing");
  const manifest = parseManifest(first.value);
  // The control channel is the dispatch stream, not this process's stdin: the daemon that
  // steers may be a successor that adopted the host after a restart and has no pipe to it.
  const control = { handler: null as ((prompt: string) => void) | null };
  const stream = dispatchStreamPath(manifest.rootDir, manifest.dispatchId),
    // One descriptor for the host's whole lifetime: provider output appends once per line.
    appender = openDispatchStreamAppender(stream);
  const append = (value: Readonly<Record<string, unknown>>): void =>
    appender.append({
      occurredAt: new Date().toISOString(),
      ...value,
    });
  const steerTail = tailRuntimeSteerCommands(stream, (prompt) => {
    if (control.handler) control.handler(prompt);
    else
      append({
        kind: "steer_dropped",
        reason: "the provider session is not established yet",
        prompt,
      });
  });
  const relay = manifest.callbackRelay
    ? createRuntimeCallbackRelay({
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
  // Continuations already granted to this dispatch: the bound is the dispatch's, not a process's.
  let settled = false,
    terminationRequested = false,
    compactionContinuations = 0;
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
        process.platform,
        manifest.env.HARNESS_WORKER_PERMISSION_MODE === "restricted" ? "restricted" : "full",
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
      if (!declaration?.steer) {
        append({ kind: "steer_dropped", reason: `${manifest.kindId ?? "this runtime"} declares no steer strategy` });
        return;
      }
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
      // An ACP kind steers in place: session/cancel ends the turn, the same session reprompts.
      if (acp) control.handler = acp.steer;
      let outputBuffer = "";
      // Per-attempt compaction recollection. A resume starts a new process and a new turn, so
      // each attempt's trace is independent: the continuation only happens when its own attempt
      // compacted after tool work and then completed a turn without answering. `toolWorkSinceAnswer`
      // separates the two compaction phases Codex emits the same warning for: mid-turn (tool work
      // pending, so the answer never came) and post-turn (the answer came first, then the warning,
      // which must not be read as an empty turn).
      let compactionCompleted = false,
        turnCompletedAfterCompaction = false,
        agentMessageAfterCompaction = false,
        toolWorkSinceAnswer = false;
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
          if (parsed && manifest.kindId === "codex") {
            if (codexCompactionWarning.test(codexErrorItemMessage(parsed))) {
              compactionCompleted = true;
              turnCompletedAfterCompaction = false;
              agentMessageAfterCompaction = false;
            } else if (compactionCompleted && codexAgentMessageText(parsed).trim()) agentMessageAfterCompaction = true;
            if (parsed.type === "turn.completed" && compactionCompleted) turnCompletedAfterCompaction = true;
            if (state.toolEnd && state.toolEnd !== "") toolWorkSinceAnswer = true;
            else if (codexAgentMessageText(parsed).trim()) toolWorkSinceAnswer = false;
          }
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
      if (
        !terminationRequested &&
        queuedPrompt !== null &&
        declaration?.steer?.strategy === "interrupt-resume" &&
        providerSessionId
      ) {
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
      if (
        !terminationRequested &&
        queuedPrompt === null &&
        declaration?.steer?.strategy === "interrupt-resume" &&
        providerSessionId &&
        compactionContinuations < maxCompactionContinuations &&
        compactionCompleted &&
        toolWorkSinceAnswer &&
        turnCompletedAfterCompaction &&
        !agentMessageAfterCompaction &&
        exitCode === 0
      ) {
        compactionContinuations += 1;
        args = [...declaration.steer.resumeArgs(baseArgs, providerSessionId)];
        prompt = compactionContinuationPrompt;
        activeTools.clear();
        interrupted = false;
        append({
          kind: "compaction_continued",
          providerSessionId,
          continuation: compactionContinuations,
          occurredAt: new Date().toISOString(),
        });
        continue;
      }
      finish(child.pid === undefined ? null : exitCode, signal);
      break;
    }
  } finally {
    steerTail.stop();
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

/** The message of a Codex `item.completed` error item, or "" for every other frame. Codex emits
 * its non-fatal warnings this way, so the item type alone never identifies one. */
function codexErrorItemMessage(value: Record<string, unknown>): string {
  const item = value.item as Record<string, unknown> | undefined;
  return value.type === "item.completed" && item?.type === "error" && typeof item.message === "string" && item.message
    ? item.message
    : "";
}

/** The assistant text of a Codex `item.completed` agent message, or "" for every other frame. */
function codexAgentMessageText(value: Record<string, unknown>): string {
  const item = value.item as Record<string, unknown> | undefined;
  return value.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string"
    ? item.text
    : "";
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
    (parsed.handshakeTimeoutMs !== undefined &&
      (typeof parsed.handshakeTimeoutMs !== "number" ||
        !Number.isSafeInteger(parsed.handshakeTimeoutMs) ||
        parsed.handshakeTimeoutMs <= 0)) ||
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
