import { mkdirSync, readdirSync, readSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, type TaskProjectionQueries } from "@harness-anything/kernel";
import { compactDispatchStreamArchive } from "./dispatch-stream-compaction.ts";
import { withReadOnlyFile } from "../../storage/src/durable-file.ts";

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
  evidenceSources: readonly string[],
  nowMs: number = Date.now(),
): void {
  if (retention.retentionDays <= 0 && retention.retentionBytes <= 0) return;
  const msPerDay = 86_400_000,
    streams = archivedDispatchStreams(rootDir),
    protectedPrefixes = factEvidenceDispatchPrefixes(evidenceSources),
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
  return withReadOnlyFile(file, (descriptor) => {
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
  });
}

/**
 * Dispatch-id prefixes that immutable fact evidence names under the archive path. Evidence may
 * name one id or a `{prefix,…}*` / `prefix*` glob, so entries shorter than a full id are kept as
 * prefixes. A wildcard marks where the id stops being spelled out; it is not part of the id. In
 * `{670215fc,…,c6f6af02}*` it follows the closing brace, so reading the entry as-is would turn
 * the last id into a non-hex string and silently drop it. Cut each entry at its first wildcard
 * instead — a glob naming an id prefix protects every id that starts with it.
 */
function factEvidenceDispatchPrefixes(evidenceSources: readonly string[]): readonly string[] {
  const prefixes = new Set<string>();
  for (const source of evidenceSources)
    for (const match of source.matchAll(/dispatches\/archive\/dispatch_([a-f0-9*,{}]+)/gu)) {
      for (const entry of match[1]!.replace(/[{}]/gu, "").split(",")) {
        const prefix = entry.split("*")[0]!;
        if (/^[a-f0-9]{8,24}$/u.test(prefix)) prefixes.add(prefix);
      }
    }
  return [...prefixes];
}

function factEvidenceNames(prefixes: readonly string[], dispatchId: string): boolean {
  return prefixes.some((prefix) => dispatchId.startsWith(`dispatch_${prefix}`));
}

/**
 * The evidence sources of every canonical Fact row, archived rows included. `ha fact archive`
 * retires the managed document while the row keeps its immutable evidenceSource, so the
 * protection input is the projection, not a scan of facts/*.md — a scan would stop seeing the
 * reference an archived Fact still holds and let retention delete the stream it names. Refuses
 * to answer on a projection that is not at the canonical cut: pruning against a short list of
 * evidence sources would delete streams live facts still name, so the caller skips the pass.
 */
export function readFactEvidenceSources(projection: Pick<TaskProjectionQueries, "searchFacts">): readonly string[] {
  const read = projection.searchFacts({});
  if (read.status !== "ready")
    throw new Error(
      `fact projection is not at the canonical cut (watermark ${read.watermark}, source revision ` +
        `${read.sourceRevision}); refusing to prune the dispatch archive against a partial evidence list`,
    );
  return read.facts.map((fact) => fact.evidenceSource);
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
