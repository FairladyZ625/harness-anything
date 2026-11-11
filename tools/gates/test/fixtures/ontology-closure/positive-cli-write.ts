import { unlinkSync } from "node:fs";
export function cleanupConsumedDocumentDescriptor(candidate: string) {
  unlinkSync(candidate);
}
