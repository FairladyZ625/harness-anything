import type { HarnessLayoutInput } from "../../../layout/index.ts";
import {
  removeContentAddressedBlob,
  writeContentAddressedBlobWithDisposition
} from "../../../persistence/blob/content-addressed-blob-store.ts";

export function applyWithCompensatedCasBody(
  rootInput: HarnessLayoutInput,
  blob: { readonly body: string; readonly mediaType: string } | undefined,
  applyDocuments: () => void
): void {
  const bodyWrite = blob
    ? writeContentAddressedBlobWithDisposition(rootInput, blob.body, blob.mediaType)
    : undefined;
  try {
    applyDocuments();
  } catch (error) {
    if (bodyWrite?.created) {
      try {
        removeContentAddressedBlob(rootInput, bodyWrite);
      } catch {
        // Keep the original document transaction failure. CAS GC can safely
        // inspect a body that could not be compensated here.
      }
    }
    throw error;
  }
}
