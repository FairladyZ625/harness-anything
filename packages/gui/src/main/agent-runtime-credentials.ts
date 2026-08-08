import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Agent Runtime credentials writer.
 *
 * Writes API-key credentials to `~/.harness/agent-runtime-credentials.yaml` so
 * the user has a durable, human-readable persistence layer for runtime auth.
 * The file is written atomically (temp + rename) with mode 0o600 to keep the
 * secret file owner-private. Account-based profiles (subscription/chatgpt) are
 * NOT written here — those are owned by the provider's own login flow.
 */

export interface AgentRuntimeCredentialWrite {
  readonly kindId: "claude-code" | "codex";
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export interface AgentRuntimeCredentialResult {
  readonly ok: true;
  readonly path: string;
}

export interface AgentRuntimeCredentialFailure {
  readonly ok: false;
  readonly error: { readonly code: string; readonly hint: string };
}

const SCHEMA = "agent-runtime-credentials/v1";

export function credentialsFilePath(userRoot?: string): string {
  const base = userRoot && userRoot.length > 0 ? userRoot : path.join(os.homedir(), ".harness");
  return path.join(base, "agent-runtime-credentials.yaml");
}

export interface AgentRuntimeCredentialsWriterHandle {
  readonly write: (payload: AgentRuntimeCredentialWrite) => Promise<AgentRuntimeCredentialResult | AgentRuntimeCredentialFailure>;
}

export function createAgentRuntimeCredentialsWriter(
  options: { readonly userRoot?: string } = {}
): AgentRuntimeCredentialsWriterHandle {
  return {
    write: (payload) => writeAgentRuntimeCredentials(payload, options)
  };
}

export async function writeAgentRuntimeCredentials(
  input: AgentRuntimeCredentialWrite,
  options: { readonly userRoot?: string } = {}
): Promise<AgentRuntimeCredentialResult | AgentRuntimeCredentialFailure> {
  if (input.kindId !== "claude-code" && input.kindId !== "codex") {
    return { ok: false, error: { code: "invalid_kind", hint: `Unsupported runtime kindId: ${input.kindId}` } };
  }
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    return { ok: false, error: { code: "invalid_api_key", hint: "apiKey must be a non-empty string." } };
  }
  const targetPath = credentialsFilePath(options.userRoot);
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    const existing = await readExistingEntries(targetPath);
    const next = upsertEntry(existing, input);
    const tempPath = path.join(path.dirname(targetPath), `.agent-runtime-credentials.${process.pid}.${crypto.randomUUID()}.tmp`);
    await writeFile(tempPath, renderYaml(next), { mode: 0o600 });
    await rename(tempPath, targetPath);
    return { ok: true, path: targetPath };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "credential_write_failed",
        hint: `Failed to write credentials: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }
}

interface CredentialEntry {
  readonly kindId: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

async function readExistingEntries(targetPath: string): Promise<CredentialEntry[]> {
  if (!existsSync(targetPath)) return [];
  try {
    // Lazy import so the renderer boundary is never pulled through this module.
    const { readFile } = await import("node:fs/promises");
    const body = await readFile(targetPath, "utf8");
    return parseYaml(body);
  } catch {
    return [];
  }
}

function parseYaml(body: string): CredentialEntry[] {
  const entries: CredentialEntry[] = [];
  let current: Partial<CredentialEntry> & { kindId?: string; apiKey?: string; baseUrl?: string } = {};
  let inEntries = false;
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+$/u, "");
    if (/^entries:\s*$/u.test(line)) {
      inEntries = true;
      continue;
    }
    if (/^\S/u.test(line) && !line.startsWith("#") && !line.startsWith("-")) {
      if (inEntries && current.kindId && current.apiKey) entries.push({ ...current } as CredentialEntry);
      current = {};
      inEntries = false;
    }
    if (!inEntries) continue;
    if (/^-\s+kindId:\s*(.+)$/u.test(line)) {
      if (current.kindId && current.apiKey) entries.push({ ...current } as CredentialEntry);
      current = { kindId: line.replace(/^-\s+kindId:\s*/u, "").trim().replace(/^["']|["']$/gu, "") };
      continue;
    }
    if (/^\s+kindId:\s*(.+)$/u.test(line)) {
      current.kindId = line.replace(/^\s+kindId:\s*/u, "").trim().replace(/^["']|["']$/gu, "");
      continue;
    }
    if (/^\s+apiKey:\s*(.+)$/u.test(line)) {
      current.apiKey = line.replace(/^\s+apiKey:\s*/u, "").trim().replace(/^["']|["']$/gu, "");
      continue;
    }
    if (/^\s+baseUrl:\s*(.+)$/u.test(line)) {
      current.baseUrl = line.replace(/^\s+baseUrl:\s*/u, "").trim().replace(/^["']|["']$/gu, "");
      continue;
    }
  }
  if (current.kindId && current.apiKey) entries.push({ ...current } as CredentialEntry);
  return entries;
}

function upsertEntry(existing: ReadonlyArray<CredentialEntry>, input: AgentRuntimeCredentialWrite): CredentialEntry[] {
  const next: CredentialEntry[] = [];
  let replaced = false;
  for (const entry of existing) {
    if (entry.kindId === input.kindId) {
      next.push({ kindId: input.kindId, apiKey: input.apiKey, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}) });
      replaced = true;
    } else {
      next.push(entry);
    }
  }
  if (!replaced) {
    next.push({ kindId: input.kindId, apiKey: input.apiKey, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}) });
  }
  return next;
}

function renderYaml(entries: ReadonlyArray<CredentialEntry>): string {
  const lines: string[] = [
    `schema: ${SCHEMA}`,
    "entries:"
  ];
  entries.forEach((entry, index) => {
    if (index === 0) {
      lines.push(`- kindId: ${yamlString(entry.kindId)}`);
    } else {
      lines.push(`- kindId: ${yamlString(entry.kindId)}`);
    }
    lines.push(`  apiKey: ${yamlString(entry.apiKey)}`);
    if (entry.baseUrl) lines.push(`  baseUrl: ${yamlString(entry.baseUrl)}`);
  });
  return `${lines.join("\n")}\n`;
}

function yamlString(value: string): string {
  if (value.length === 0) return '""';
  // Quote if the value starts with a reserved YAML indicator or contains
  // sequences that would confuse a plain-scalar parse: colon-space (`: `),
  // colon-at-end, trailing space, or ` #` (comment marker). A bare colon in a
  // URL (https://...) is safe in a plain scalar.
  const needsQuote = /^[-?:#[\]{}&*!|>'"%@`,\s]/u.test(value)
    || /:\s/u.test(value)
    || /:$/u.test(value)
    || /\s#$/u.test(value)
    || /\s#/u.test(value)
    || /\s$/u.test(value);
  if (needsQuote) {
    return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
  }
  return value;
}
