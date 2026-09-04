import { consumeKnownError } from "../../kernel/src/index.ts";
import { runProcessText } from "./process-port.ts";

const loginShellSnapshotTimeoutMs = 4_000;

const sessionEnvironmentKeys = [
  // Keeps launchd's ssh-agent channel available when profiles do not recreate it.
  "SSH_AUTH_SOCK",
  // Keeps macOS per-user temporary files in their session-scoped directory.
  "TMPDIR",
  // Keeps home-relative tools working even when the shell does not export HOME.
  "HOME",
  // Keeps tools that identify the current account from losing the session user.
  "USER",
  // Keeps login-aware tools from falling back to an absent account name.
  "LOGNAME",
  // Keeps macOS terminal text encoding aligned with the logged-in user session.
  "__CF_USER_TEXT_ENCODING",
] as const;

const cachedPosixEnvironments = new Map<string, Readonly<Record<string, string>>>();

export function terminalEnvironment(
  platform: NodeJS.Platform,
  shell: string,
  capture: (shell: string) => Readonly<Record<string, string>> = captureLoginShellEnvironment,
): Readonly<Record<string, string>> {
  if (platform === "win32") return legacyTerminalEnvironment(platform);
  const cached = cachedPosixEnvironments.get(shell);
  if (cached) return cached;
  let environment: Readonly<Record<string, string>>;
  try {
    environment = Object.freeze({
      ...capture(shell),
      ...sessionEnvironment(),
      TERM: "xterm-256color",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[terminal-environment] login shell snapshot failed; using restricted environment: ${reason}`);
    consumeKnownError(error);
    // A failed snapshot is deliberately not cached. Caching it would pin the daemon to the
    // restricted environment for the rest of its life after one transient failure, which is
    // exactly the silent degradation this module exists to remove.
    return Object.freeze(legacyTerminalEnvironment(platform));
  }
  cachedPosixEnvironments.set(shell, environment);
  return environment;
}

export function captureLoginShellEnvironment(
  shell: string,
  run: typeof runProcessText = runProcessText,
): Readonly<Record<string, string>> {
  const output = run(
    "/usr/bin/env",
    ["-i", shell, "-l", "-i", "-c", "env -0"],
    undefined,
    {},
    loginShellSnapshotTimeoutMs,
  );
  const entries = output.split("\0").filter(Boolean);
  if (entries.length === 0) throw new Error("login shell returned an empty environment");
  return Object.fromEntries(
    entries.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) throw new Error("login shell returned an invalid environment entry");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

function sessionEnvironment(): Record<string, string> {
  return Object.fromEntries(
    sessionEnvironmentKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
  );
}

function legacyTerminalEnvironment(platform: NodeJS.Platform): Record<string, string> {
  const result: Record<string, string> = { TERM: "xterm-256color" },
    keys = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", ...(platform === "win32" ? ["SystemRoot"] : [])];
  for (const key of keys) if (process.env[key]) result[key] = process.env[key]!;
  return result;
}
