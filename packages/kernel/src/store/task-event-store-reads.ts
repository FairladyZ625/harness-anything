import path from "node:path";
import {
  parseCanonicalEvent,
  serializeCanonicalEvent,
  type CanonicalEventV1,
  type LedgerCommitSha,
} from "../domain/doc-sync.contract.ts";
import { serializeEventHead, type EventHead, type LedgerCutIdentity } from "../domain/write-chain.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { ledgerGitPath, type LedgerGitLayout } from "./ledger-git-layout.ts";
import { localGitObjectRefStore as gitObjects } from "./local-version-control-system.ts";
import type {
  CanonicalEventAppendReceipt,
  CanonicalEventCut,
  CanonicalEventStreamV1,
  EventFileBatch,
} from "./task-event-store-types.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import {
  blobObjectPath,
  blobObjectPaths,
  cachedBatchEventEntries,
  type EventEntry,
  eventEntries,
  eventObjectPaths,
  firstEntryAfter,
  readFirstPathAt,
  safeOpId,
} from "./task-event-store-layout.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";
import { message, shapeError, showText } from "./task-event-store-materialization.ts";

// Canonical stream, event/blob, and ledger-cut reads.
export function canonicalEventCut(repoId: string, event: CanonicalEventV1): CanonicalEventCut {
  const head: EventHead = {
    revision: event.workspaceRevision,
    opId: event.opId,
    eventDigest: `sha256:${sha256Text(serializeCanonicalEvent(event))}`,
  };
  return {
    repoId,
    revision: event.workspaceRevision,
    opId: event.opId,
    headDigest: `sha256:${sha256Text(serializeEventHead(head))}`,
  };
}
export function canonicalLedgerCut(repoId: string, head: EventHead | null): LedgerCutIdentity {
  return {
    repoId,
    revision: head?.revision ?? 0,
    headDigest: `sha256:${sha256Text(head === null ? "null\n" : serializeEventHead(head))}`,
  };
}
export function receipt(
  event: CanonicalEventV1,
  commitSha: LedgerCommitSha,
  started: number,
  changedPaths: readonly string[],
  nodeSyncs = 0,
): CanonicalEventAppendReceipt {
  return {
    status: "applied",
    event,
    revision: event.workspaceRevision,
    commitSha,
    cut: canonicalEventCut(commitSha.repoId, event),
    metrics: {
      gitProcesses: gitObjects.processCount() - started,
      nodeSyncs,
      changedPaths,
    },
  };
}
export function readStream(ledger: LedgerGitLayout, commit: string, head: EventHead | null): CanonicalEventStreamV1 {
  if (head === null) return { schema: "canonical-event-stream/v1", revision: 0, events: [] };
  const events = readEventsAt(ledger, commit, eventEntries(ledger, commit)).sort(
    (a, b) => a.workspaceRevision - b.workspaceRevision,
  );
  validateStreamContent(ledger, commit, events);
  const opIds = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.workspaceRevision !== index + 1)
      throw new TaskEventStoreError("invalid_store", `event revision ${event.workspaceRevision} is not contiguous`);
    if (opIds.has(event.opId)) throw new TaskEventStoreError("op_conflict", `duplicate event opId ${event.opId}`);
    opIds.add(event.opId);
  }
  if (events.length !== head.revision || events.at(-1)?.opId !== head.opId)
    throw new TaskEventStoreError("invalid_store", "event head does not match committed events");
  return {
    schema: "canonical-event-stream/v1",
    revision: head.revision,
    events,
  };
}
export function readBatch(
  ledger: LedgerGitLayout,
  commit: string,
  head: EventHead | null,
  cursor: string | null,
  maxItems: number,
): EventFileBatch {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 64)
    throw new TaskEventStoreError("invalid_store", "event batch maxItems must be between 1 and 64");
  const entries = cachedBatchEventEntries(ledger, commit),
    start = cursor === null ? 0 : firstEntryAfter(entries, cursor),
    selected = entries.slice(start, start + maxItems),
    sourceRevision = head?.revision ?? 0,
    events = readEventsAt(ledger, commit, selected).filter((event) => event.workspaceRevision <= sourceRevision);
  return {
    sourceRevision,
    events,
    cursor: selected.at(-1)?.name ?? cursor,
    done: start + selected.length === entries.length,
    accessedItems: selected.length,
    prefetchContent: (replay) => prefetchEventContent(ledger, commit, replay),
  };
}
export function readEventsAt(
  ledger: LedgerGitLayout,
  commit: string,
  entries: readonly EventEntry[],
): CanonicalEventV1[] {
  if (!entries.length) return [];
  const output = gitObjects.batch(ledger.rootDir, `${entries.map((entry) => entry.oid).join("\n")}\n`);
  const events: CanonicalEventV1[] = [];
  let cursor = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(10, cursor),
      size = Number(output.subarray(cursor, headerEnd).toString("utf8").split(" ").at(-1)),
      start = headerEnd + 1,
      body = output.subarray(start, start + size).toString("utf8");
    const event = parseCanonicalEvent(body);
    if (event.opId !== path.posix.basename(entry.name).slice(0, -5))
      throw new TaskEventStoreError("invalid_store", "event object names do not match canonical event bytes");
    events.push(event);
    cursor = start + size + 1;
  }
  return events;
}
export function readEventAt(ledger: LedgerGitLayout, commit: string, opId: string): CanonicalEventV1 | null {
  safeOpId(opId);
  const bytes = readFirstPathAt(ledger.rootDir, commit, eventObjectPaths(ledger, opId));
  if (bytes === null) return null;
  const body = Buffer.from(bytes).toString("utf8");
  let event: CanonicalEventV1;
  try {
    event = parseCanonicalEvent(body);
  } catch (error) {
    throw shapeError(body, message(error));
  }
  if (event.opId !== opId) throw new TaskEventStoreError("invalid_store", `event object does not match opId ${opId}`);
  validateEventBlobs(ledger, commit, event);
  return event;
}
export function validateEventBlobs(
  ledger: LedgerGitLayout,
  commit: string,
  event: CanonicalEventV1,
  files: readonly { target: string; body: string }[] = [],
): void {
  for (const claim of contentClaims(event)) {
    const changed = files.find((file) => file.target === blobObjectPath(ledger, claim.sha256)),
      blob = changed ? Buffer.from(changed.body) : readBlobAt(ledger, commit, claim.sha256);
    assertBlobExact(blob, claim);
  }
}
export function prefetchEventContent(
  ledger: LedgerGitLayout,
  commit: string,
  events: readonly CanonicalEventV1[],
): ReadonlyMap<string, Uint8Array | null> {
  const claims = [
      ...new Map(
        events.flatMap((event) => contentClaims(event)).map((claim) => [claim.sha256, claim] as const),
      ).values(),
    ],
    blobs = readBlobsAt(
      ledger,
      commit,
      claims.map(({ sha256 }) => sha256),
    );
  for (const claim of claims) assertBlobExact(blobs.get(claim.sha256) ?? null, claim);
  return blobs;
}
export function validateStreamContent(
  ledger: LedgerGitLayout,
  commit: string,
  events: readonly CanonicalEventV1[],
): void {
  const claims = [
    ...new Map(events.flatMap((event) => contentClaims(event)).map((claim) => [claim.sha256, claim] as const)).values(),
  ];
  let chunk: typeof claims = [],
    bytes = 0;
  const validate = () => {
    if (!chunk.length) return;
    const blobs = readBlobsAt(
      ledger,
      commit,
      chunk.map(({ sha256 }) => sha256),
    );
    for (const claim of chunk) assertBlobExact(blobs.get(claim.sha256) ?? null, claim);
    chunk = [];
    bytes = 0;
  };
  for (const claim of claims) {
    if (chunk.length >= 512 || bytes + claim.size > 64 * 1024 * 1024) validate();
    chunk.push(claim);
    bytes += claim.size;
  }
  validate();
}
export function assertBlobExact(
  blob: Uint8Array | null,
  claim: { readonly sha256: string; readonly size: number },
): void {
  if (
    blob === null ||
    blob.byteLength !== claim.size ||
    sha256Text(Buffer.from(blob).toString("utf8")) !== claim.sha256
  )
    throw new TaskEventStoreError("invalid_store", `event content blob ${claim.sha256} is not reachable and exact`);
}
export function readHeadAt(ledger: LedgerGitLayout, commit: string): EventHead | null {
  const body = showText(ledger.rootDir, commit, ledgerGitPath(ledger, "events/head.json"));
  if (body === null) return null;
  let head: EventHead;
  try {
    head = JSON.parse(body) as EventHead;
  } catch {
    throw new TaskEventStoreError("invalid_store", "event head is not JSON");
  }
  if (serializeEventHead(head) !== body) throw new TaskEventStoreError("invalid_store", "event head is not canonical");
  return head;
}
export function readBlobAt(ledger: LedgerGitLayout, commit: string, sha256: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new TaskEventStoreError("invalid_store", "content blob hash is invalid");
  return readFirstPathAt(ledger.rootDir, commit, blobObjectPaths(ledger, sha256));
}
export function readBlobsAt(
  ledger: LedgerGitLayout,
  commit: string,
  hashes: readonly string[],
): ReadonlyMap<string, Uint8Array | null> {
  const unique = [...new Set(hashes)];
  if (!unique.length) return new Map();
  for (const hash of unique)
    if (!/^[0-9a-f]{64}$/u.test(hash)) throw new TaskEventStoreError("invalid_store", "content blob hash is invalid");
  const output = gitObjects.batch(
      ledger.rootDir,
      `${unique.flatMap((hash) => blobObjectPaths(ledger, hash).map((target) => `${commit}:${target}`)).join("\n")}\n`,
    ),
    result = new Map<string, Uint8Array | null>();
  let cursor = 0;
  for (const hash of unique) {
    let value: Uint8Array | null = null;
    for (const _spelling of blobObjectPaths(ledger, hash)) {
      const headerEnd = output.indexOf(10, cursor),
        header = output.subarray(cursor, headerEnd).toString("utf8");
      if (header.endsWith(" missing")) cursor = headerEnd + 1;
      else {
        const size = Number(header.split(" ").at(-1)),
          start = headerEnd + 1;
        if (value === null) value = output.subarray(start, start + size);
        cursor = start + size + 1;
      }
    }
    result.set(hash, value);
  }
  return result;
}
export function canonicalRevisionAt(ledger: LedgerGitLayout, current: string, commit: string): number | null {
  if (!/^[0-9a-f]{40}$/u.test(commit) || !gitObjects.isAncestor(ledger.rootDir, commit, current)) return null;
  return readHeadAt(ledger, commit)?.revision ?? 0;
}
