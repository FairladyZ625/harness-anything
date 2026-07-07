import * as fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { CurrentSessionRef, CurrentSessionRuntime } from "../../kernel/src/index.ts";
import type { ProvenanceSessionBackfillOptions, ProvenanceSessionDocument } from "./provenance-session-exporter.ts";

export interface RuntimeLogOptions {
  readonly homeDir?: string;
  readonly runtimeLogRoots?: Partial<Record<CurrentSessionRuntime, ReadonlyArray<string>>>;
}

export interface RuntimeConversationMessage {
  readonly role: "user" | "assistant" | "summary";
  readonly text: string;
  readonly timestamp?: string;
}

export interface RuntimeConversation {
  readonly logPath?: string;
  readonly messages: ReadonlyArray<RuntimeConversationMessage>;
  readonly warnings: ReadonlyArray<string>;
}

type JsonObject = Record<string, unknown>;

const maxRuntimeLogSearchDepth = 8;
const safeSessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function resolveRuntimeConversation(
  session: ProvenanceSessionDocument,
  options: RuntimeLogOptions
): Effect.Effect<RuntimeConversation> {
  return Effect.promise(() => resolveRuntimeConversationAsync(session, options));
}

async function resolveRuntimeConversationAsync(
  session: ProvenanceSessionDocument,
  options: RuntimeLogOptions
): Promise<RuntimeConversation> {
  const warnings: string[] = [];
  if (session.runtime === "human") {
    warnings.push("No runtime JSONL log is expected for human fallback sessions.");
    return { messages: [], warnings };
  }

  const logPath = await findRuntimeLogPath(session, options, warnings);
  if (!logPath) {
    warnings.push(`No runtime JSONL log found for ${session.runtime} session ${session.sessionId}.`);
    return { messages: [], warnings };
  }

  if (session.runtime === "antigravity") {
    warnings.push(`${session.runtime} runtime JSONL rendering is a progressive stub for M3.`);
    return { logPath, messages: [], warnings };
  }

  try {
    const body = await fs.promises.readFile(logPath, "utf8");
    const messages = parseRuntimeJsonl(session.runtime, body, warnings);
    if (messages.length === 0) warnings.push(`No conversation text could be extracted from ${displayRuntimePath(logPath)}.`);
    return { logPath, messages, warnings };
  } catch (error) {
    warnings.push(`Failed to read runtime JSONL log ${displayRuntimePath(logPath)}: ${errorMessage(error)}.`);
    return { logPath, messages: [], warnings };
  }
}

export function discoverRuntimeSessions(
  options: RuntimeLogOptions,
  backfillOptions: ProvenanceSessionBackfillOptions,
  detectedAt: string
): Effect.Effect<{ readonly sessions: ReadonlyArray<CurrentSessionRef>; readonly warnings: ReadonlyArray<string> }> {
  return Effect.promise(() => discoverRuntimeSessionsAsync(options, backfillOptions, detectedAt));
}

async function discoverRuntimeSessionsAsync(
  options: RuntimeLogOptions,
  backfillOptions: ProvenanceSessionBackfillOptions,
  detectedAt: string
): Promise<{ readonly sessions: ReadonlyArray<CurrentSessionRef>; readonly warnings: ReadonlyArray<string> }> {
  const warnings: string[] = [];
  const runtimes = backfillOptions.runtime ? [backfillOptions.runtime] : ["claude-code", "codex", "zcode", "antigravity"] as const;
  const sessions = new Map<string, CurrentSessionRef>();
  for (const runtime of runtimes) {
    const roots = options.runtimeLogRoots?.[runtime] ?? defaultRuntimeLogRoots(runtime, options.homeDir);
    if (roots.length === 0) {
      warnings.push(`No JSONL log roots are configured for ${runtime}.`);
      continue;
    }
    for (const root of roots) {
      for (const logPath of await listRuntimeJsonlFiles(root, maxRuntimeLogSearchDepth, warnings)) {
        const sessionId = sessionIdFromRuntimeLog(runtime, logPath);
        if (!sessionId || !safeSessionIdPattern.test(sessionId)) continue;
        const key = `${runtime}:${sessionId}`;
        if (!sessions.has(key)) {
          sessions.set(key, { runtime, sessionId, source: "runtime", detectedAt });
        }
        if (backfillOptions.limit && sessions.size >= backfillOptions.limit) {
          return { sessions: [...sessions.values()], warnings };
        }
      }
    }
  }
  return { sessions: [...sessions.values()], warnings };
}

