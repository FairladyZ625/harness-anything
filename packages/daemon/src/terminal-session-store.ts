import { readFileSync } from "node:fs";
import { writeFileDurably } from "./durable-file.ts";

const schema = "terminal-session-registry/v1" as const;

export interface StoredTmuxSession {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly cwd: string;
  readonly shellProfile: string;
  readonly tmuxNamespace: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
}

export function loadTmuxSessionRegistry(filePath: string): readonly StoredTmuxSession[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(filePath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!isSessionRegistryRecord(parsed) || parsed.schema !== schema || !Array.isArray(parsed.sessions)) throw new Error("invalid terminal session registry schema");
  const sessions = parsed.sessions.map(readStoredTmuxSession);
  if (!sessions.every((session): session is StoredTmuxSession => session !== undefined)) throw new Error("invalid terminal session registry record");
  return sessions;
}

export function saveTmuxSessionRegistry(filePath: string, sessions: readonly StoredTmuxSession[]): void {
  writeFileDurably(filePath, `${JSON.stringify({ schema, sessions }, null, 2)}\n`, 0o600);
}

function readStoredTmuxSession(value: unknown): StoredTmuxSession | undefined {
  const fields = ["sessionId", "idempotencyKey", "name", "cwd", "shellProfile", "tmuxNamespace", "createdAt", "lastActivityAt"] as const;
  if (!isSessionRegistryRecord(value) || Object.keys(value).some((key) => !fields.includes(key as typeof fields[number])) || fields.some((key) => typeof value[key] !== "string" || value[key] === "")) return undefined;
  return Object.fromEntries(fields.map((key) => [key, value[key]])) as unknown as StoredTmuxSession;
}

function isSessionRegistryRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
