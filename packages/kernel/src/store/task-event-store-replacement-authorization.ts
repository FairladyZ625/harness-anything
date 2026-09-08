import { isDecisionEvent, isMigrationImportEvent, type CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { isPeopleEvent } from "../domain/people-event.ts";
import { parsePeopleRosterDocument, serializePeopleRosterDocument } from "../domain/people-roster.ts";
import { isSettingsEvent } from "../domain/settings-event.ts";
import { writeRepositorySettingsFacet } from "../domain/settings.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { localGitWorktreeSettlement } from "./local-version-control-system.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import type { PortableDocumentPath } from "../layout/portable-path.ts";
import { resolveRetirableDocument } from "./ledger-document.ts";
import type { SqliteEventStore } from "./sqlite-event-store.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentMode,
  canonicalDocumentRetirements,
} from "./task-event-store-claims-layout.ts";
import { TaskEventStoreError, type CanonicalWriteBundle } from "./task-event-store-types.ts";

type DocumentNode = {
  readonly body: string | Uint8Array;
  readonly sha256: string;
  readonly size: number;
  readonly nodeKind: "file" | "symbolic-link";
};

export function assertAuthorizedReplacements(
  store: SqliteEventStore,
  input: HarnessLayoutInput,
  members: readonly CanonicalWriteBundle[],
): void {
  const requiresAuthorization = (event: CanonicalEventV1) =>
    isDecisionEvent(event) ||
    isSettingsEvent(event) ||
    isPeopleEvent(event) ||
    canonicalDocumentRetirements(event).length > 0 ||
    (isMigrationImportEvent(event) &&
      event.payload.entity.kind === "repo-document" &&
      event.payload.entity.destinationPreimage !== undefined);
  if (!members.some(({ event }) => requiresAuthorization(event))) return;
  const authoredRoot = resolveHarnessLayout(input).authoredRoot,
    pending = new Map<string, DocumentNode | null>(),
    local = (target: string): DocumentNode | null => {
      const node = localGitWorktreeSettlement.readNode(`${authoredRoot}/${target}`);
      return node && { ...node, nodeKind: node.mode === "120000" ? "symbolic-link" : "file" };
    },
    current = (target: string): DocumentNode | null => {
      if (pending.has(target)) return pending.get(target)!;
      // Search recent claims first without loading the entire ledger into memory.
      for (let end = store.revision(); end > 0; end = Math.max(0, end - 256)) {
        const start = Math.max(0, end - 256);
        for (const event of store.eventsAfter(start, end - start).toReversed()) {
          if (canonicalDocumentRetirements(event).some((claim) => claim.path === target)) return null;
          const claim = canonicalDocumentClaims(event).find((candidate) => candidate.path === target);
          if (!claim) continue;
          const bytes = store.readContentObject(claim.sha256);
          if (bytes === null) throw new TaskEventStoreError("invalid_store", `Missing content for ${target}`);
          return {
            ...claim,
            body: bytes,
            nodeKind: canonicalDocumentMode(event, target) === "120000" ? "symbolic-link" : "file",
          };
        }
      }
      // Legacy tracked documents can be retired after their worktree copy is removed.
      // This fallback runs only after proving that SQLite has never claimed/retired the path;
      // Git supplies the bootstrap preimage, never command acceptance.
      if (members.some(({ event }) => canonicalDocumentRetirements(event).some((claim) => claim.path === target))) {
        const historical = resolveRetirableDocument(input, target as PortableDocumentPath, null, []);
        if (historical !== null)
          return { body: historical.body, sha256: historical.blobSha256, size: historical.size, nodeKind: "file" };
      }
      // Only a never-claimed bootstrap document can take its baseline from authored bytes.
      return local(target);
    };
  for (const member of members) {
    if (store.event(member.event.opId)) continue; // SQLite still verifies the replay's exact intent digest.
    authorize(member, current, local);
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
  current: (target: string) => DocumentNode | null,
  local: (target: string) => DocumentNode | null,
): void {
  const { event, blobs } = member;
  if (isDecisionEvent(event)) {
    const base = current(event.payload.decisionDocumentClaim.path);
    if (event.payload.baseDocumentSha256 !== (base?.sha256 ?? null))
      throw new TaskEventStoreError("revision_conflict", `Decision ${event.decisionId} document base changed`);
    return;
  }
  if (isSettingsEvent(event)) {
    const base = current(event.payload.harnessDocumentClaim.path),
      candidate = blobs.find((blob) => blob.sha256 === event.payload.harnessDocumentClaim.sha256)?.body;
    if (base === null || typeof base.body !== "string" || sha256Text(base.body) !== event.payload.baseDocumentSha256)
      throw new TaskEventStoreError("revision_conflict", "harness.yaml changed before the Settings write committed");
    if (typeof candidate !== "string" || candidate !== writeRepositorySettingsFacet(base.body, event.payload.settings))
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "Settings may change only their owned harness.yaml facet fields",
      );
    return;
  }
  if (isPeopleEvent(event)) {
    const base = current(event.payload.peopleDocumentClaim.path),
      candidate = blobs.find((blob) => blob.sha256 === event.payload.peopleDocumentClaim.sha256)?.body;
    if ((base?.sha256 ?? null) !== event.payload.baseDocumentSha256)
      throw new TaskEventStoreError("revision_conflict", "people.yaml changed before the People write committed");
    if (
      typeof candidate !== "string" ||
      candidate !== serializePeopleRosterDocument(event.payload.roster) ||
      serializePeopleRosterDocument(parsePeopleRosterDocument(candidate)) !== candidate
    )
      throw new TaskEventStoreError("invalid_write_plan", "People may replace only the canonical people roster");
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
      same = (node: DocumentNode | null) =>
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
