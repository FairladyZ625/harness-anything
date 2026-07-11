import path from "node:path";
import { Effect } from "effect";
import type { ArtifactStore, CurrentSessionProbePort, CurrentSessionRef, CurrentSessionRuntime, CurrentSessionSource, SessionManifest, WriteCoordinator, WriteError } from "../../kernel/src/index.ts";
import { privateTextScannerVersion, resolveHarnessLayout, scanPrivateText, writeContentAddressedBlob, writeSessionEntity, type HarnessLayoutInput } from "../../kernel/src/index.ts";
import { discoverRuntimeSessions, displayRuntimePath, resolveRuntimeConversation, type RuntimeConversation, type RuntimeConversationMessage } from "./runtime-session-logs.ts";
import { readSessionEntity } from "./session-entity-reader.ts";

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
    // Capture is report-only: sessions land in the private ledger (system of record),
    // so findings are recorded honestly in the manifest and enforcement stays at the
    // publish boundary (buildPublishableProjection fails closed there).
    const privacyFindings = [
      ...scanPrivateText(JSON.stringify(session), "manifest"),
      ...conversation.messages.flatMap((message, index) => scanPrivateText(message.text, `snapshot.messages.${index}`))
    ];
    const body = renderSessionMarkdown(session, conversation);
    const bodyRef = yield* Effect.try({
      try: () => ({
        store: "authored-cas/v1" as const,
        ...writeContentAddressedBlob(rootInput, body, sessionMediaType)
      }),
      catch: (cause) => sessionRejection(session.sessionId, cause instanceof Error ? cause.message : String(cause), "write_failed")
    });
    const manifest = toSessionManifest(session, conversation, bodyRef, privacyFindings);
    return yield* writeSessionEntity(options.coordinator, rootInput, manifest, {
      opIdPrefix: `session-export-${session.sessionId}`
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
  _options: Pick<ProvenanceSessionExporterOptions, "artifactStore">,
  sessionId: string
): Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected> {
  return Effect.try({
    try: () => {
      const target = resolveSessionPath(rootInput, sessionId);
      const result = readSessionEntity(rootInput, sessionId);
      const metadata = result.format === "manifest" ? result.manifest : result.metadata;
      assertRuntime(metadata.runtime);
      assertSource(metadata.source);
      return {
        session: {
          schema: sessionSchema,
          sessionId: metadata.sessionId,
          runtime: metadata.runtime,
          source: metadata.source,
          detectedAt: metadata.detectedAt,
          exportedAt: metadata.exportedAt,
          ...(metadata.user ? { user: metadata.user } : {})
        },
        path: target.authoredRelativePath
      };
    },
    catch: (cause) => {
      const reason = cause instanceof Error ? cause.message : "session read failed";
      const missing = isMissingFileError(cause);
      return sessionRejection(
        sessionId,
        missing ? `session not found: ${sessionId}` : reason,
        missing ? "session_not_found" : reason.startsWith("session transcript unavailable:") ? "transcript_unavailable" : "read_failed"
      );
    }
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

function toSessionManifest(
  session: ProvenanceSessionDocument,
  conversation: RuntimeConversation,
  bodyRef: SessionManifest["bodyRef"],
  privacyFindings: SessionManifest["snapshot"]["privacyScan"]["findings"]
): SessionManifest {
  const timestamps = conversation.messages.flatMap((message) => message.timestamp ? [message.timestamp] : []);
  const complete = session.runtime === "human" || conversation.warnings.length === 0;
  return {
    schema: "session-entity/v1",
    sessionId: session.sessionId,
    lifecycle: complete ? "sealed" : "partial",
    archiveStatus: complete ? "complete" : "partial",
    runtime: session.runtime,
    source: session.source,
    detectedAt: session.detectedAt,
    exportedAt: session.exportedAt,
    ...(session.user ? { user: session.user } : {}),
    bodyRef,
    snapshot: {
      capturedAt: session.exportedAt,
      completeness: complete ? "complete" : "partial",
      captureRange: {
        messageCount: conversation.messages.length,
        ...(timestamps[0] ? { firstMessageAt: timestamps[0] } : {}),
        ...(timestamps.at(-1) ? { lastMessageAt: timestamps.at(-1) } : {})
      },
      privacyScan: {
        scannerVersion: privateTextScannerVersion,
        passed: !privacyFindings.some((finding) => finding.severity === "error"),
        findings: privacyFindings
      }
    }
  };
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

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
