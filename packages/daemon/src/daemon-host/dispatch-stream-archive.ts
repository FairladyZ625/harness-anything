import { lstatSync, readSync, unlinkSync } from "node:fs";
import path from "node:path";
import * as Order from "effect/Order";
import * as SortedSet from "effect/SortedSet";
import { resolveHarnessLayout, type TaskProjectionQueries } from "@harness-anything/kernel";
import { compactDispatchStreamArchive } from "./dispatch-stream-compaction.ts";
import { removeDispatchEvidenceState } from "./dispatch-evidence-state.ts";
import { resolveOwnedLocalDirectory } from "./local-root-paths.ts";
import { mustPreserveDispatch } from "./dispatch-stream.ts";
import { directoryEntries, scheduleMaintenance, type MaintenanceSchedule } from "./local-maintenance.ts";
import { withReadOnlyFile } from "../../../storage/src/durable-file.ts";

const dispatchFilePattern = /^dispatch_[a-f0-9]{24}\.jsonl$/u;

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

/** Queue one archive entry at a time so existing writer work can run between files. */
export function scheduleArchivedDispatchStreamCompaction(rootDir: string, schedule: MaintenanceSchedule): void {
  const layout = resolveHarnessLayout(rootDir);
  const archive = ownedArchiveDirectory(layout);
  if (archive === null) return;
  function* compact(): Generator<void> {
    if (archive === null || ownedArchiveDirectory(layout) !== archive) return;
    for (const entry of directoryEntries(archive)) {
      if (ownedArchiveDirectory(layout) !== archive) return;
      if (entry.isFile() && dispatchFilePattern.test(entry.name)) {
        const file = path.join(archive, entry.name),
          dispatchId = entry.name.slice(0, -6);
        if (lstatSync(file, { throwIfNoEntry: false })?.isFile() && !mustPreserveDispatch(rootDir, dispatchId, file))
          compactDispatchStreamArchive(file, dispatchId);
      }
      yield;
    }
  }
  scheduleMaintenance(schedule, compact(), 1);
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
  recoveryDispatchIds: readonly string[] = [],
): void {
  for (const _ of pruneDispatchStreamArchiveSteps(rootDir, retention, evidenceSources, nowMs, recoveryDispatchIds)) {
    // Offline callers already own the entire turn.
  }
}

export function* pruneDispatchStreamArchiveSteps(
  rootDir: string,
  retention: DispatchArchiveRetention,
  evidenceSources: Iterable<string>,
  nowMs: number,
  recoveryDispatchIds: readonly string[],
  canDelete: () => boolean = () => true,
): Generator<void> {
  const layout = resolveHarnessLayout(rootDir);
  const archive = ownedArchiveDirectory(layout);
  if (archive === null || (retention.retentionDays <= 0 && retention.retentionBytes <= 0)) return;
  const prefixes = new Set<string>();
  for (const source of evidenceSources) {
    collectFactEvidencePrefixes(prefixes, source);
    yield;
  }

  const protectedIds = new Set(recoveryDispatchIds),
    expired: ArchivedStream[] = [];
  const cutoff = nowMs - retention.retentionDays * 86_400_000;
  let total = 0;
  let oldestFirst = SortedSet.empty(
    Order.make<ArchivedStream>(
      (left, right) =>
        Order.number(left.startedAtMs, right.startedAtMs) || Order.string(left.dispatchId, right.dispatchId),
    ),
  );
  for (const entry of directoryEntries(archive)) {
    if (ownedArchiveDirectory(layout) !== archive) return;
    if (entry.isFile() && dispatchFilePattern.test(entry.name)) {
      const file = path.join(archive, entry.name);
      const stat = lstatSync(file, { throwIfNoEntry: false });
      const startedAtMs = stat?.isFile() ? archivedStartedAtMs(file) : NaN;
      if (stat && Number.isFinite(startedAtMs)) {
        const dispatchId = entry.name.slice(0, -6);
        total += stat.size;
        if (!protectedIds.has(dispatchId) && !factEvidenceNames(prefixes, dispatchId)) {
          const stream = { dispatchId, file, sizeBytes: stat.size, startedAtMs };
          if (retention.retentionDays > 0 && startedAtMs < cutoff) expired.push(stream);
          else if (retention.retentionBytes > 0) oldestFirst = SortedSet.add(oldestFirst, stream);
        }
      }
    }
    yield;
  }

  for (const candidates of [expired, oldestFirst]) {
    for (const stream of candidates) {
      if (candidates === oldestFirst && total <= retention.retentionBytes) return;
      if (ownedArchiveDirectory(layout) !== archive || !canDelete()) return;
      if (lstatSync(stream.file, { throwIfNoEntry: false })?.isFile()) {
        if (!mustPreserveDispatch(rootDir, stream.dispatchId, stream.file)) {
          /* @gate-identity state-store/execution.dispatch-stream-archive */ unlinkSync(stream.file);
          removeDispatchEvidenceState(rootDir, stream.dispatchId);
          total -= stream.sizeBytes;
        }
      } else {
        total -= stream.sizeBytes;
      }
      yield;
    }
  }
}

function ownedArchiveDirectory(layout: ReturnType<typeof resolveHarnessLayout>): string | null {
  return resolveOwnedLocalDirectory(layout, ["runtime", "dispatches", "archive"]);
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
function collectFactEvidencePrefixes(prefixes: Set<string>, source: string): void {
  for (const match of source.matchAll(/dispatches\/archive\/dispatch_([a-f0-9*,{}]+)/gu)) {
    for (const entry of match[1]!.replace(/[{}]/gu, "").split(",")) {
      const prefix = entry.split("*")[0]!;
      if (/^[a-f0-9]{8,24}$/u.test(prefix)) prefixes.add(prefix);
    }
  }
}

function factEvidenceNames(prefixes: ReadonlySet<string>, dispatchId: string): boolean {
  const id = dispatchId.slice("dispatch_".length);
  for (let length = 8; length <= id.length; length += 1) {
    if (prefixes.has(id.slice(0, length))) return true;
  }
  return false;
}

/**
 * The evidence sources of every canonical Fact row, archived rows included. `ha fact archive`
 * retires the managed document while the row keeps its immutable evidenceSource, so the
 * protection input is the projection, not a scan of facts/*.md — a scan would stop seeing the
 * reference an archived Fact still holds and let retention delete the stream it names. Refuses
 * to answer on a projection that is not at the canonical cut: pruning against a short list of
 * evidence sources would delete streams live facts still name, so the caller skips the pass.
 */
export function tryReadFactEvidenceSources(
  projection: Pick<TaskProjectionQueries, "searchFacts">,
):
  | { readonly status: "ready"; readonly sources: Iterable<string>; readonly watermark: number }
  | { readonly status: "pending"; readonly watermark: number; readonly sourceRevision: number } {
  const read = projection.searchFacts({});
  if (read.status !== "ready")
    return { status: "pending", watermark: read.watermark, sourceRevision: read.sourceRevision };
  function* sources(): Generator<string> {
    for (const fact of read.facts) yield fact.evidenceSource;
  }
  return { status: "ready", sources: sources(), watermark: read.watermark };
}

export function readFactEvidenceSources(projection: Pick<TaskProjectionQueries, "searchFacts">): readonly string[] {
  const read = tryReadFactEvidenceSources(projection);
  if (read.status !== "ready")
    throw new Error(
      `fact projection is not at the canonical cut (watermark ${read.watermark}, source revision ` +
        `${read.sourceRevision}); refusing to prune the dispatch archive against a partial evidence list`,
    );
  return [...read.sources];
}
