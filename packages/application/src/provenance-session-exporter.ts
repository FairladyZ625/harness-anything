import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { CurrentSessionProbePort, CurrentSessionRef, CurrentSessionRuntime, CurrentSessionSource } from "../../kernel/src/index.ts";
import { readFrontmatter, readScalar, resolveHarnessLayout, type HarnessLayoutInput } from "../../kernel/src/layout/index.ts";

export interface ProvenanceSessionExporterOptions {
  readonly rootInput: HarnessLayoutInput;
  readonly currentSessionProbe: CurrentSessionProbePort;
  readonly now?: () => string;
  readonly homeDir?: string;
  readonly runtimeLogRoots?: Partial<Record<CurrentSessionRuntime, ReadonlyArray<string>>>;
}

export interface ProvenanceSessionDocument {
  readonly schema: "provenance-session/v1";
  readonly sessionId: string;
  readonly runtime: CurrentSessionRuntime;
  readonly source: CurrentSessionSource;
  readonly detectedAt: string;
  readonly exportedAt: string;
  readonly user?: string;
}

export interface ProvenanceSessionExportResult {
  readonly session: ProvenanceSessionDocument;
  readonly path: string;
}

export interface ProvenanceSessionExporterRejected {
  readonly _tag: "ProvenanceSessionExporterRejected";
  readonly sessionId: string;
  readonly reason: string;
}

export interface ProvenanceSessionExporter {
  readonly exportSession: (session: CurrentSessionRef) => Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected>;
  readonly exportCurrentSession: () => Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected>;
  readonly readById: (sessionId: string) => Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected>;
}

const sessionSchema = "provenance-session/v1";
const safeSessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const maxRuntimeLogSearchDepth = 8;

interface RuntimeConversationMessage {
  readonly role: "user" | "assistant" | "summary";
  readonly text: string;
  readonly timestamp?: string;
}

interface RuntimeConversation {
  readonly logPath?: string;
  readonly messages: ReadonlyArray<RuntimeConversationMessage>;
  readonly warnings: ReadonlyArray<string>;
}

type JsonObject = Record<string, unknown>;

export function makeProvenanceSessionExporter(options: ProvenanceSessionExporterOptions): ProvenanceSessionExporter {
  const timestamp = () => options.now?.() ?? new Date().toISOString();
  const exportSession = (session: CurrentSessionRef) => writeSessionDocument(options.rootInput, options, toSessionDocument(session, timestamp()));
  return {
    exportSession,
    exportCurrentSession: () => options.currentSessionProbe.currentSession.pipe(
      Effect.flatMap(exportSession)
    ),
    readById: (sessionId) => readSessionDocument(options.rootInput, sessionId)
  };
}

function toSessionDocument(session: CurrentSessionRef, exportedAt: string): ProvenanceSessionDocument {
  return {
    schema: sessionSchema,
    sessionId: session.sessionId,
    runtime: session.runtime,
    source: session.source,
    detectedAt: session.detectedAt,
    exportedAt,
    ...(session.user ? { user: session.user } : {})
  };
}

