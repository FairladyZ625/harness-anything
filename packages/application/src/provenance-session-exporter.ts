import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { CurrentSessionProbePort, CurrentSessionRef, CurrentSessionRuntime, CurrentSessionSource } from "../../kernel/src/index.ts";
import { readFrontmatter, readScalar, resolveHarnessLayout, type HarnessLayoutInput } from "../../kernel/src/layout/index.ts";

export interface ProvenanceSessionExporterOptions {
  readonly rootInput: HarnessLayoutInput;
  readonly currentSessionProbe: CurrentSessionProbePort;
  readonly now?: () => string;
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

export function makeProvenanceSessionExporter(options: ProvenanceSessionExporterOptions): ProvenanceSessionExporter {
  const timestamp = () => options.now?.() ?? new Date().toISOString();
  const exportSession = (session: CurrentSessionRef) => writeSessionDocument(options.rootInput, toSessionDocument(session, timestamp()));
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
  session: ProvenanceSessionDocument
): Effect.Effect<ProvenanceSessionExportResult, ProvenanceSessionExporterRejected> {
  return Effect.try({
    try: () => {
      const target = resolveSessionPath(rootInput, session.sessionId);
      mkdirSync(path.dirname(target.absolutePath), { recursive: true });
      const tmpPath = `${target.absolutePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, renderSessionMarkdown(session), "utf8");
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

function renderSessionMarkdown(session: ProvenanceSessionDocument): string {
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
    ""
  ].join("\n");
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

function sessionRejection(sessionId: string, reason: string): ProvenanceSessionExporterRejected {
  return {
    _tag: "ProvenanceSessionExporterRejected",
    sessionId,
    reason
  };
}
