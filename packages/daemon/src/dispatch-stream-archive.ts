import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { compactDispatchStreamArchive } from "./dispatch-stream-compaction.ts";

type Schedule = (work: () => void | Promise<void>) => void;

/** The repository's dispatch-archive retention policy. A limit of 0 disables that limit. */
export interface DispatchArchiveRetention {
  readonly retentionDays: number;
  readonly retentionBytes: number;
}

interface ArchivedStream {
  readonly dispatchId: string;
  readonly file: string;
  readonly sizeBytes: number;
  readonly startedAtMs: number;
}

/** Move a terminal stream out of the directory enumerated by live-runtime reads. */
export function archiveDispatchStream(rootDir: string, dispatchId: string): void {
  const { live, archived } = streamPaths(rootDir, dispatchId);
  if (statSync(live, { throwIfNoEntry: false })?.isFile()) {
    mkdirSync(path.dirname(archived), { recursive: true, mode: 0o700 });
    renameSync(live, archived);
  } else if (!statSync(archived, { throwIfNoEntry: false })?.isFile()) return;
  compactDispatchStreamArchive(archived, dispatchId);
}

/** Queue one local terminal archive at a time so existing writer work can run between files. */
export function scheduleArchivedDispatchStreamCompaction(rootDir: string, schedule: Schedule): void {
  const root = dispatchRoot(rootDir),
    archive = path.join(root, "archive");
  if (!statSync(archive, { throwIfNoEntry: false })?.isDirectory()) return;
  const dispatchIds = readdirSync(archive)
    .filter((name) => /^dispatch_[a-f0-9]{24}\.jsonl$/u.test(name))
    .map((name) => name.slice(0, -6))
    .sort();
  let nextIndex = 0;
  const enqueueNext = (): void => {
    const dispatchId = dispatchIds[nextIndex++];
    if (!dispatchId) return;
    schedule(() => {
      try {
        const archived = path.join(archive, `${dispatchId}.jsonl`);
        if (statSync(archived, { throwIfNoEntry: false })?.isFile()) compactDispatchStreamArchive(archived, dispatchId);
      } finally {
        enqueueNext();
      }
    });
  };
  enqueueNext();
}

/**
 * The one execution point of the dispatch-archive retention policy: delete archived terminal
 * streams past either limit. Only the archive directory is enumerated — live streams sit in the
 * dispatches root and are structurally out of reach — and every delete is keyed by dispatch id
 * against the file it names, so overlapping passes stay idempotent.
 *
 * A stream's age is the `startedAt` in its own header, never the file mtime: archiving compacts
 * the stream by rewriting it, and every rewrite refreshes mtime to the rewrite moment. mtime
 * therefore measures "when this file was last rewritten", not "when this run happened", and an
 * age limit on it would almost never fire on a real archive. The header travels inside the
 * stream and survives compaction, so it is the same signal before and after a rewrite.
 *
 * Streams named by immutable fact evidence are never deleted. Facts are the one reader whose
 * provenance is a hand-written, non-regenerable pointer into the archive; generated
 * `eventStreamRef` values are live-path snapshots that are already stale once a stream is
 * archived, and no reader opens them as files, so they do not hold a stream back.
 */
export function pruneDispatchStreamArchive(
  rootDir: string,
  retention: DispatchArchiveRetention,
  nowMs: number = Date.now(),
): void {
  if (retention.retentionDays <= 0 && retention.retentionBytes <= 0) return;
  const msPerDay = 86_400_000,
    streams = archivedDispatchStreams(rootDir),
    protectedPrefixes = factEvidenceDispatchPrefixes(rootDir),
    doomed = new Set<string>();
  if (retention.retentionDays > 0)
    for (const stream of streams)
      if (
        !factEvidenceNames(protectedPrefixes, stream.dispatchId) &&
        nowMs - stream.startedAtMs > retention.retentionDays * msPerDay
      )
        doomed.add(stream.dispatchId);
  if (retention.retentionBytes > 0) {
    // Oldest first (streams are startedAt-sorted). Protected streams still occupy disk, so their
    // bytes stay in the total; a cap those bytes alone exceed cannot be satisfied without
    // deleting evidence, and the archive stays over it rather than doing that.
    let total = streams.reduce((sum, stream) => sum + (doomed.has(stream.dispatchId) ? 0 : stream.sizeBytes), 0);
    for (const stream of streams) {
      if (total <= retention.retentionBytes) break;
      if (doomed.has(stream.dispatchId) || factEvidenceNames(protectedPrefixes, stream.dispatchId)) continue;
      total -= stream.sizeBytes;
      doomed.add(stream.dispatchId);
    }
  }
  for (const stream of streams) {
    if (!doomed.has(stream.dispatchId)) continue;
    // Re-check before deleting, like the compaction pass above: a dispatch purge may have taken
    // the file between the enumeration and this delete; either way the next pass re-enumerates.
    if (statSync(stream.file, { throwIfNoEntry: false })?.isFile()) unlinkSync(stream.file);
  }
}

