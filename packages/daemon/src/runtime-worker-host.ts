import { spawn } from "node:child_process";
import { consumeKnownError } from "@harness-anything/kernel";
import { dispatchStreamPath, openDispatchStreamAppender, scrubProviderValue } from "./dispatch-stream.ts";
import { createRuntimeCallbackRelay } from "./runtime-callback-relay.ts";
import { runAcpProviderSession } from "./runtime-worker-acp.ts";
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
  const manifest = parseManifest(await readStandardInput());
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
  let child: ReturnType<typeof spawn> | undefined;
  let settled = false;
  try {
    await relay?.start();
    // This host owns the provider's lifetime. WINDSURF_EXT_HOST_PID comes from the editor terminal that started
    // the daemon, and devin's ACP server exits 0 as soon as that editor process is gone.
    const { WINDSURF_EXT_HOST_PID: _editorHostPid, ...hostEnvironment } = manifest.env,
      // The callback route is provenance, not authority. The CLI still needs its registry namespace.
      providerEnv = runtimeWorkerProviderEnvironment(
        relay ? { ...hostEnvironment, HARNESS_DAEMON_ENDPOINT: relay.endpoint } : hostEnvironment,
      );
    child = spawn(manifest.executablePath, [...manifest.args], {
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
      for (const line of lines) if (line.trim()) appendProviderLine(append, line);
      if (flush && trailing.trim()) appendProviderLine(append, trailing);
    };
    if (!acp) {
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => consumeOutput(chunk));
    }
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (!acp) consumeOutput("", true);
      append({ kind: "process_exit", exitCode, signal });
    };
    child.once("error", (error) => {
      append({ kind: "provider_stderr", chunk: scrubProviderValue(error.message) as string });
    });
    process.once("SIGTERM", () => {
      if (!settled) {
        if (acp) acp.cancel();
        else child?.kill("SIGTERM");
      }
    });
    if (!acp) child.stdin!.end(manifest.prompt);
    const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child!.once("close", (code: number | null, closeSignal: NodeJS.Signals | null) => resolve([code, closeSignal])),
    );
    // The daemon stops reading at process_exit, so the ACP session's last frame must land first.
    await acp?.done;
    finish(child.pid === undefined ? null : exitCode, signal);
  } finally {
    appender.close();
    await relay?.stop();
  }
}

function appendProviderLine(append: (value: Readonly<Record<string, unknown>>) => void, line: string): void {
  try {
    append({ kind: "provider_event", event: scrubProviderValue(JSON.parse(line)) });
  } catch (error) {
    consumeKnownError(error);
    append({ kind: "provider_output_invalid", output: scrubProviderValue(line) });
  }
}

async function readStandardInput(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  return value;
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
