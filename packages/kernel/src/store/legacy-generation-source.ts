import path from "node:path";
import type { CanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { canonicalizeWriteValue, isRecord } from "../domain/write-chain.contract.ts";
import { sha256Bytes, sha256Text } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localEventFileSystem, localEvidenceFileSystem } from "../local/local-layout-file-system.ts";
import { ledgerGitPath, resolveLedgerGitLayout } from "./ledger-git-layout.ts";
import { localGitObjectRefStore } from "./local-version-control-system.ts";
import { CANONICAL_EVENT_REF, TaskEventStoreError } from "./task-event-store-types.ts";

export interface StoppedLegacySourceEvidenceV1 {
  readonly schema: "stopped-legacy-source-evidence/v1";
  readonly gitCommit: string;
  readonly gitRevision: number;
  readonly gitHeadDigest: string;
  readonly walRevision: number;
  readonly walHeadDigest: string | null;
  readonly walLastOffset: number;
}
export type LegacyEventEntry = { readonly bytes: string; readonly event: CanonicalEventV1 };

export function readStoppedLegacyGeneration(input: { readonly rootInput: HarnessLayoutInput }): {
  readonly eventEntries: readonly LegacyEventEntry[];
  readonly objects: readonly { readonly sha256: string; readonly size: number; readonly bytesBase64: string }[];
  readonly sourceEvidence: StoppedLegacySourceEvidenceV1;
} {
  const layout = resolveHarnessLayout(input.rootInput),
    ledger = resolveLedgerGitLayout(input.rootInput),
    commit = localGitObjectRefStore.resolveCommit(ledger.rootDir, CANONICAL_EVENT_REF),
    eventsRoot = ledgerGitPath(ledger, "events"),
    gitHeadBytes = localGitObjectRefStore.readPath(ledger.rootDir, commit, `${eventsRoot}/head.json`),
    gitHead = gitHeadBytes === null ? null : parseLegacyHead(gitHeadBytes.toString("utf8"), "Git"),
    gitEvents = localGitObjectRefStore
      .listTree(ledger.rootDir, commit, eventsRoot)
      .filter(({ target }) => target !== `${eventsRoot}/head.json` && target.endsWith(".json"))
      .map(({ mode, target }) => {
        if (mode !== "100644")
          throw new TaskEventStoreError("invalid_store", `legacy Git event ${target} has invalid mode ${mode}`);
        const bytes = localGitObjectRefStore.readPath(ledger.rootDir, commit, target);
        if (bytes === null) throw new TaskEventStoreError("invalid_store", `legacy Git event ${target} disappeared`);
        const entry = decodeLegacyEventBytes(bytes.toString("utf8"), target),
          fileOpId = path.posix.basename(target).slice(0, -5);
        if (entry.event.opId !== fileOpId)
          throw new TaskEventStoreError("invalid_store", `legacy Git event ${target} does not match its opId`);
        return entry;
      })
      .sort((left, right) => left.event.workspaceRevision - right.event.workspaceRevision),
    wal = readStoppedWal(layout.rootDir),
    merged = mergeStoppedEvents(gitEvents, wal.events),
    objects = readStoppedObjects(ledger, commit, layout.rootDir),
    sourceEvidence: StoppedLegacySourceEvidenceV1 = {
      schema: "stopped-legacy-source-evidence/v1",
      gitCommit: commit,
      gitRevision: gitHead?.revision ?? 0,
      gitHeadDigest: gitHeadBytes === null ? `sha256:${sha256Text("null\n")}` : `sha256:${sha256Bytes(gitHeadBytes)}`,
      walRevision: wal.revision,
      walHeadDigest: wal.headDigest,
      walLastOffset: wal.lastOffset,
    };
  assertLegacySequence(merged, gitHead?.revision ?? 0, wal.revision);
  assertWalPrefixAnchor(gitEvents, wal);
  if (
    gitHead !== null &&
    (gitEvents.at(-1)?.event.workspaceRevision !== gitHead.revision ||
      gitEvents.at(-1)?.event.opId !== gitHead.opId ||
      `sha256:${sha256Text(gitEvents.at(-1)!.bytes)}` !== gitHead.eventDigest)
  )
    throw new TaskEventStoreError("invalid_store", "legacy Git head does not match event bytes");
  if (localGitObjectRefStore.resolveCommit(ledger.rootDir, CANONICAL_EVENT_REF) !== commit)
    throw new TaskEventStoreError("invalid_store", "legacy canonical Git ref changed while snapshotting");
  if (wal.headBody !== readOptionalText(path.join(layout.rootDir, ".harness", "wal", "head.json")))
    throw new TaskEventStoreError("invalid_store", "legacy WAL head changed while snapshotting");
  return { eventEntries: merged, objects, sourceEvidence };
}

