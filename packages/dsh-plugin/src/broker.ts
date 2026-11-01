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
  /** Map the Client's selected Workspace (if any) to the root `ha gui` serves. */
  readonly resolveWorkspace: (requested: string | undefined) => Promise<string>;
  readonly getParentOrigin: () => string;
}

interface ActiveBroker {
  readonly requested: string | undefined;
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

/** JSON objects among the CLI's output lines; progress lines may precede a receipt. */
function jsonLines(text: string): readonly Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const start = line.indexOf("{");
    if (start === -1) continue;
    try {
      const value: unknown = JSON.parse(line.slice(start));
      if (value && typeof value === "object") records.push(value as Record<string, unknown>);
    } catch (error) {
      consumeKnownError(error);
    }
  }
  return records;
}

function jsonReceipt(text: string): BrokerResponse | undefined {
  for (const record of jsonLines(text)) {
    if (record.ok === true && typeof record.url === "string" && record.url.length > 0) {
      return {
        ok: true,
        url: record.url,
        ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
      };
    }
    const error = errorReceipt(record);
    if (error !== undefined) return error;
  }
  return undefined;
}

function failure(code: string, hint: string): BrokerFailure {
  return { ok: false, error: { code, hint } };
}

/** Spawn `ha`; a spawn error becomes an exited child whose stderr carries the reason. */
function spawnCli(subprocess: BrokerSubprocessRuntime, argv: readonly string[], cwd: string): BrokerSubprocessHandle {
  try {
    return subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      graceMs: BROKER_GRACE_MS,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      stderr: {
        on: (event, listener) => {
          if (event === "data") listener(reason);
        },
      },
      done: Promise.resolve({ exitCode: null, signal: null }),
      terminate() {},
    };
  }
}

function launchBroker(
  subprocess: BrokerSubprocessRuntime,
  workspace: string,
  executable: string,
  parentOrigin: string,
  onSpawn: (handle: BrokerSubprocessHandle) => void,
): Promise<{ readonly response: BrokerResponse; readonly handle: BrokerSubprocessHandle }> {
  const handle = spawnCli(
    subprocess,
    [executable, "gui", "--browser", "--parent-origin", parentOrigin, "--root", workspace, "--json"],
    workspace,
  );
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

export interface RegisteredRepo {
  readonly rootDir: string;
}

function registeredRepos(text: string): readonly RegisteredRepo[] {
  const record = jsonLines(text).find((value) => Array.isArray(value.repos));
  if (record === undefined) return [];
  const rows = (record.repos as readonly unknown[]).filter(
    (row): row is { rootDir: string; state?: unknown; materialization?: { lastCheckpointAt?: unknown } } =>
      !!row && typeof row === "object" && typeof (row as { rootDir?: unknown }).rootDir === "string",
  );
  const checkpoint = (row: (typeof rows)[number]): string =>
    typeof row.materialization?.lastCheckpointAt === "string" ? row.materialization.lastCheckpointAt : "";
  // Attached repositories first, then the most recently written ledger.
  return rows
    .sort(
      (left, right) =>
        Number(right.state === "attached") - Number(left.state === "attached") ||
        checkpoint(right).localeCompare(checkpoint(left)),
    )
    .map((row) => ({ rootDir: row.rootDir }));
}

/** Repositories the local daemon serves, ordered by recency; none when the daemon cannot answer. */
export function readRegisteredRepos(
  subprocess: BrokerSubprocessRuntime,
  executable: string,
  cwd: string,
): Promise<readonly RegisteredRepo[]> {
  const handle = spawnCli(subprocess, [executable, "daemon", "status", "--json"], cwd);
  let stdout = "";
  handle.stdout?.on("data", (value: unknown) => {
    stdout = `${stdout}${textChunk(value)}`.slice(-OUTPUT_LIMIT_BYTES);
  });
  // An unreachable daemon serves no repository; the board then shows `ha gui`'s own guidance.
  return handle.done.then(
    () => registeredRepos(stdout),
    () => [],
  );
}

/**
 * Pick the root the board serves: the selected Workspace, then any DSH
 * Workspace, when the daemon serves it; otherwise the daemon's most recent
 * repository; with none registered, the selected Workspace shows `ha gui`'s
 * own guidance.
 */
export function chooseWorkspace(input: {
  readonly requested: string | undefined;
  readonly workspaces: readonly string[];
  readonly repos: readonly RegisteredRepo[];
  readonly separator: string;
  readonly fallback: string;
}): string {
  const selected =
    input.requested !== undefined && input.workspaces.includes(input.requested) ? input.requested : undefined;
  const served = (dir: string): boolean =>
    input.repos.some((repo) => dir === repo.rootDir || dir.startsWith(`${repo.rootDir}${input.separator}`));
  return (
    [selected, ...input.workspaces].find((dir): dir is string => dir !== undefined && served(dir)) ??
    input.repos[0]?.rootDir ??
    selected ??
    input.workspaces[0] ??
    input.fallback
  );
}

export interface BrokerManager {
  ensure(requested?: string): Promise<BrokerResponse>;
  dispose(): Promise<void>;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

/** Own the one long-lived `ha gui --browser` child and restart it on Workspace changes. */
export function createBrokerManager(subprocess: BrokerSubprocessRuntime, options: BrokerManagerOptions): BrokerManager {
  const executable = options.executable ?? "ha";
  let active: ActiveBroker | undefined;
  let pending: Promise<BrokerResponse> | undefined;
  let pendingRequested: string | undefined;
  let pendingWorkspace: string | undefined;
  let pendingHandle: BrokerSubprocessHandle | undefined;
  let generation = 0;

  const stop = (): void => {
    const current = active;
    active = undefined;
    pending = undefined;
    pendingRequested = undefined;
    pendingWorkspace = undefined;
    const starting = pendingHandle;
    pendingHandle = undefined;
    generation += 1;
    current?.handle.terminate();
    starting?.terminate();
  };

  const ensure = async (requested?: string): Promise<BrokerResponse> => {
    if (active !== undefined && active.requested === requested) return { ok: true, url: active.url };
    if (pending !== undefined && pendingRequested === requested) return pending;
    const workspace = await options.resolveWorkspace(requested);
    if (active?.workspace === workspace) {
      active = { ...active, requested };
      return { ok: true, url: active.url };
    }
    if (pending !== undefined && pendingWorkspace === workspace) return pending;
    stop();
    pendingRequested = requested;
    pendingWorkspace = workspace;
    const requestGeneration = generation;
    const request = launchBroker(subprocess, workspace, executable, options.getParentOrigin(), (handle) => {
      pendingHandle = handle;
    }).then(({ response, handle }) => {
      if (requestGeneration === generation) {
        pending = undefined;
        pendingRequested = undefined;
        pendingWorkspace = undefined;
      }
      if (pendingHandle === handle) pendingHandle = undefined;
      if (requestGeneration !== generation) {
        handle.terminate();
        return failure("broker_superseded", "The workspace changed or the plugin stopped. Open Harness again.");
      }
      if (response.ok) {
        active = { requested, workspace, url: response.url, handle };
        const clearExitedBroker = (): void => {
          if (active?.handle === handle) active = undefined;
        };
        void handle.done.then(clearExitedBroker, clearExitedBroker);
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
      const requested = new URL(request.url ?? "/", "http://host").searchParams.get("workspace") ?? undefined;
      const result = await ensure(requested);
      response.statusCode = result.ok ? 200 : 503;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    },
  };
}
