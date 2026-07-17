import { accessSync, chmodSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { IPty } from "node-pty";
import {
  createInMemoryTerminalSessionService,
  type CreateTerminalSessionPayload,
  type ReadTerminalSessionPayload,
  type ResizeTerminalSessionPayload,
  type TerminalOutputEvent,
  type TerminalOutputReadResult,
  type TerminalSessionDetailResult,
  type TerminalSessionIdPayload,
  type TerminalSessionInfo,
  type TerminalSessionListResult,
  type TerminalSessionService,
  type TerminateTerminalSessionPayload,
  type WriteTerminalSessionPayload
} from "./session-registry.ts";
import { createTerminalBackendNamespace, directPtyCapability, tmuxCapability } from "./backend-policy.ts";
import { loadTerminalSessionRegistry, saveTerminalSessionRegistry } from "./session-store.ts";

export interface PtySpawnOptions {
  readonly name: string;
  readonly columns: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export type PtySpawner = (shell: string, args: ReadonlyArray<string>, options: PtySpawnOptions) => IPty;

export interface TmuxController {
  readonly probe: () => { readonly available: boolean; readonly executable?: string; readonly version?: string; readonly reason?: string };
  readonly hasSession: (executable: string, namespace: string) => boolean;
  readonly killSession: (executable: string, namespace: string) => void;
}

export interface PtyTerminalSessionServiceOptions {
  readonly workspaceRoot: string;
  readonly spawnPty?: PtySpawner;
  readonly now?: () => string;
  readonly createId?: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly outputMaxBytes?: number;
  readonly defaultReadTimeoutMs?: number;
  readonly tmux?: TmuxController;
  readonly registryFilePath?: string;
}

interface OutputState {
  events: TerminalOutputEvent[];
  bytes: number;
  sequence: number;
  exitEmitted: boolean;
  waiters: Set<() => void>;
}

const defaultColumns = 80;
const defaultRows = 24;
const defaultOutputMaxBytes = 1_048_576;
const maxReadTimeoutMs = 1_000;

export function createPtyTerminalSessionService(options: PtyTerminalSessionServiceOptions): TerminalSessionService {
  const workspaceRoot = canonicalDirectory(options.workspaceRoot);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const outputMaxBytes = Math.max(1, options.outputMaxBytes ?? defaultOutputMaxBytes);
  const defaultReadTimeoutMs = options.defaultReadTimeoutMs ?? 250;
  const spawnPty = options.spawnPty ?? nodePtySpawner;
  const tmux = options.tmux ?? (options.spawnPty ? unavailableTmuxController : systemTmuxController);
  const tmuxProbe = tmux.probe();
  const tmuxAvailable = tmuxProbe.available && Boolean(tmuxProbe.executable);
  const registryFilePath = options.registryFilePath ?? path.join(workspaceRoot, ".harness", "generated", "terminal-sessions.json");
  const restoredSessions = loadTerminalSessionRegistry(registryFilePath).map((session) => restoreSession(session, tmux, tmuxProbe));
  const registry = createInMemoryTerminalSessionService({
    ...(options.now ? { now: options.now } : {}),
    ...(options.createId ? { createId: options.createId } : {}),
    defaultBackend: "tmux",
    backendCapabilities: [
      directPtyCapability(),
      tmuxCapability({
        available: tmuxAvailable,
        ...(tmuxProbe.version ? { version: tmuxProbe.version } : {}),
        ...(tmuxProbe.reason ? { reason: tmuxProbe.reason } : (!tmuxAvailable ? { reason: "tmux probe did not return an executable." } : {}))
      })
    ],
    initialSessions: restoredSessions,
    onChange: (sessions) => saveTerminalSessionRegistry(registryFilePath, sessions)
  });
  const processes = new Map<string, IPty>();
  const tmuxNamespaces = new Map<string, string>();
  const outputBySession = new Map<string, OutputState>();

  for (const session of restoredSessions) {
    if (session.backend === "tmux" && !ptySessionHasExited(session)) {
      tmuxNamespaces.set(session.sessionId, terminalNamespace(session));
      outputBySession.set(session.sessionId, createOutputState());
    }
  }

  if (!options.spawnPty) ensureNodePtySpawnHelperExecutable(platform);

  function createSession(payload: CreateTerminalSessionPayload): TerminalSessionDetailResult {
    let cwd: string;
    let shell: string;
    try {
      cwd = resolveTerminalCwd(workspaceRoot, payload.cwd);
      shell = resolveTerminalShell(payload.shell, env, platform);
    } catch (error) {
      return terminalFailure("terminal_spawn_context_invalid", error instanceof Error ? error.message : String(error));
    }

    const created = registry.createSession({ ...payload, cwd, shell });
    if (!created.ok) return created;
    const sessionId = created.session.sessionId;
    const output = createOutputState();
    outputBySession.set(sessionId, output);

    try {
      const namespace = terminalNamespace(created.session);
      const useTmux = created.session.backend === "tmux";
      if (useTmux) tmuxNamespaces.set(sessionId, namespace);
      const pty = spawnPty(
        useTmux ? String(tmuxProbe.executable) : shell,
        useTmux ? ["new-session", "-A", "-s", namespace, "-c", cwd, shell] : [],
        {
        name: "xterm-256color",
        columns: defaultColumns,
        rows: defaultRows,
        cwd,
        env: terminalEnvironment(env, cwd)
        }
      );
      registerPty(sessionId, pty, output);
      return created;
    } catch (error) {
      outputBySession.delete(sessionId);
      registry.markSessionExited({ sessionId, exitCode: 1 });
      return terminalFailure("terminal_spawn_failed", `Unable to spawn terminal shell: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function writeSession(payload: WriteTerminalSessionPayload): TerminalSessionDetailResult {
    const updated = registry.writeSession(payload);
    if (!updated.ok) return updated;
    const pty = processes.get(payload.sessionId);
    if (!pty) return terminalFailure("terminal_process_unavailable", "The terminal process is no longer available.");
    try {
      pty.write(payload.data);
      return updated;
    } catch (error) {
      return terminalFailure("terminal_write_failed", error instanceof Error ? error.message : String(error));
    }
  }

  async function readSession(payload: ReadTerminalSessionPayload): Promise<TerminalOutputReadResult> {
    const session = registry.getSession(payload);
    if (!session.ok) return session;
    const cursor = validCursor(payload.cursor);
    const state = outputBySession.get(payload.sessionId);
    if (!state) return terminalFailure("terminal_output_unavailable", "Terminal output is no longer available.");

    let result = outputResult(session.session, state, cursor);
    const timeoutMs = validReadTimeout(payload.timeoutMs, defaultReadTimeoutMs);
    if (result.events.length > 0 || ptySessionHasExited(session.session) || timeoutMs === 0) return result;

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.waiters.delete(settle);
        resolve();
      };
      const timer = setTimeout(settle, timeoutMs);
      state.waiters.add(settle);
    });

    const latest = registry.getSession(payload);
    if (!latest.ok) return latest;
    result = outputResult(latest.session, state, cursor);
    return result;
  }

  function resizeSession(payload: ResizeTerminalSessionPayload): TerminalSessionDetailResult {
    const updated = registry.resizeSession(payload);
    if (!updated.ok) return updated;
    const pty = processes.get(payload.sessionId);
    if (!pty) return terminalFailure("terminal_process_unavailable", "The terminal process is no longer available.");
    try {
      pty.resize(payload.columns, payload.rows);
      return updated;
    } catch (error) {
      return terminalFailure("terminal_resize_failed", error instanceof Error ? error.message : String(error));
    }
  }

  function closeSession(payload: TerminalSessionIdPayload): TerminalSessionDetailResult {
    const current = registry.getSession(payload);
    if (!current.ok || ptySessionHasExited(current.session)) return current;
    terminateBackend(payload.sessionId);
    const pty = processes.get(payload.sessionId);
    try {
      pty?.kill();
    } catch {
      // The process may have exited between the metadata read and kill.
    }
    return finalizeExit(payload.sessionId, 0);
  }

  function detachSession(payload: TerminalSessionIdPayload): TerminalSessionDetailResult {
    return registry.detachSession(payload);
  }

  function attachSession(payload: TerminalSessionIdPayload) {
    const current = registry.getSession(payload);
    if (!current.ok || ptySessionHasExited(current.session) || processes.has(payload.sessionId)) {
      return current.ok ? registry.attachSession(payload) : current;
    }
    const namespace = tmuxNamespaces.get(payload.sessionId);
    if (current.session.backend !== "tmux" || !namespace || !tmuxProbe.executable) return registry.attachSession(payload);
    if (!tmux.hasSession(tmuxProbe.executable, namespace)) {
      return terminalFailure("terminal_process_unavailable", "The tmux session is no longer available.");
    }
    const output = outputBySession.get(payload.sessionId) ?? createOutputState();
    outputBySession.set(payload.sessionId, output);
    try {
      const pty = spawnPty(tmuxProbe.executable, ["attach-session", "-t", namespace], {
        name: "xterm-256color",
        columns: defaultColumns,
        rows: defaultRows,
        cwd: current.session.cwd ?? workspaceRoot,
        env: terminalEnvironment(env, current.session.cwd ?? workspaceRoot)
      });
      registerPty(payload.sessionId, pty, output);
      return registry.attachSession(payload);
    } catch (error) {
      return terminalFailure("terminal_attach_failed", error instanceof Error ? error.message : String(error));
    }
  }

  function terminateSession(payload: TerminateTerminalSessionPayload): TerminalSessionDetailResult {
    if (payload.confirmation !== "terminate-terminal-session") return registry.terminateSession(payload);
    const current = registry.getSession(payload);
    if (!current.ok || ptySessionHasExited(current.session)) return current;
    terminateBackend(payload.sessionId);
    try {
      processes.get(payload.sessionId)?.kill();
    } catch {
      // The terminal client may have exited while the explicit terminate was being handled.
    }
    return registry.terminateSession(payload);
  }

  function terminateBackend(sessionId: string): void {
    const namespace = tmuxNamespaces.get(sessionId);
    if (!namespace || !tmuxProbe.executable) return;
    try {
      tmux.killSession(tmuxProbe.executable, namespace);
    } catch {
      // The tmux session may already have exited.
    }
    tmuxNamespaces.delete(sessionId);
  }

  function registerPty(sessionId: string, pty: IPty, output: OutputState): void {
    processes.set(sessionId, pty);
    pty.onData((data) => appendOutput(sessionId, { kind: "data", sequence: nextSequence(output), data }));
    pty.onExit(({ exitCode, signal }) => {
      const namespace = tmuxNamespaces.get(sessionId);
      if (namespace && tmuxProbe.executable && tmux.hasSession(tmuxProbe.executable, namespace)) {
        processes.delete(sessionId);
        registry.detachSession({ sessionId });
        return;
      }
      finalizeExit(sessionId, exitCode, signal);
    });
  }

  function finalizeExit(sessionId: string, exitCode: number, signal?: number): TerminalSessionDetailResult {
    const state = outputBySession.get(sessionId);
    processes.delete(sessionId);
    const exited = registry.markSessionExited({ sessionId, exitCode });
    if (state && !state.exitEmitted) {
      state.exitEmitted = true;
      appendOutput(sessionId, {
        kind: "exit",
        sequence: nextSequence(state),
        exitCode,
        ...(signal === undefined ? {} : { signal })
      });
    }
    return exited;
  }

  function appendOutput(sessionId: string, event: TerminalOutputEvent): void {
    const state = outputBySession.get(sessionId);
    if (!state) return;
    if (event.kind === "data" && Buffer.byteLength(event.data, "utf8") > outputMaxBytes) {
      event = { ...event, data: Buffer.from(event.data, "utf8").subarray(-outputMaxBytes).toString("utf8") };
    }
    state.events.push(event);
    if (event.kind === "data") state.bytes += Buffer.byteLength(event.data, "utf8");
    while (state.bytes > outputMaxBytes && state.events.length > 1) {
      const removed = state.events.shift();
      if (removed?.kind === "data") state.bytes -= Buffer.byteLength(removed.data, "utf8");
    }
    for (const waiter of [...state.waiters]) waiter();
  }

  return {
    createSession,
    listSessions: (): TerminalSessionListResult => registry.listSessions(),
    getSession: (payload) => registry.getSession(payload),
    attachSession,
    detachSession,
    terminateSession,
    writeSession,
    readSession,
    resizeSession,
    closeSession
  };
}

const systemTmuxController: TmuxController = {
  probe: () => {
    const result = spawnSync("tmux", ["-V"], { encoding: "utf8", windowsHide: true });
    const probeFailed = result.status !== 0;
    if (probeFailed) {
      return { available: false, reason: "tmux is unavailable; direct-pty sessions will not survive daemon restart." };
    }
    return { available: true, executable: "tmux", version: result.stdout.trim() };
  },
  hasSession: (executable, namespace) => spawnSync(executable, ["has-session", "-t", namespace], { windowsHide: true }).status === 0,
  killSession: (executable, namespace) => {
    const result = spawnSync(executable, ["kill-session", "-t", namespace], { windowsHide: true });
    const killFailed = result.status !== 0;
    if (killFailed) throw new Error("tmux session is unavailable");
  }
};

const unavailableTmuxController: TmuxController = {
  probe: () => ({ available: false, reason: "tmux probe was not provided by the injected PTY host." }),
  hasSession: () => false,
  killSession: () => undefined
};

function restoreSession(
  session: TerminalSessionInfo,
  tmux: TmuxController,
  probe: ReturnType<TmuxController["probe"]>
): TerminalSessionInfo {
  if (ptySessionHasExited(session)) return session;
  if (session.backend !== "tmux" || !probe.available || !probe.executable) {
    return { ...session, status: "unknown", attachable: false };
  }
  const namespace = terminalNamespace(session);
  return tmux.hasSession(probe.executable, namespace)
    ? { ...session, status: "idle", attachable: true }
    : { ...session, status: "exited", attachable: false };
}

function ptySessionHasExited(session: TerminalSessionInfo): boolean {
  return session.status === "exited";
}

function terminalNamespace(session: Pick<TerminalSessionInfo, "sessionId" | "hostProfileId" | "projectId" | "taskId" | "cwd">): string {
  return createTerminalBackendNamespace(session).namespace;
}

export function resolveTerminalCwd(workspaceRoot: string, requestedCwd?: string): string {
  const canonicalRoot = canonicalDirectory(workspaceRoot);
  const candidate = requestedCwd
    ? path.resolve(canonicalRoot, requestedCwd)
    : canonicalRoot;
  const canonicalCandidate = canonicalDirectory(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Terminal cwd must be the project root or a directory inside it.");
  }
  return canonicalCandidate;
}

export function resolveTerminalShell(
  requestedShell: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const candidates = platform === "win32"
    ? [requestedShell, env.ComSpec, env.COMSPEC, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]
    : [requestedShell, env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next platform shell candidate.
    }
  }
  throw new Error("No executable terminal shell was found.");
}

function nodePtySpawner(shell: string, args: ReadonlyArray<string>, options: PtySpawnOptions): IPty {
  // Lazy-load node-pty so merely importing this module (e.g. the packaged CLI's
  // `gui` command) does not require the native dependency; it is only needed
  // when a terminal is actually spawned (daemon runtime).
  const { spawn: spawnNodePty } = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
  return spawnNodePty(shell, [...args], {
    name: options.name,
    cols: options.columns,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env
  });
}

function terminalEnvironment(source: NodeJS.ProcessEnv, cwd: string): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PWD: cwd
  };
}

function canonicalDirectory(value: string): string {
  const canonical = realpathSync(path.resolve(value));
  if (!statSync(canonical).isDirectory()) throw new Error(`Terminal cwd is not a directory: ${value}`);
  return canonical;
}

function createOutputState(): OutputState {
  return { events: [], bytes: 0, sequence: 0, exitEmitted: false, waiters: new Set() };
}

function nextSequence(state: OutputState): number {
  state.sequence += 1;
  return state.sequence;
}

function outputResult(session: TerminalSessionInfo, state: OutputState, cursor: number): TerminalOutputReadResult & { readonly ok: true } {
  const events = state.events.filter((event) => event.sequence > cursor);
  const oldestSequence = state.events[0]?.sequence ?? state.sequence + 1;
  return {
    ok: true,
    session,
    events,
    nextCursor: events.at(-1)?.sequence ?? cursor,
    dropped: cursor < oldestSequence - 1
  };
}

function validCursor(cursor: number | undefined): number {
  return Number.isInteger(cursor) && Number(cursor) >= 0 ? Number(cursor) : 0;
}

function validReadTimeout(timeoutMs: number | undefined, fallback: number): number {
  if (timeoutMs === undefined) return Math.min(Math.max(0, fallback), maxReadTimeoutMs);
  if (!Number.isInteger(timeoutMs)) return 0;
  return Math.min(Math.max(0, timeoutMs), maxReadTimeoutMs);
}

function ensureNodePtySpawnHelperExecutable(platform: NodeJS.Platform): void {
  if (platform === "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
    const helper = path.join(packageRoot, "prebuilds", `${platform}-${process.arch}`, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch {
    // node-pty will return its native spawn error through createSession.
  }
}

function terminalFailure(code: string, hint: string): TerminalSessionDetailResult & { readonly ok: false } {
  return { ok: false, error: { code, hint } };
}