export function decodeLegacyEventBytes(body: string, source: string): LegacyEventEntry {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new TaskEventStoreError("invalid_store", `${source} is not JSON`);
  }
  if (
    !isRecord(value) ||
    typeof value.schema !== "string" ||
    typeof value.opId !== "string" ||
    !Number.isSafeInteger(value.workspaceRevision) ||
    Number(value.workspaceRevision) < 1
  )
    throw new TaskEventStoreError("invalid_store", `${source} has an invalid legacy event envelope`);
  const canonical = `${JSON.stringify(canonicalizeWriteValue(value))}\n`;
  if (canonical !== body) throw new TaskEventStoreError("invalid_store", `${source} event bytes are not canonical`);
  return { bytes: body, event: value as unknown as CanonicalEventV1 };
}

function parseLegacyHead(
  body: string,
  source: string,
): { readonly revision: number; readonly opId: string; readonly eventDigest: string } {
  const value = JSON.parse(body) as unknown;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.opId !== "string" ||
    typeof value.eventDigest !== "string"
  )
    throw new TaskEventStoreError("invalid_store", `${source} event head is invalid`);
  return { revision: Number(value.revision), opId: value.opId, eventDigest: value.eventDigest };
}

function readStoppedWal(rootDir: string): {
  readonly events: readonly LegacyEventEntry[];
  readonly revision: number;
  readonly headDigest: string | null;
  readonly lastOffset: number;
  readonly headBody: string | null;
  readonly firstPreviousDigest: string | null | undefined;
} {
  const walRoot = path.join(rootDir, ".harness", "wal"),
    headPath = path.join(walRoot, "head.json"),
    headBody = readOptionalText(headPath);
  if (headBody === null)
    return {
      events: [],
      revision: 0,
      headDigest: null,
      lastOffset: 0,
      headBody,
      firstPreviousDigest: undefined,
    };
  const head = JSON.parse(headBody) as unknown;
  if (
    !isRecord(head) ||
    head.schema !== "harness-wal-head/v1" ||
    !Number.isSafeInteger(head.revision) ||
    Number(head.revision) < 0 ||
    !Number.isSafeInteger(head.lastOffset) ||
    Number(head.lastOffset) < 0 ||
    (Number(head.revision) === 0 ? head.lastSegment !== null : head.lastSegment !== "seg-000000.log") ||
    (Number(head.revision) === 0 && (Number(head.lastOffset) !== 0 || head.headDigest !== null)) ||
    (head.headDigest !== null && typeof head.headDigest !== "string")
  )
    throw new TaskEventStoreError("invalid_store", "legacy WAL head is invalid");
  const revision = Number(head.revision),
    lastOffset = Number(head.lastOffset),
    segmentPath = path.join(walRoot, "seg-000000.log"),
    segment = revision === 0 ? Buffer.alloc(0) : Buffer.from(localEvidenceFileSystem.readBytes(segmentPath)),
    durableBytes = segment.subarray(0, lastOffset),
    durable = new TextDecoder("utf-8", { fatal: true }).decode(durableBytes);
  if (durableBytes.byteLength !== lastOffset || (durable && !durable.endsWith("\n")))
    throw new TaskEventStoreError("invalid_store", "legacy WAL durable offset splits a record");
  let previous: string | null | undefined, firstPreviousDigest: string | null | undefined;
  const events = durable
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const record = JSON.parse(line) as unknown;
      if (
        !isRecord(record) ||
        record.schema !== "harness-wal/v1" ||
        typeof record.eventDigest !== "string" ||
        (previous !== undefined && record.previousDigest !== previous)
      )
        throw new TaskEventStoreError("invalid_store", `legacy WAL record ${index + 1} is invalid or discontinuous`);
      if (index === 0) firstPreviousDigest = record.previousDigest === null ? null : String(record.previousDigest);
      const bytes = `${JSON.stringify(canonicalizeWriteValue(record.event))}\n`,
        entry = decodeLegacyEventBytes(bytes, `legacy WAL record ${index + 1}`),
        digest = `sha256:${sha256Text(bytes)}`;
      if (
        digest !== record.eventDigest ||
        entry.event.workspaceRevision !== record.revision ||
        entry.event.opId !== record.opId
      )
        throw new TaskEventStoreError("invalid_store", `legacy WAL record ${index + 1} event digest differs`);
      previous = digest;
      return entry;
    });
  if (events.at(-1)?.event.workspaceRevision !== revision || (events.length > 0 && previous !== head.headDigest))
    throw new TaskEventStoreError("invalid_store", "legacy WAL head does not match durable records");
  return {
    events,
    revision,
    headDigest: head.headDigest as string | null,
    lastOffset,
    headBody,
    firstPreviousDigest,
  };
}

