import { Schema } from "effect";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import { SessionManifestSchema, type SessionManifest } from "../schemas/session-manifest.ts";
import { decodeEntityDeclaration, resolveEntityDocumentPath } from "./declaration.ts";
import { sessionEntityRegistration } from "./session-declaration.ts";
export const sessionEntityDeclaration = decodeEntityDeclaration(sessionEntityRegistration);
export interface SessionManifestReadResult {
  readonly format: "manifest";
  readonly manifest: SessionManifest;
}
export function readSessionEntityDocument(rootInput: HarnessLayoutInput, sessionId: string): SessionManifestReadResult {
  const document = localLayoutFileSystem.readText(
    resolveEntityDocumentPath(rootInput, sessionEntityDeclaration, { sessionId }),
  );
  const manifest = Schema.decodeUnknownSync(SessionManifestSchema)(
    sessionEntityDeclaration.documentCodec.decode(document),
  );
  if (manifest.sessionId !== sessionId) throw new Error(`session id mismatch: ${manifest.sessionId}`);
  return { format: "manifest", manifest };
}