async function findRuntimeLogPath(
  session: ProvenanceSessionDocument,
  options: RuntimeLogOptions,
  warnings: string[]
): Promise<string | undefined> {
  const configuredRoots = options.runtimeLogRoots?.[session.runtime];
  const roots = configuredRoots ?? defaultRuntimeLogRoots(session.runtime, options.homeDir);
  if (roots.length === 0) {
    warnings.push(`No JSONL log roots are configured for ${session.runtime}.`);
    return undefined;
  }

  return findFirstRuntimeLog(roots, session.sessionId, configuredRoots !== undefined, warnings);
}

async function findFirstRuntimeLog(
  roots: ReadonlyArray<string>,
  sessionId: string,
  allowExplicitFileRoot: boolean,
  warnings: string[]
): Promise<string | undefined> {
  for (const root of roots) {
    const match = await findMatchingJsonl(root, sessionId, allowExplicitFileRoot, warnings);
    if (match) return match;
  }
  return undefined;
}

function defaultRuntimeLogRoots(runtime: CurrentSessionRuntime, homeDir = process.env.HOME): ReadonlyArray<string> {
  if (!homeDir) return [];
  if (runtime === "claude-code") return [path.join(homeDir, ".claude", "projects")];
  if (runtime === "codex") {
    return [
      path.join(homeDir, ".codex", "sessions"),
      path.join(homeDir, ".codex", "archived_sessions")
    ];
  }
  if (runtime === "zcode") {
    return [
      path.join(homeDir, ".zcode", "cli", "rollout"),
      path.join(homeDir, ".zcode", "cli", "debug")
    ];
  }
  return [];
}

async function findMatchingJsonl(
  root: string,
  sessionId: string,
  allowExplicitFileRoot: boolean,
  warnings: string[]
): Promise<string | undefined> {
  let rootStat;
  try {
    rootStat = await fs.promises.stat(root);
  } catch (error) {
    if (allowExplicitFileRoot) warnings.push(`Configured runtime log root is not readable: ${root} (${errorMessage(error)}).`);
    return undefined;
  }

  if (rootStat.isFile()) {
    if (path.extname(root) === ".jsonl" && (allowExplicitFileRoot || fileNameMatchesSession(root, sessionId))) return root;
    return undefined;
  }
  if (!rootStat.isDirectory()) return undefined;
  return findMatchingJsonlInDirectory(root, sessionId, maxRuntimeLogSearchDepth);
}

async function findMatchingJsonlInDirectory(root: string, sessionId: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined;
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const sorted = entries.toSorted((left, right) => left.name.localeCompare(right.name));
  for (const entry of sorted) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && path.extname(entry.name) === ".jsonl" && fileNameMatchesSession(entry.name, sessionId)) {
      return fullPath;
    }
  }
  for (const entry of sorted) {
    if (!entry.isDirectory()) continue;
    const match = await findMatchingJsonlInDirectory(path.join(root, entry.name), sessionId, depth - 1);
    if (match) return match;
  }
  return undefined;
}

async function listRuntimeJsonlFiles(root: string, depth: number, warnings: string[]): Promise<ReadonlyArray<string>> {
  let rootStat;
  try {
    rootStat = await fs.promises.stat(root);
  } catch (error) {
    warnings.push(`Runtime log root is not readable: ${displayRuntimePath(root)} (${errorMessage(error)}).`);
    return [];
  }
  if (rootStat.isFile()) return path.extname(root) === ".jsonl" ? [root] : [];
  if (!rootStat.isDirectory() || depth < 0) return [];
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sorted = entries.toSorted((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of sorted) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && path.extname(entry.name) === ".jsonl") files.push(fullPath);
    if (entry.isDirectory()) files.push(...await listRuntimeJsonlFiles(fullPath, depth - 1, warnings));
  }
  return files;
}

