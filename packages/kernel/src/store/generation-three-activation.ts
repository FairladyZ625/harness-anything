import { randomUUID } from "node:crypto";
import path from "node:path";
import { localRuntimeStateFileSystem as files } from "../local/local-layout-file-system.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import type { LedgerCutIdentity } from "../domain/write-chain.contract.ts";
import { sqliteLedgerPath } from "./sqlite-event-store.ts";

export interface GenerationThreeActivation {
  readonly schema: "generation-activation/v3";
  readonly repoId: string;
  readonly generation: 3;
  readonly sourceCut: (LedgerCutIdentity & { readonly generation: 1 | 2 }) | null;
  readonly importedPrefixRevision: number;
  readonly acceptedCut: LedgerCutIdentity;
}

/** Publish only after target persistence and source retirement; link is the visibility point. */
export function publishGenerationThreeActivation(
  root: HarnessLayoutInput,
  certificate: GenerationThreeActivation,
): void {
  const finalPath = `${sqliteLedgerPath(root, 3)}.activation.json`,
    temporary = `${finalPath}.${randomUUID()}.tmp`;
  // The temporary is never a selectable certificate. Existing final names surface EEXIST;
  // neither an interrupted publication nor a second conversion may overwrite an activation.
  if (!files.createExclusiveText(temporary, `${JSON.stringify(certificate)}\n`, false))
    throw new Error("generation 3 temporary certificate already exists");
  try {
    files.linkExclusive(temporary, finalPath);
    files.syncDirectory(path.dirname(finalPath));
  } finally {
    files.remove(temporary);
  }
}
