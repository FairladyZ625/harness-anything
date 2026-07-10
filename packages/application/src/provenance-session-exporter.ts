import path from "node:path";
import { Effect } from "effect";
import type { ArtifactStore, CurrentSessionProbePort, CurrentSessionRef, CurrentSessionRuntime, CurrentSessionSource, WriteCoordinator, WriteError } from "../../kernel/src/index.ts";
import { moduleEntityId, readFrontmatter, readScalar, resolveHarnessLayout, stablePayloadHash, writeContentAddressedBlob, writeCoordinatedPayload, type HarnessLayoutInput } from "../../kernel/src/index.ts";
import { discoverRuntimeSessions, displayRuntimePath, resolveRuntimeConversation, type RuntimeConversation, type RuntimeConversationMessage } from "./runtime-session-logs.ts";

export interface ProvenanceSessionExporterOptions {
  readonly rootInput: HarnessLayoutInput;
  readonly currentSessionProbe: CurrentSessionProbePort;
  readonly coordinator: WriteCoordinator;
  readonly artifactStore: Pick<ArtifactStore, "readAuthoredDocument">;
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

export interface ProvenanceSessionExportOptions {
  readonly transcriptFile?: string;
}

export interface ProvenanceSessionBackfillOptions {
  readonly runtime?: Exclude<CurrentSessionRuntime, "human">;
  readonly limit?: number;
}

export interface ProvenanceSessionBackfillResult {
  readonly schema: "provenance-session-backfill/v1";
  readonly exported: ReadonlyArray<ProvenanceSessionExportResult>;
  readonly warnings: ReadonlyArray<string>;
}

export interface ProvenanceSessionExporterRejected {
  readonly _tag: "ProvenanceSessionExporterRejected";
  readonly sessionId: string;
  readonly code: "transcript_unavailable" | "session_not_found" | "read_failed" | "write_failed";
  readonly reason: string;
}

export interface ProvenanceSessionExporter {
  readonly exportSession: (session: CurrentSessionRef, options?: ProvenanceSessionExportOptions) => Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected>;
  readonly exportCurrentSession: (options?: ProvenanceSessionExportOptions) => Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected>;
  readonly backfillRuntimeSessions: (options?: ProvenanceSessionBackfillOptions) => Effect.Effect<ProvenanceSessionBackfillResult, ProvenanceSessionExporterRejected>;
  readonly readById: (sessionId: string) => Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected>;
}

const sessionSchema = "provenance-session/v1";
const sessionMediaType = "text/markdown; charset=utf-8";
const safeSessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function makeProvenanceSessionExporter(options: ProvenanceSessionExporterOptions): ProvenanceSessionExporter {
  const timestamp = () => options.now?.() ?? new Date().toISOString();
  const exportSession = (session: CurrentSessionRef, exportOptions: ProvenanceSessionExportOptions = {}) =>
    writeSessionDocument(options.rootInput, options, toSessionDocument(session, timestamp()), exportOptions);
  return {
    exportSession,
    exportCurrentSession: (exportOptions = {}) => options.currentSessionProbe.currentSession.pipe(
      Effect.flatMap((session) => exportSession(session, exportOptions))
    ),
    backfillRuntimeSessions: (backfillOptions = {}) => backfillRuntimeSessions(options.rootInput, options, backfillOptions, timestamp),
    readById: (sessionId) => readSessionDocument(options.rootInput, options, sessionId)
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
  session: ProvenanceSessionDocument,
  exportOptions: ProvenanceSessionExportOptions = {}
): Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected> {
  return Effect.gen(function* () {
    const target = resolveSessionPath(rootInput, session.sessionId);
    if (session.runtime === "human" && exportOptions.transcriptFile) {
      return yield* Effect.fail(sessionRejection(
        session.sessionId,
        "An explicit transcript file requires a non-human runtime session.",
        "transcript_unavailable"
      ));
    }
    const conversation = yield* resolveRuntimeConversation(session, {
      ...options,
      ...(exportOptions.transcriptFile ? { transcriptFile: exportOptions.transcriptFile } : {})
    });
    if (session.runtime !== "human" && conversation.messages.length === 0) {
      return yield* Effect.fail(sessionRejection(
        session.sessionId,
        conversation.warnings.join(" ") || `No conversation text could be extracted for ${session.runtime} session ${session.sessionId}.`,
        "transcript_unavailable"
      ));
    }
    const body = renderSessionMarkdown(session, conversation);
    const bodyRef = yield* Effect.try({
      try: () => writeContentAddressedBlob(rootInput, body, sessionMediaType),
      catch: (cause) => sessionRejection(session.sessionId, cause instanceof Error ? cause.message : String(cause), "write_failed")
    });
    return yield* writeCoordinatedPayload(options.coordinator, stablePayloadHash, {
      entityId: moduleEntityId("provenance-session"),
      kind: "machine_artifact_write",
      opIdPrefix: `session-export-${session.sessionId}`,
      payload: {
        boundary: "provenance-session",
        path: target.rootRelativePath,
        bodyRef
      }
    }).pipe(
      Effect.map(() => ({
        session,
        path: target.authoredRelativePath
      })),
      Effect.mapError((error) => sessionRejection(session.sessionId, writeErrorMessage(error), "write_failed"))
    );
  });
}

function readSessionDocument(
  rootInput: HarnessLayoutInput,
  options: Pick<ProvenanceSessionExporterOptions, "artifactStore">,
  sessionId: string
): Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected> {
  return Effect.gen(function* () {
    const target = resolveSessionPath(rootInput, sessionId);
    return yield* options.artifactStore.readAuthoredDocument(target.authoredRelativePath).pipe(
      Effect.mapError((error) => sessionRejection(
        sessionId,
        error._tag === "ArtifactReadFailed" ? `session not found: ${sessionId}` : "session read failed",
        error._tag === "ArtifactReadFailed" ? "session_not_found" : "read_failed"
      )),
      Effect.flatMap((document) => Effect.try({
        try: () => {
          const body = document.body;
          const session = parseSessionMarkdown(body, sessionId);
          if (session.runtime !== "human" && !/^### (?:User|Assistant|Summary)(?: \(|$)/mu.test(body)) {
            throw new Error(`session transcript unavailable: ${sessionId}`);
          }
          return {
            session,
            path: target.authoredRelativePath
          };
        },
        catch: (cause) => {
          const reason = cause instanceof Error ? cause.message : "session read failed";
          return sessionRejection(sessionId, reason, reason.startsWith("session transcript unavailable:") ? "transcript_unavailable" : "read_failed");
        }
      }))
    );
  });
}

function backfillRuntimeSessions(
  rootInput: HarnessLayoutInput,
  options: ProvenanceSessionExporterOptions,
  backfillOptions: ProvenanceSessionBackfillOptions,
  timestamp: () => string
): Effect.Effect<ProvenanceSessionBackfillResult, ProvenanceSessionExporterRejected> {
  return Effect.gen(function* () {
    const detectedAt = timestamp();
    const discovered = yield* discoverRuntimeSessions(options, backfillOptions, detectedAt);
    const exported: ProvenanceSessionExportResult[] = [];
    for (const session of discovered.sessions) {
      const existing = yield* readSessionDocument(rootInput, options, session.sessionId).pipe(
        Effect.catchAll(() => writeSessionDocument(rootInput, options, toSessionDocument(session, timestamp())))
      );
      exported.push(existing);
    }
    return {
      schema: "provenance-session-backfill/v1",
      exported,
      warnings: discovered.warnings
    };
  });
}

function resolveSessionPath(rootInput: HarnessLayoutInput, sessionId: string): { readonly absolutePath: string; readonly authoredRelativePath: string; readonly rootRelativePath: string } {
  assertSafeSessionId(sessionId);
  const layout = resolveHarnessLayout(rootInput);
  const absolutePath = layout.sessionDocumentPath(sessionId);
  return {
    absolutePath,
    authoredRelativePath: path.relative(layout.authoredRoot, absolutePath).split(path.sep).join("/"),
    rootRelativePath: path.relative(layout.rootDir, absolutePath).split(path.sep).join("/")
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

function sanitizeScalar(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function sessionRejection(
  sessionId: string,
  reason: string,
  code: ProvenanceSessionExporterRejected["code"] = "read_failed"
): ProvenanceSessionExporterRejected {
  return {
    _tag: "ProvenanceSessionExporterRejected",
    sessionId,
    code,
    reason
  };
}

function writeErrorMessage(error: WriteError): string {
  if (error._tag === "WriteRejected") return error.reason;
  if (error._tag === "WriteConflict") return error.owner ? `write conflict for ${error.taskId}: ${error.owner}` : `write conflict for ${error.taskId}`;
  if (error._tag === "GlobalWriteConflict") return error.owner ? `global write conflict: ${error.owner}` : "global write conflict";
  return error.cause instanceof Error ? error.cause.message : "session export failed";
}
