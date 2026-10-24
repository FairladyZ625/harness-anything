import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
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
  readonly mtimeMs: number;
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
 * against the file it names, so overlapping passes stay idempotent. A stream's age is its file
 * mtime: rename preserves the terminal write's mtime and a compaction rewrite refreshes it, so
 * either way mtime is the moment the stream last changed.
 */
export function pruneDispatchStreamArchive(
  rootDir: string,
  retention: DispatchArchiveRetention,
  nowMs: number = Date.now(),
): void {
  const msPerDay = 86_400_000,
    streams = archivedDispatchStreams(path.join(dispatchRoot(rootDir), "archive")),
    doomed = new Set<string>();
  if (retention.retentionDays > 0)
    for (const stream of streams)
      if (nowMs - stream.mtimeMs > retention.retentionDays * msPerDay) doomed.add(stream.dispatchId);
  if (retention.retentionBytes > 0) {
    // Oldest first (streams are mtime-sorted), never counting streams the age pass already doomed.
    let total = streams.reduce((sum, stream) => sum + (doomed.has(stream.dispatchId) ? 0 : stream.sizeBytes), 0);
    for (const stream of streams) {
      if (total <= retention.retentionBytes) break;
      if (doomed.has(stream.dispatchId)) continue;
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

function archivedDispatchStreams(archive: string): readonly ArchivedStream[] {
  if (!statSync(archive, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(archive)
    .filter((name) => /^dispatch_[a-f0-9]{24}\.jsonl$/u.test(name))
    .map((name) => {
      const file = path.join(archive, name),
        stat = statSync(file, { throwIfNoEntry: false });
      return stat?.isFile()
        ? { dispatchId: name.slice(0, -6), file, sizeBytes: stat.size, mtimeMs: stat.mtimeMs }
        : null;
    })
    .filter((stream): stream is ArchivedStream => stream !== null)
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
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