function assertWalPrefixAnchor(gitEvents: readonly LegacyEventEntry[], wal: ReturnType<typeof readStoppedWal>): void {
  const first = wal.events[0];
  if (first === undefined) return;
  const revision = first.event.workspaceRevision,
    expected = revision === 1 ? null : gitEvents[revision - 2]?.bytes;
  if (
    expected === undefined ||
    wal.firstPreviousDigest !== (expected === null ? null : `sha256:${sha256Text(expected)}`)
  )
    throw new TaskEventStoreError("invalid_store", `legacy WAL suffix is not anchored before revision ${revision}`);
}

function mergeStoppedEvents(
  gitEvents: readonly LegacyEventEntry[],
  walEvents: readonly LegacyEventEntry[],
): readonly LegacyEventEntry[] {
  const merged = [...gitEvents];
  for (const entry of walEvents) {
    const index = entry.event.workspaceRevision - 1;
    if (index < merged.length) {
      if (merged[index]!.bytes !== entry.bytes)
        throw new TaskEventStoreError("invalid_store", `legacy Git and WAL differ at revision ${index + 1}`);
    } else if (index === merged.length) merged.push(entry);
    else throw new TaskEventStoreError("invalid_store", `legacy WAL leaves a gap before revision ${index + 1}`);
  }
  return merged;
}

function assertLegacySequence(events: readonly LegacyEventEntry[], gitRevision: number, walRevision: number): void {
  const opIds = new Set<string>();
  for (const [index, entry] of events.entries()) {
    if (entry.event.workspaceRevision !== index + 1 || opIds.has(entry.event.opId))
      throw new TaskEventStoreError("invalid_store", `legacy event sequence differs at revision ${index + 1}`);
    opIds.add(entry.event.opId);
  }
  if (events.length !== Math.max(gitRevision, walRevision))
    throw new TaskEventStoreError("invalid_store", "legacy source heads do not reach the merged history");
}

function readStoppedObjects(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  commit: string,
  rootDir: string,
): readonly { readonly sha256: string; readonly size: number; readonly bytesBase64: string }[] {
  const objects = new Map<string, Buffer>(),
    prefix = ledgerGitPath(ledger, "objects/sha256");
  for (const { mode, target } of localGitObjectRefStore.listTree(ledger.rootDir, commit, prefix)) {
    const sha256 = target.slice(prefix.length + 1).replace("/", ""),
      bytes = localGitObjectRefStore.readPath(ledger.rootDir, commit, target);
    if (mode !== "100644" || !/^[0-9a-f]{64}$/u.test(sha256) || bytes === null || sha256Bytes(bytes) !== sha256)
      throw new TaskEventStoreError("invalid_store", `legacy Git content object ${target} is invalid`);
    objects.set(sha256, bytes);
  }
  const walObjects = path.join(rootDir, ".harness", "wal", "objects");
  if (localEventFileSystem.exists(walObjects))
    for (const name of localEventFileSystem.readNames(walObjects)) {
      const bytes = Buffer.from(localEvidenceFileSystem.readBytes(path.join(walObjects, name)));
      if (!/^[0-9a-f]{64}$/u.test(name) || sha256Bytes(bytes) !== name)
        throw new TaskEventStoreError("invalid_store", `legacy WAL content object ${name} is invalid`);
      const prior = objects.get(name);
      if (prior && !prior.equals(bytes))
        throw new TaskEventStoreError("invalid_store", `legacy object ${name} differs`);
      objects.set(name, bytes);
    }
  return [...objects]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sha256, bytes]) => ({ sha256, size: bytes.byteLength, bytesBase64: bytes.toString("base64") }));
}

function readOptionalText(inputPath: string): string | null {
  return localEventFileSystem.exists(inputPath) ? localEventFileSystem.readText(inputPath) : null;
}
