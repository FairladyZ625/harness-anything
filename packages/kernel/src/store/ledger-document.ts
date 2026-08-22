import { classifyTextualArtifactPath } from "../domain/artifact-text-classification.ts";
import { docByteLength, type CanonicalEventV1, type DocumentState } from "../domain/doc-sync.contract.ts";
import { sha256Bytes } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import type { PortableDocumentPath } from "../layout/portable-path.ts";
import { ledgerGitPath, resolveLedgerGitLayout } from "./ledger-git-layout.ts";
import { localGitObjectRefStore } from "./local-version-control-system.ts";
import { canonicalDocumentClaims, canonicalDocumentRetirements } from "./task-event-store.ts";

/**
 * The one retirement identity shared by candidate scanning and `doc retire`.
 * A projected document wins; historical ledger debt remains a document when
 * its authored path is a regular textual file tracked at the ledger Git HEAD.
 */
export function resolveRetirableDocument(input: HarnessLayoutInput, logical: PortableDocumentPath, projected: DocumentState | null, events: readonly CanonicalEventV1[]): DocumentState | null {
  if (projected !== null) return projected;
  if (events.some((event) => canonicalDocumentClaims(event).some((claim) => claim.path === logical) || canonicalDocumentRetirements(event).some((retirement) => retirement.path === logical))) return null;
  const classification = classifyTextualArtifactPath(logical); if (classification === null) return null;
  const ledger = resolveLedgerGitLayout(input), target = ledgerGitPath(ledger, logical), head = localGitObjectRefStore.resolveCommit(ledger.rootDir, "HEAD"), entry = localGitObjectRefStore.listTree(ledger.rootDir, head, target).find((candidate) => candidate.target === target);
  if (entry?.mode !== "100644") return null;
  const bytes = localGitObjectRefStore.readPath(ledger.rootDir, head, target); if (bytes === null) return null;
  return { path: logical, blobSha256: sha256Bytes(bytes), body: bytes.toString("utf8"), size: docByteLength(bytes.byteLength), mediaType: classification.mediaType, policyId: classification.policyId, workspaceRevision: 0 };
}