function sessionIdFromRuntimeLog(runtime: Exclude<CurrentSessionRuntime, "human">, logPath: string): string | undefined {
  const basename = path.basename(logPath, ".jsonl");
  if (runtime === "codex") {
    const rollout = basename.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/u)?.[1];
    return rollout ?? basename;
  }
  if (runtime === "zcode") {
    return basename.match(/^model-io-(sess_[A-Za-z0-9._-]+)$/u)?.[1];
  }
  return basename;
}

function fileNameMatchesSession(filePath: string, sessionId: string): boolean {
  const basename = path.basename(filePath, ".jsonl");
  return basename === sessionId || basename.endsWith(`-${sessionId}`) || basename.endsWith(`_${sessionId}`);
}

function parseRuntimeJsonl(
  runtime: Exclude<CurrentSessionRuntime, "human" | "antigravity">,
  body: string,
  warnings: string[]
): ReadonlyArray<RuntimeConversationMessage> {
  if (runtime === "claude-code") return parseClaudeRuntimeJsonl(body, warnings);
  if (runtime === "codex") return parseCodexRuntimeJsonl(body, warnings);
  return parseZCodeRuntimeJsonl(body, warnings);
}

function parseClaudeRuntimeJsonl(body: string, warnings: string[]): ReadonlyArray<RuntimeConversationMessage> {
  const messages: RuntimeConversationMessage[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const record = parseJsonlRecord(line, warnings);
    if (!record) continue;
    const type = readString(record, "type");
    const message = readRecord(record, "message");
    if (!message) continue;
    const role = readString(message, "role");
    const timestamp = readString(record, "timestamp");
    if (type === "user" && role === "user") appendMessage(messages, "user", extractTextContent(message.content, "user"), timestamp);
    if (type === "assistant" && role === "assistant") appendMessage(messages, "assistant", extractTextContent(message.content, "assistant"), timestamp);
  }
  return messages;
}

function parseCodexRuntimeJsonl(body: string, warnings: string[]): ReadonlyArray<RuntimeConversationMessage> {
  const streamMessages: RuntimeConversationMessage[] = [];
  const compactedSnapshots: Array<{ readonly timestamp?: string; readonly messages: ReadonlyArray<RuntimeConversationMessage> }> = [];

  for (const line of body.split(/\r?\n/u)) {
    const record = parseJsonlRecord(line, warnings);
    if (!record) continue;
    const type = readString(record, "type");
    const timestamp = readString(record, "timestamp");
    const payload = readRecord(record, "payload");
    if (!payload) continue;

    if (type === "compacted") {
      const replacementHistory = readArray(payload, "replacement_history");
      if (replacementHistory.length > 0) {
        compactedSnapshots.push({ timestamp, messages: extractCodexReplacementHistory(replacementHistory, timestamp) });
      }
      continue;
    }

    if (type === "event_msg" && readString(payload, "type") === "user_message") {
      appendMessage(streamMessages, "user", readString(payload, "message") ?? "", timestamp);
      continue;
    }

    if (type !== "response_item") continue;
    const payloadType = readString(payload, "type");
    const role = readString(payload, "role");
    if (payloadType === "message" && role === "assistant") {
      appendMessage(streamMessages, "assistant", extractTextContent(payload.content, "assistant"), timestamp);
    } else if (payloadType === "message" && role === "user" && !streamMessages.some((message) => message.role === "user")) {
      appendMessage(streamMessages, "user", extractTextContent(payload.content, "user"), timestamp);
    }
  }

  const lastSnapshot = compactedSnapshots.at(-1);
  if (!lastSnapshot) return streamMessages;
  const streamAfterSnapshot = lastSnapshot.timestamp
    ? streamMessages.filter((message) => (message.timestamp ?? "") > lastSnapshot.timestamp!)
    : [];
  const recentSnapshotTexts = new Set(lastSnapshot.messages.slice(-6).map((message) => message.text));
  return [
    ...lastSnapshot.messages,
    ...streamAfterSnapshot.filter((message) => !recentSnapshotTexts.has(message.text))
  ];
}

