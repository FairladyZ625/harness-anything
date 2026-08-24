import { spawn } from "node:child_process";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { appendRuntimeWorkerRecord, scrubProviderValue } from "./dispatch-stream.ts";

type RuntimeWorkerManifest = {
  readonly rootDir: string;
  readonly dispatchId: string;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly windowsVerbatimArguments: boolean;
};

async function runRuntimeWorkerHost(): Promise<void> {
  const manifest = parseManifest(await readStandardInput());
  const append = (value: Readonly<Record<string, unknown>>): void => appendRuntimeWorkerRecord(
    manifest.rootDir,
    manifest.dispatchId,
    { occurredAt: new Date().toISOString(), ...value },
  );
  const child = spawn(manifest.executablePath, [...manifest.args], {
    cwd: manifest.cwd,
    env: manifest.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(manifest.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  let outputBuffer = "";
  let settled = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const consumeOutput = (chunk: string, flush = false): void => {
    outputBuffer += chunk;
    const lines = outputBuffer.split(/\r?\n/u);
    const trailing = lines.pop() ?? "";
    outputBuffer = flush ? "" : trailing;
    for (const line of lines) if (line.trim()) appendProviderLine(append, line);
    if (flush && trailing.trim()) appendProviderLine(append, trailing);
  };
  child.stdout.on("data", (chunk: string) => consumeOutput(chunk));
  child.stderr.on("data", (chunk: string) => append({
    kind: "provider_stderr",
    chunk: scrubProviderValue(chunk) as string,
  }));
  const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    consumeOutput("", true);
    append({ kind: "process_exit", exitCode, signal });
  };
  child.once("error", (error) => {
    append({ kind: "provider_stderr", chunk: scrubProviderValue(error.message) as string });
    finish(null, null);
  });
  child.once("close", finish);
  process.once("SIGTERM", () => { if (!settled) child.kill("SIGTERM"); });
  child.stdin.end(manifest.prompt);
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function appendProviderLine(
  append: (value: Readonly<Record<string, unknown>>) => void,
  line: string,
): void {
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
    !isRuntimeWorkerRecord(parsed)
    || typeof parsed.rootDir !== "string"
    || typeof parsed.dispatchId !== "string"
    || typeof parsed.executablePath !== "string"
    || !Array.isArray(parsed.args)
    || !parsed.args.every((arg) => typeof arg === "string")
    || typeof parsed.cwd !== "string"
    || !isRuntimeWorkerRecord(parsed.env)
    || typeof parsed.prompt !== "string"
    || typeof parsed.windowsVerbatimArguments !== "boolean"
  ) throw new Error("runtime worker manifest is invalid");
  return parsed as RuntimeWorkerManifest;
}
function isRuntimeWorkerRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (process.argv[2] === "--runtime-worker-host") {
  void runRuntimeWorkerHost().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
