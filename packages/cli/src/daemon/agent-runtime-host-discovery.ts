import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AgentRuntimeDiscoveryProbe,
  AgentRuntimeInventoryProjection,
  RuntimeExecutableCandidate
} from "../../../application/src/index.ts";
import { makeAgentRuntimeService } from "../../../application/src/index.ts";
import type { RuntimeKind } from "../../../kernel/src/index.ts";

export interface LocalAgentRuntimeDiscoveryOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly shell?: string;
  readonly loginShellTimeoutMs?: number;
}

export function createLocalAgentRuntimeDiscoveryProbe(
  options: LocalAgentRuntimeDiscoveryOptions = {}
): AgentRuntimeDiscoveryProbe {
  const env = options.env ?? process.env;
  return {
    environmentOverride: async (kind) => candidate(kind, env[kind.environmentOverride], "environment-override"),
    path: async (kind) => findOnPath(kind, env.PATH),
    loginShell: async (kinds) => findWithLoginShell(
      kinds,
      options.shell ?? env.SHELL ?? "/bin/zsh",
      options.loginShellTimeoutMs ?? 1_250,
      env
    ),
    appBundle: async (kind) => firstCandidate(kind, kind.appBundleCandidates, "app-bundle"),
    verify: async (entry) => ({ executable: await isExecutable(entry.executablePath) })
  };
}

export function createLocalAgentRuntimeInventoryReader(): () => Promise<AgentRuntimeInventoryProjection> {
  return createLocalAgentRuntimeService().inventoryProjection;
}

export function createLocalAgentRuntimeService(options: LocalAgentRuntimeDiscoveryOptions = {}) {
  return makeAgentRuntimeService({
    discovery: createLocalAgentRuntimeDiscoveryProbe(options)
  });
}

async function findOnPath(kind: RuntimeKind, pathValue: string | undefined): Promise<RuntimeExecutableCandidate | undefined> {
  if (!pathValue) return undefined;
  const candidates = pathValue.split(path.delimiter).flatMap((directory) =>
    kind.executableNames.map((name) => path.join(directory, name))
  );
  return firstCandidate(kind, candidates, "path");
}

async function firstCandidate(
  kind: RuntimeKind,
  paths: ReadonlyArray<string>,
  source: RuntimeExecutableCandidate["source"]
): Promise<RuntimeExecutableCandidate | undefined> {
  for (const executablePath of paths) {
    if (await isExecutable(executablePath)) return candidate(kind, executablePath, source);
  }
  return undefined;
}

async function findWithLoginShell(
  kinds: ReadonlyArray<RuntimeKind>,
  shell: string,
  timeoutMs: number,
  env: Readonly<Record<string, string | undefined>>
): Promise<ReadonlyArray<RuntimeExecutableCandidate>> {
  if (!path.isAbsolute(shell)) return [];
  const commands = kinds.map((kind) => {
    const executable = kind.executableNames[0];
    return executable ? `printf '%s\\t%s\\n' ${shellQuote(kind.kindId)} "$(command -v ${shellQuote(executable)} 2>/dev/null)"` : "";
  }).filter(Boolean).join("; ");
  if (!commands) return [];
  const stdout = await executeLoginShell(shell, commands, timeoutMs, env);
  const byKind = new Map(kinds.map((kind) => [kind.kindId, kind]));
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const separator = line.indexOf("\t");
    if (separator < 1) return [];
    const kind = byKind.get(line.slice(0, separator));
    const executablePath = line.slice(separator + 1).trim();
    return kind && path.isAbsolute(executablePath)
      ? [{ kindId: kind.kindId, executablePath, source: "login-shell" as const }]
      : [];
  });
}

function executeLoginShell(
  shell: string,
  command: string,
  timeoutMs: number,
  env: Readonly<Record<string, string | undefined>>
): Promise<string> {
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", command], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      env: { ...env }
    }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

async function isExecutable(executablePath: string): Promise<boolean> {
  if (!path.isAbsolute(executablePath)) return false;
  try {
    const resolved = await realpath(executablePath);
    await access(resolved, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidate(
  kind: RuntimeKind,
  executablePath: string | undefined,
  source: RuntimeExecutableCandidate["source"]
): RuntimeExecutableCandidate | undefined {
  return executablePath && path.isAbsolute(executablePath)
    ? { kindId: kind.kindId, executablePath, source }
    : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
