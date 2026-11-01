import {
  isDecisionEvent,
  isMigrationImportEvent,
  type CanonicalEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { isSettingsEvent } from "@harness-anything/kernel/internal/domain/settings-event.ts";
import { writeRepositorySettingsFacet } from "@harness-anything/kernel/internal/domain/settings.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentMode,
  canonicalDocumentRetirements,
} from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
import {
  TaskEventStoreError,
  type CanonicalWriteBundle,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";

export type DocumentNode = {
  readonly body: string | Uint8Array;
  readonly sha256: string;
  readonly size: number;
  readonly nodeKind: "file" | "symbolic-link";
};
export type DocumentHead = Omit<DocumentNode, "body">;

export interface DocumentReplacementState {
  readonly eventExists: (opId: string) => boolean;
  readonly documentHead: (target: string) => DocumentHead | "retired" | undefined;
  readonly readContentObject: (sha256: string) => Uint8Array | null;
  readonly local: (target: string) => DocumentNode | null;
}

export function requiresReplacementAuthorization(event: CanonicalEventV1): boolean {
  return (
    isDecisionEvent(event) ||
    isSettingsEvent(event) ||
    canonicalDocumentRetirements(event).length > 0 ||
    (isMigrationImportEvent(event) &&
      event.payload.entity.kind === "repo-document" &&
      event.payload.entity.destinationPreimage !== undefined)
  );
}

export function assertAuthorizedReplacements(
  store: DocumentReplacementState,
  members: readonly CanonicalWriteBundle[],
): void {
  if (!members.some(({ event }) => requiresReplacementAuthorization(event))) return;
  const pending = new Map<string, DocumentNode | null>(),
    local = store.local,
    current = (target: string): DocumentHead | null => {
      if (pending.has(target)) return pending.get(target)!;
      const head = store.documentHead(target);
      if (head === "retired") return null;
      // Only a never-claimed bootstrap document can take its baseline from authored bytes.
      if (head === undefined) return local(target);
      return head;
    };
  for (const member of members) {
    if (store.eventExists(member.event.opId)) continue; // The ledger still verifies the replay's exact intent digest.
    authorize(member, current, local, (target) => {
      if (pending.has(target)) return pending.get(target)?.body ?? null;
      const head = store.documentHead(target);
      if (head === "retired") return null;
      if (head === undefined) return local(target)?.body ?? null;
      const bytes = store.readContentObject(head.sha256);
      if (bytes === null) throw new TaskEventStoreError("invalid_store", `Missing content for ${target}`);
      return bytes;
    });
    for (const claim of canonicalDocumentClaims(member.event)) {
      const blob = member.blobs.find((candidate) => candidate.sha256 === claim.sha256);
      if (!blob) throw new TaskEventStoreError("invalid_write_plan", `Missing candidate for ${claim.path}`);
      pending.set(claim.path, {
        ...claim,
        body: blob.body,
        nodeKind: canonicalDocumentMode(member.event, claim.path) === "120000" ? "symbolic-link" : "file",
      });
    }
    for (const claim of canonicalDocumentRetirements(member.event)) pending.set(claim.path, null);
  }
}

function authorize(
  member: CanonicalWriteBundle,
  current: (target: string) => DocumentHead | null,
  local: (target: string) => DocumentNode | null,
  readBody: (target: string) => string | Uint8Array | null,
): void {
  const { event, blobs } = member;
  if (isDecisionEvent(event)) {
    const base = current(event.payload.decisionDocumentClaim.path);
    if (event.payload.baseDocumentSha256 !== (base?.sha256 ?? null))
      throw new TaskEventStoreError("revision_conflict", `Decision ${event.decisionId} document base changed`);
    return;
  }
  if (isSettingsEvent(event)) {
    const target = event.payload.harnessDocumentClaim.path;
    let body: string | Uint8Array | null;
    if (current(target)?.sha256 === event.payload.baseDocumentSha256) body = readBody(target);
    else {
      // A Settings write may also base itself on the live authored bytes — harness.yaml is its
      // declaration surface — when they diverge from the ledger head. Anything else moved
      // mid-write and is a conflict.
      const node = local(target);
      if (node === null || node.sha256 !== event.payload.baseDocumentSha256)
        throw new TaskEventStoreError("revision_conflict", "harness.yaml changed before the Settings write committed");
      body = node.body;
    }
    if (body === null) throw new TaskEventStoreError("invalid_store", "Missing settings base content");
    const baseBody =
        typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
      candidate = blobs.find((blob) => blob.sha256 === event.payload.harnessDocumentClaim.sha256)?.body;
    if (typeof candidate !== "string" || candidate !== writeRepositorySettingsFacet(baseBody, event.payload.settings))
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "Settings may change only their owned harness.yaml facet fields",
      );
    return;
  }
  for (const retirement of canonicalDocumentRetirements(event)) {
    const base = current(retirement.path);
    if (base?.nodeKind !== "file" || base.sha256 !== retirement.baseBlobSha256)
      throw new TaskEventStoreError(
        "revision_conflict",
        `Document retirement base changed at ${retirement.path}; run ha doc status and retry.`,
      );
  }
  if (
    isMigrationImportEvent(event) &&
    event.payload.entity.kind === "repo-document" &&
    event.payload.entity.destinationPreimage !== undefined
  ) {
    const entity = event.payload.entity,
      expected = entity.destinationPreimage!,
      same = (node: DocumentHead | null) =>
        node !== null &&
        node.nodeKind === expected.nodeKind &&
        node.sha256 === expected.sha256 &&
        node.size === expected.size;
    if (!same(current(entity.documentClaim.path)) || !same(local(entity.documentClaim.path)))
      throw new TaskEventStoreError(
        "revision_conflict",
        `Migration destination changed after conflict classification at ${entity.documentClaim.path}; ` +
          "rerun --dry-run and resolve the current node.",
      );
  }
}
