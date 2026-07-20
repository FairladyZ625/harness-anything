import {
  readContentAddressedTextBlob,
  readSessionEntityDocument,
  type HarnessLayoutInput,
  type SessionManifest
} from "@harness-anything/kernel";

export interface SessionEntityReadResult {
  readonly format: "manifest";
  readonly manifest: SessionManifest;
  readonly body: string;
}

export function readSessionEntity(
  rootInput: HarnessLayoutInput,
  sessionId: string
): SessionEntityReadResult {
  const result = readSessionEntityDocument(rootInput, sessionId);
  return {
    ...result,
    body: readContentAddressedTextBlob(rootInput, result.manifest.bodyRef)
  };
}
