import { Effect, Schema } from "effect";
import type { WriteError } from "../domain/index.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import type { WriteCoordinator } from "../ports/index.ts";
import { SessionManifestSchema, type SessionManifest } from "../schemas/session-manifest.ts";
import { decodeEntityDeclaration, resolveEntityDocumentPath, writeDeclaredEntity } from "./declaration.ts";
import { sessionEntityRegistration } from "./session-declaration.ts";

export const sessionEntityDeclaration = decodeEntityDeclaration(sessionEntityRegistration);

export interface SessionManifestReadResult {
  readonly format: "manifest";
  readonly manifest: SessionManifest;
}

export interface LegacySessionReadResult {
  readonly format: "legacy";
  readonly legacy: true;
  readonly metadata: {
    readonly schema: "provenance-session/v1";
    readonly sessionId: string;
    readonly runtime: string;
    readonly source: string;
    readonly detectedAt: string;
    readonly exportedAt: string;
    readonly user?: string;
  };
  readonly body: string;
}

export type SessionReadResult = SessionManifestReadResult | LegacySessionReadResult;

export function writeSessionEntity(
  coordinator: WriteCoordinator,
  _rootInput: HarnessLayoutInput,
  manifest: SessionManifest,
  options: { readonly flush?: boolean; readonly opIdPrefix?: string } = {}
): Effect.Effect<void, WriteError> {
  return writeDeclaredEntity(
    coordinator,
    stablePayloadHash,
    sessionEntityDeclaration,
    { sessionId: manifest.sessionId },
    manifest,
    options
  );
}

export function readSessionEntityDocument(rootInput: HarnessLayoutInput, sessionId: string): SessionReadResult {
  const manifestPath = resolveEntityDocumentPath(rootInput, sessionEntityDeclaration, { sessionId });
  const document = localLayoutFileSystem.readText(manifestPath);
  if (document.startsWith("---\n") || document.startsWith("---\r\n")) {
    return readLegacySession(document, sessionId);
  }
  const manifest = Schema.decodeUnknownSync(SessionManifestSchema)(
    sessionEntityDeclaration.documentCodec.decode(document)
  );
  if (manifest.sessionId !== sessionId) throw new Error(`session id mismatch: ${manifest.sessionId}`);
  return {
    format: "manifest",
    manifest
  };
}

function readLegacySession(body: string, expectedSessionId: string): LegacySessionReadResult {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter) throw new Error("session markdown missing frontmatter");
  const schema = readScalar(frontmatter, "schema", { required: true });
  if (schema !== "provenance-session/v1") throw new Error(`unsupported session schema: ${schema}`);
  const sessionId = readScalar(frontmatter, "sessionId", { required: true });
  if (sessionId !== expectedSessionId) throw new Error(`session id mismatch: ${sessionId}`);
  const runtime = readScalar(frontmatter, "runtime", { required: true });
  if (runtime !== "human" && !/^### (?:User|Assistant|Summary)(?: \(|$)/mu.test(body)) {
    throw new Error(`session transcript unavailable: ${sessionId}`);
  }
  const user = readScalar(frontmatter, "user");
  return {
    format: "legacy",
    legacy: true,
    metadata: {
      schema,
      sessionId,
      runtime,
      source: readScalar(frontmatter, "source", { required: true }),
      detectedAt: readScalar(frontmatter, "detectedAt", { required: true }),
      exportedAt: readScalar(frontmatter, "exportedAt", { required: true }),
      ...(user ? { user } : {})
    },
    body
  };
}
