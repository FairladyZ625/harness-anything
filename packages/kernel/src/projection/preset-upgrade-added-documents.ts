import { docByteLength, documentPath, type DocumentState } from "../domain/doc-sync.contract.ts";
import type { InitialDocumentClaim } from "../domain/task-bootstrap-event.ts";

export function projectPresetUpgradeDocuments(
  claims: readonly InitialDocumentClaim[],
  workspaceRevision: number,
  readBlob: (sha256: string) => Uint8Array | null,
  writeDocument: (document: DocumentState) => void,
): void {
  for (const claim of claims) {
    const bytes = readBlob(claim.sha256);
    if (!bytes || bytes.byteLength !== claim.size) throw new Error(`document blob ${claim.sha256} is unavailable`);
    writeDocument({
      path: documentPath(claim.path),
      blobSha256: claim.sha256,
      body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      size: docByteLength(claim.size),
      mediaType: claim.mediaType,
      policyId: claim.policyId,
      workspaceRevision,
    });
  }
}
