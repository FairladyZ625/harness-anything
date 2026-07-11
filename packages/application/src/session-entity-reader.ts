import {
  readContentAddressedTextBlob,
  readSessionEntityDocument,
  type HarnessLayoutInput,
  type SessionManifest
} from "../../kernel/src/index.ts";

export interface SessionEntityReadResult {
  readonly format: "manifest";
  readonly manifest: SessionManifest;
  readonly body: string;
}

export function readSessionEntity(
  rootInput: HarnessLayoutInput,
  sessionId: string
): SessionEntityReadResult | Exclude<ReturnType<typeof readSessionEntityDocument>, { readonly format: "manifest" }> {
  const result = readSessionEntityDocument(rootInput, sessionId);
  if (result.format === "legacy") return result;
  return {
    ...result,
    body: readContentAddressedTextBlob(rootInput, result.manifest.bodyRef)
  };
}
