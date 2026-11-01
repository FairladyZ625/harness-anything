import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrokerFailure, BrokerResponse } from "./shared.ts";

export { BROKER_ROUTE } from "./shared.ts";
export type { BrokerFailure, BrokerResponse, BrokerSuccess } from "./shared.ts";

const OUTPUT_LIMIT_BYTES = 1_000_000;
const BROKER_GRACE_MS = 5_000;

interface BrokerStream {
  on(event: "data" | "end" | "error", listener: (...args: readonly unknown[]) => void): unknown;
}

export interface BrokerSubprocessHandle {
  readonly stdout?: BrokerStream;
  readonly stderr?: BrokerStream;
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
  terminate(): void;
}

export interface BrokerSubprocessRuntime {
  spawn(spec: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly stdio: {
      readonly stdin: "ignore";
      readonly stdout: "pipe";
      readonly stderr: "pipe";
    };
    readonly graceMs: number;
  }): BrokerSubprocessHandle;
}

export interface BrokerManagerOptions {
  readonly executable?: string;
  readonly getWorkspace: () => string;
}

interface ActiveBroker {
  readonly workspace: string;
  readonly url: string;
  readonly handle: BrokerSubprocessHandle;
}

function textChunk(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}

function consumeKnownError(error: unknown): void {
  if (!(error instanceof SyntaxError)) throw error;
}

function errorReceipt(record: Record<string, unknown>): BrokerFailure | undefined {
  if (record.ok !== false) return undefined;
  const nested =
    record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : undefined;
  const code =
    typeof nested?.code === "string" ? nested.code : typeof record.code === "string" ? record.code : undefined;
  if (code === undefined) return undefined;
  const diagnostic =
    record.diagnostic && typeof record.diagnostic === "object"
      ? (record.diagnostic as Record<string, unknown>)
      : undefined;
  const hint =
    typeof nested?.hint === "string"
      ? nested.hint
      : typeof record.hint === "string"
        ? record.hint
        : typeof diagnostic?.expectation === "string"
          ? diagnostic.expectation
          : `ha gui rejected with code ${code}`;
  return failure(code, hint);
}

function jsonReceipt(text: string): BrokerResponse | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const start = line.indexOf("{");
    if (start === -1) continue;
    try {
      const value: unknown = JSON.parse(line.slice(start));
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (record.ok === true && typeof record.url === "string" && record.url.length > 0) {
        return {
          ok: true,
          url: record.url,
          ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
        };
      }
      const error = errorReceipt(record);
      if (error !== undefined) return error;
    } catch (error) {
      consumeKnownError(error);
      // The CLI may write a progress line before its one JSON receipt.
    }
  }
  return undefined;
}

function failure(code: string, hint: string): BrokerFailure {
  return { ok: false, error: { code, hint } };
}

function launchBroker(
  subprocess: BrokerSubprocessRuntime,
  workspace: string,
  executable: string,
  onSpawn: (handle: BrokerSubprocessHandle) => void,
): Promise<{ readonly response: BrokerResponse; readonly handle: BrokerSubprocessHandle }> {
  let handle: BrokerSubprocessHandle;
  try {
    handle = subprocess.spawn({
      argv: [executable, "gui", "--browser", "--root", workspace, "--json"],
      cwd: workspace,
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      graceMs: BROKER_GRACE_MS,
    });
  } catch (error) {
    return Promise.resolve({
      response: failure("ha_unavailable", error instanceof Error ? error.message : String(error)),
      handle: { done: Promise.resolve({ exitCode: null, signal: null }), terminate() {} },
    });
  }
  onSpawn(handle);

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const settle = (response: BrokerResponse): void => {
      if (settled) return;
      settled = true;
      resolve({ response, handle });
    };
    const consume =
      (target: "stdout" | "stderr") =>
      (value: unknown): void => {
        const chunk = textChunk(value);
        if (target === "stdout") stdout = `${stdout}${chunk}`.slice(-OUTPUT_LIMIT_BYTES);
        else stderr = `${stderr}${chunk}`.slice(-OUTPUT_LIMIT_BYTES);
        const response = jsonReceipt(stdout);
        if (response !== undefined) settle(response);
      };
    handle.stdout?.on("data", consume("stdout"));
    handle.stderr?.on("data", consume("stderr"));
    void handle.done.then(
      (outcome) => {
        if (settled) return;
        const response = jsonReceipt(stdout);
        if (response !== undefined) {
          settle(response);
          return;
        }
        const hint =
          stderr.trim() || stdout.trim() || `ha gui exited with code ${String(outcome.exitCode ?? "unknown")}`;
        settle(failure(outcome.exitCode === null ? "ha_unavailable" : "gui_launch_failed", hint));
      },
      (error: unknown) => {
        settle(failure("ha_unavailable", error instanceof Error ? error.message : String(error)));
      },
    );
  });
}

export interface BrokerManager {
  ensure(): Promise<BrokerResponse>;
  dispose(): Promise<void>;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

/** Own the one long-lived `ha gui --browser` child and restart it on Workspace changes. */
export function createBrokerManager(subprocess: BrokerSubprocessRuntime, options: BrokerManagerOptions): BrokerManager {
  const executable = options.executable ?? "ha";
  let active: ActiveBroker | undefined;
  let pending: Promise<BrokerResponse> | undefined;
  let pendingWorkspace: string | undefined;
  let pendingHandle: BrokerSubprocessHandle | undefined;
  let generation = 0;

  const stop = (): void => {
    const current = active;
    active = undefined;
    pending = undefined;
    pendingWorkspace = undefined;
    const starting = pendingHandle;
    pendingHandle = undefined;
    generation += 1;
    current?.handle.terminate();
    starting?.terminate();
  };

  const ensure = async (): Promise<BrokerResponse> => {
    const workspace = options.getWorkspace();
    if (active?.workspace === workspace) return { ok: true, url: active.url };
    if (pending !== undefined && pendingWorkspace === workspace) return pending;
    stop();
    pendingWorkspace = workspace;
    const requestGeneration = generation;
    const request = launchBroker(subprocess, workspace, executable, (handle) => {
      pendingHandle = handle;
    }).then(async ({ response, handle }) => {
      if (pendingHandle === handle) pendingHandle = undefined;
      if (requestGeneration !== generation || options.getWorkspace() !== workspace) {
        handle.terminate();
        return response;
      }
      if (response.ok) {
        active = { workspace, url: response.url, handle };
      } else {
        handle.terminate();
      }
      return response;
    });
    pending = request;
    return request;
  };

  return {
    ensure,
    dispose: async () => {
      stop();
    },
    async handle(request, response) {
      if (request.method !== "GET") {
        response.statusCode = 405;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(failure("method_not_allowed", "Use GET for the Harness Anything broker route.")));
        return;
      }
      const result = await ensure();
      response.statusCode = result.ok ? 200 : 503;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    },
  };
}