function parseZCodeRuntimeJsonl(body: string, warnings: string[]): ReadonlyArray<RuntimeConversationMessage> {
  const messages: RuntimeConversationMessage[] = [];
  let lastUserText: string | undefined;
  let lastAssistantText: string | undefined;
  for (const line of body.split(/\r?\n/u)) {
    const record = parseJsonlRecord(line, warnings);
    if (!record) continue;
    if (readString(record, "type") !== "model_io") continue;
    if (readString(record, "querySource") === "session_title") continue;
    const timestamp = readString(record, "startedAt") ?? readString(record, "completedAt");
    const request = readRecord(record, "request");
    const requestBody = request ? readRecord(request, "body") : undefined;
    const userText = requestBody ? extractLastZCodeUserText(readArray(requestBody, "messages")) : "";
    if (userText && userText !== lastUserText) {
      appendMessage(messages, "user", userText, timestamp);
      lastUserText = userText;
    }
    const response = readRecord(record, "response");
    const assistantText = response ? readString(response, "text") ?? "" : "";
    if (assistantText && assistantText !== lastAssistantText) {
      appendMessage(messages, "assistant", assistantText, timestamp);
      lastAssistantText = assistantText;
    }
  }
  return messages;
}

function extractLastZCodeUserText(requestMessages: ReadonlyArray<unknown>): string {
  for (let index = requestMessages.length - 1; index >= 0; index -= 1) {
    const message = requestMessages[index];
    if (!isJsonObject(message) || readString(message, "role") !== "user") continue;
    const text = extractTextContent(message.content, "user");
    if (text) return text;
  }
  return "";
}

function extractCodexReplacementHistory(
  replacementHistory: ReadonlyArray<unknown>,
  timestamp?: string
): ReadonlyArray<RuntimeConversationMessage> {
  const messages: RuntimeConversationMessage[] = [];
  for (const item of replacementHistory) {
    if (!isJsonObject(item)) continue;
    const role = readString(item, "role");
    if (role !== "user" && role !== "assistant") continue;
    appendMessage(messages, role, extractTextContent(item.content, role), timestamp);
  }
  return messages;
}

function extractTextContent(content: unknown, role: "user" | "assistant"): string {
  if (typeof content === "string") return cleanRuntimeText(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!isJsonObject(item)) continue;
    const type = readString(item, "type");
    const text = readString(item, "text");
    if (text && (type === "text" || type === "input_text" || type === "output_text")) parts.push(text);
    if (role === "user" && type === "image") parts.push("[image]");
  }
  return cleanRuntimeText(parts.join("\n\n"));
}

function appendMessage(
  messages: RuntimeConversationMessage[],
  role: RuntimeConversationMessage["role"],
  rawText: string,
  timestamp?: string
): void {
  const text = cleanRuntimeText(rawText);
  if (!text || isSystemNoise(text)) return;
  messages.push({ role, text, ...(timestamp ? { timestamp } : {}) });
}

function cleanRuntimeText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/gu, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/gu, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/gu, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gu, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gu, "")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
}

function isSystemNoise(text: string): boolean {
  return [
    "<environment",
    "<environment_context>",
    "<INSTRUCTIONS>",
    "<permissions",
    "<developer>",
    "# AGENTS.md",
    "## Apps\n",
    "Base directory for this skill:"
  ].some((prefix) => text.startsWith(prefix));
}

function parseJsonlRecord(line: string, warnings: string[]): JsonObject | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isJsonObject(parsed)) return parsed;
    warnings.push("Skipped non-object JSONL record.");
  } catch {
    warnings.push("Skipped malformed JSONL record.");
  }
  return undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(record: JsonObject, key: string): JsonObject | undefined {
  const value = record[key];
  return isJsonObject(value) ? value : undefined;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readArray(record: JsonObject, key: string): ReadonlyArray<unknown> {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

export function displayRuntimePath(logPath: string): string {
  const homeDir = process.env.HOME;
  if (homeDir && logPath.startsWith(`${homeDir}${path.sep}`)) {
    return `~/${path.relative(homeDir, logPath).split(path.sep).join("/")}`;
  }
  return logPath.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