function archivedDispatchStreams(rootDir: string): readonly ArchivedStream[] {
  const archive = path.join(dispatchRoot(rootDir), "archive");
  if (!statSync(archive, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(archive)
    .filter((name) => /^dispatch_[a-f0-9]{24}\.jsonl$/u.test(name))
    .map((name) => {
      const file = path.join(archive, name),
        stat = statSync(file, { throwIfNoEntry: false }),
        startedAtMs = stat?.isFile() ? archivedStartedAtMs(file) : NaN;
      return stat?.isFile() && Number.isFinite(startedAtMs)
        ? { dispatchId: name.slice(0, -6), file, sizeBytes: stat.size, startedAtMs }
        : null;
    })
    .filter((stream): stream is ArchivedStream => stream !== null)
    .sort((left, right) => left.startedAtMs - right.startedAtMs || left.dispatchId.localeCompare(right.dispatchId));
}

/** Read the age signal from the stream's own header line; the header is written by this daemon. */
function archivedStartedAtMs(file: string): number {
  const descriptor = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    while (true) {
      const chunk = Buffer.alloc(4096),
        read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const newline = chunk.subarray(0, read).indexOf(10);
      chunks.push(chunk.subarray(0, newline === -1 ? read : newline));
      if (newline !== -1) break;
    }
    const header: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const startedAt =
      header !== null && typeof header === "object" ? (header as { startedAt?: unknown }).startedAt : null;
    return typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Dispatch-id prefixes that immutable fact evidence names under the archive path. Facts live
 * under the ledger authored root and their Evidence source is never rewritten, so a retention
 * pass that deletes these files would turn that evidence into a dangling path with no way to
 * recover it. Evidence may name one id or a `{prefix,…}*` / `prefix*` glob, so entries shorter
 * than a full id are kept as prefixes.
 */
function factEvidenceDispatchPrefixes(rootDir: string): readonly string[] {
  const facts = path.join(resolveHarnessLayout(rootDir).authoredRoot, "facts");
  if (!statSync(facts, { throwIfNoEntry: false })?.isDirectory()) return [];
  const prefixes = new Set<string>();
  for (const name of readdirSync(facts).sort()) {
    if (!name.endsWith(".md")) continue;
    for (const match of readFileSync(path.join(facts, name), "utf8").matchAll(
      /dispatches\/archive\/dispatch_([a-f0-9*,{}]+)/gu,
    ))
      for (const token of match[1]!.replace(/[{}]/gu, "").split(","))
        if (/^[a-f0-9]{8,24}$/u.test(token)) prefixes.add(token);
  }
  return [...prefixes];
}

function factEvidenceNames(prefixes: readonly string[], dispatchId: string): boolean {
  return prefixes.some((prefix) => dispatchId.startsWith(`dispatch_${prefix}`));
}

function streamPaths(rootDir: string, dispatchId: string): { readonly live: string; readonly archived: string } {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) throw new Error("dispatch id is invalid");
  const root = dispatchRoot(rootDir);
  return {
    live: path.join(root, `${dispatchId}.jsonl`),
    archived: path.join(root, "archive", `${dispatchId}.jsonl`),
  };
}

function dispatchRoot(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).localRoot, "runtime", "dispatches");
}
