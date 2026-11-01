import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { DocSyncContractError } from "./doc-sync-types.ts";
import type { DocClaimRef } from "./doc-sync-types.ts";

export function docClaimRef(value: string): DocClaimRef {
  const normalized = normalizeRelativeDocumentPath(value);
  if (normalized !== value || !normalized.startsWith("doc-sync-claims/"))
    throw new DocSyncContractError("claim ref must be a canonical doc-sync-claims path");
  return normalized as unknown as DocClaimRef;
}
