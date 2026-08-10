import { Effect, Schema } from "effect";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import type { WriteControl, WriteCoordinator } from "../ports/index.ts";
import { SessionManifestSchema, type SessionManifest } from "../schemas/session-manifest.ts";
import { decodeEntityDeclaration, resolveEntityDocumentPath, writeDeclaredEntity } from "./declaration.ts";
import { sessionEntityRegistration } from "./session-declaration.ts";

export const sessionEntityDeclaration = decodeEntityDeclaration(sessionEntityRegistration);

export interface SessionManifestReadResult {
  readonly format: "manifest";
  readonly manifest: SessionManifest;
}

export function writeSessionEntity(
  coordinator: WriteCoordinator,
  _rootInput: HarnessLayoutInput,
  manifest: SessionManifest,
  options: { readonly flush?: boolean; readonly opIdPrefix?: string } = {}
): Effect.Effect<void, WriteControl> {
  return writeDeclaredEntity(
    coordinator,
    stablePayloadHash,
    sessionEntityDeclaration,
    { sessionId: manifest.sessionId },
    manifest,
    options
  );
}

export function readSessionEntityDocument(rootInput: HarnessLayoutInput, sessionId: string): SessionManifestReadResult {
  const manifestPath = resolveEntityDocumentPath(rootInput, sessionEntityDeclaration, { sessionId });
  const document = localLayoutFileSystem.readText(manifestPath);
  const manifest = Schema.decodeUnknownSync(SessionManifestSchema)(
    sessionEntityDeclaration.documentCodec.decode(document)
  );
  if (manifest.sessionId !== sessionId) throw new Error(`session id mismatch: ${manifest.sessionId}`);
  return {
    format: "manifest",
    manifest
  };
}