function writeSessionDocument(
  rootInput: HarnessLayoutInput,
  options: ProvenanceSessionExporterOptions,
  session: ProvenanceSessionDocument
): Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected> {
  return Effect.try({
    try: () => {
      const target = resolveSessionPath(rootInput, session.sessionId);
      mkdirSync(path.dirname(target.absolutePath), { recursive: true });
      const tmpPath = `${target.absolutePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, renderSessionMarkdown(session, resolveRuntimeConversation(session, options)), "utf8");
      renameSync(tmpPath, target.absolutePath);
      return {
        session,
        path: target.relativePath
      };
    },
    catch: (error) => sessionRejection(session.sessionId, error instanceof Error ? error.message : "session export failed")
  });
}

function readSessionDocument(
  rootInput: HarnessLayoutInput,
  sessionId: string
): Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected> {
  return Effect.try({
    try: () => {
      const target = resolveSessionPath(rootInput, sessionId);
      if (!existsSync(target.absolutePath)) {
        throw new Error(`session not found: ${sessionId}`);
      }
      const body = readFileSync(target.absolutePath, "utf8");
      const session = parseSessionMarkdown(body, sessionId);
      return {
        session,
        path: target.relativePath
      };
    },
    catch: (error) => sessionRejection(sessionId, error instanceof Error ? error.message : "session read failed")
  });
}

function resolveSessionPath(rootInput: HarnessLayoutInput, sessionId: string): { readonly absolutePath: string; readonly relativePath: string } {
  assertSafeSessionId(sessionId);
  const layout = resolveHarnessLayout(rootInput);
  const absolutePath = layout.sessionDocumentPath(sessionId);
  return {
    absolutePath,
    relativePath: path.relative(layout.authoredRoot, absolutePath).split(path.sep).join("/")
  };
}

function parseSessionMarkdown(body: string, expectedSessionId: string): ProvenanceSessionDocument {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter) throw new Error("session markdown missing frontmatter");
  const schema = readScalar(frontmatter, "schema", { required: true });
  if (schema !== sessionSchema) throw new Error(`unsupported session schema: ${schema}`);
  const sessionId = readScalar(frontmatter, "sessionId", { required: true });
  if (sessionId !== expectedSessionId) throw new Error(`session id mismatch: ${sessionId}`);
  const runtime = readScalar(frontmatter, "runtime", { required: true });
  const source = readScalar(frontmatter, "source", { required: true });
  assertRuntime(runtime);
  assertSource(source);
  const user = readScalar(frontmatter, "user");
  return {
    schema,
    sessionId,
    runtime,
    source,
    detectedAt: readScalar(frontmatter, "detectedAt", { required: true }),
    exportedAt: readScalar(frontmatter, "exportedAt", { required: true }),
    ...(user ? { user } : {})
  };
}

function renderSessionMarkdown(session: ProvenanceSessionDocument, conversation: RuntimeConversation): string {
  return [
    "---",
    `schema: ${session.schema}`,
    `sessionId: ${session.sessionId}`,
    `runtime: ${session.runtime}`,
    `source: ${session.source}`,
    `detectedAt: ${session.detectedAt}`,
    `exportedAt: ${session.exportedAt}`,
    ...(session.user ? [`user: ${sanitizeScalar(session.user)}`] : []),
    "---",
    "",
    `# Session ${session.sessionId}`,
    "",
    `Runtime: ${session.runtime}`,
    `Source: ${session.source}`,
    `Detected at: ${session.detectedAt}`,
    `Exported at: ${session.exportedAt}`,
    ...(session.user ? [`User: ${sanitizeScalar(session.user)}`] : []),
    ...(conversation.logPath ? [`Runtime log: ${displayRuntimePath(conversation.logPath)}`] : []),
    "",
    ...renderWarnings(conversation.warnings),
    "## Conversation",
    "",
    ...renderConversationMessages(conversation.messages),
    ""
  ].join("\n");
}

function resolveRuntimeConversation(
  session: ProvenanceSessionDocument,
  options: ProvenanceSessionExporterOptions
): RuntimeConversation {
  const warnings: string[] = [];
  if (session.runtime === "human") {
    warnings.push("No runtime JSONL log is expected for human fallback sessions.");
    return { messages: [], warnings };
  }

  const logPath = findRuntimeLogPath(session, options, warnings);
  if (!logPath) {
    warnings.push(`No runtime JSONL log found for ${session.runtime} session ${session.sessionId}.`);
    return { messages: [], warnings };
  }

  if (session.runtime === "zcode" || session.runtime === "antigravity") {
    warnings.push(`${session.runtime} runtime JSONL rendering is a progressive stub for M3.`);
    return { logPath, messages: [], warnings };
  }

  try {
    const body = readFileSync(logPath, "utf8");
    const messages = session.runtime === "claude-code"
      ? parseClaudeRuntimeJsonl(body, warnings)
      : parseCodexRuntimeJsonl(body, warnings);
    if (messages.length === 0) warnings.push(`No conversation text could be extracted from ${displayRuntimePath(logPath)}.`);
    return { logPath, messages, warnings };
  } catch (error) {
    warnings.push(`Failed to read runtime JSONL log ${displayRuntimePath(logPath)}: ${errorMessage(error)}.`);
    return { logPath, messages: [], warnings };
  }
}

function findRuntimeLogPath(
  session: ProvenanceSessionDocument,
  options: ProvenanceSessionExporterOptions,
  warnings: string[]
): string | undefined {
  const configuredRoots = options.runtimeLogRoots?.[session.runtime];
  const roots = configuredRoots ?? defaultRuntimeLogRoots(session.runtime, options.homeDir);
  if (roots.length === 0) {
    warnings.push(`No JSONL log roots are configured for ${session.runtime}.`);
    return undefined;
  }

  for (const root of roots) {
    const match = findMatchingJsonl(root, session.sessionId, configuredRoots !== undefined, warnings);
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
  return [];
}

function findMatchingJsonl(
  root: string,
  sessionId: string,
  allowExplicitFileRoot: boolean,
  warnings: string[]
): string | undefined {
  let rootStat;
  try {
    rootStat = statSync(root);
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

function findMatchingJsonlInDirectory(root: string, sessionId: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
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
    const match = findMatchingJsonlInDirectory(path.join(root, entry.name), sessionId, depth - 1);
    if (match) return match;
  }
  return undefined;
}

function fileNameMatchesSession(filePath: string, sessionId: string): boolean {
  const basename = path.basename(filePath, ".jsonl");
  return basename === sessionId || basename.endsWith(`-${sessionId}`) || basename.includes(sessionId);
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

function renderWarnings(warnings: ReadonlyArray<string>): ReadonlyArray<string> {
  if (warnings.length === 0) return [];
  return [
    "## Export Warnings",
    "",
    ...warnings.map((warning) => `- ${warning}`),
    ""
  ];
}

function renderConversationMessages(messages: ReadonlyArray<RuntimeConversationMessage>): ReadonlyArray<string> {
  if (messages.length === 0) return ["_No conversation text extracted._", ""];
  return messages.flatMap((message) => [
    `### ${renderRole(message.role)}${message.timestamp ? ` (${message.timestamp})` : ""}`,
    "",
    message.text,
    ""
  ]);
}

function renderRole(role: RuntimeConversationMessage["role"]): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  return "Summary";
}

function assertSafeSessionId(sessionId: string): void {
  if (!safeSessionIdPattern.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
}

function assertRuntime(value: string): asserts value is CurrentSessionRuntime {
  if (value !== "human" && value !== "claude-code" && value !== "codex" && value !== "zcode" && value !== "antigravity") {
    throw new Error(`invalid session runtime: ${value}`);
  }
}

function assertSource(value: string): asserts value is CurrentSessionSource {
  if (value !== "runtime" && value !== "manual") throw new Error(`invalid session source: ${value}`);
}

function displayRuntimePath(logPath: string): string {
  const homeDir = process.env.HOME;
  if (homeDir && logPath.startsWith(`${homeDir}${path.sep}`)) {
    return `~/${path.relative(homeDir, logPath).split(path.sep).join("/")}`;
  }
  return logPath.split(path.sep).join("/");
}

function sanitizeScalar(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionRejection(sessionId: string, reason: string): ProvenanceSessionExporterRejected {
  return {
    _tag: "ProvenanceSessionExporterRejected",
    sessionId,
    reason
  };
}
