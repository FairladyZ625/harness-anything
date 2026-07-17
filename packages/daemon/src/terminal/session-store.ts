import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TerminalSessionInfo } from "../../../application/src/terminal-session-contract.ts";

const schema = "terminal-session-registry/v1" as const;

export function loadTerminalSessionRegistry(filePath: string): ReadonlyArray<TerminalSessionInfo> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isTerminalStoreRecord(parsed) || parsed.schema !== schema || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.flatMap((session) => {
      const projected = readTerminalSessionInfo(session);
      return projected ? [projected] : [];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}

export function saveTerminalSessionRegistry(filePath: string, sessions: ReadonlyArray<TerminalSessionInfo>): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.terminal-sessions.${process.pid}.${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ schema, sessions }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
}

function readTerminalSessionInfo(value: unknown): TerminalSessionInfo | undefined {
  if (!isTerminalStoreRecord(value)
    || typeof value.sessionId !== "string"
    || typeof value.name !== "string"
    || !["direct-pty", "tmux", "remote"].includes(String(value.backend))
    || !["none", "daemon-restart", "remote-owned"].includes(String(value.durability))
    || typeof value.degraded !== "boolean"
    || !["active", "idle", "exited", "unknown"].includes(String(value.status))
    || typeof value.attachable !== "boolean"
    || typeof value.hostLabel !== "string"
    || typeof value.createdAt !== "string") return undefined;
  return {
    sessionId: value.sessionId,
    name: value.name,
    backend: value.backend as TerminalSessionInfo["backend"],
    durability: value.durability as TerminalSessionInfo["durability"],
    degraded: value.degraded,
    status: value.status as TerminalSessionInfo["status"],
    attachable: value.attachable,
    hostLabel: value.hostLabel,
    createdAt: value.createdAt,
    ...optionalString(value, "envProfileId"), ...optionalString(value, "hostProfileId"),
    ...optionalString(value, "projectId"), ...optionalString(value, "taskId"),
    ...optionalString(value, "cwd"), ...optionalString(value, "shell"),
    ...optionalString(value, "lastActivityAt"),
    ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
    ...(Array.isArray(value.backendWarnings) ? {
      backendWarnings: value.backendWarnings.flatMap((warning) => {
        const projected = readBackendWarning(warning);
        return projected ? [projected] : [];
      })
    } : {})
  };
}

function optionalString(value: Record<string, unknown>, key: string): Record<string, string> {
  return typeof value[key] === "string" ? { [key]: value[key] } : {};
}

function readBackendWarning(value: unknown): NonNullable<TerminalSessionInfo["backendWarnings"]>[number] | undefined {
  if (!isTerminalStoreRecord(value)
    || value.code !== "terminal_backend_downgraded_non_durable"
    || !["direct-pty", "tmux", "remote"].includes(String(value.requestedBackend))
    || !["direct-pty", "tmux", "remote"].includes(String(value.selectedBackend))
    || typeof value.hint !== "string") return undefined;
  return {
    code: "terminal_backend_downgraded_non_durable",
    requestedBackend: value.requestedBackend as TerminalSessionInfo["backend"],
    selectedBackend: value.selectedBackend as TerminalSessionInfo["backend"],
    hint: value.hint
  };
}

function isTerminalStoreRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
