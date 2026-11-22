import path from "node:path";
import type { HarnessLayout } from "@harness-anything/kernel/internal/layout/index.ts";
import { decisionDirectoryFiles, decisionDirectoryRetirements } from "./store/decision-directory-settlement.ts";
import { localGitWorktreeSettlement } from "./store/local-version-control-system.ts";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { sha256Bytes } from "@harness-anything/kernel";
import { writeFileDurably, removeFileDurably, type WriteFence } from "./durable-file.ts";
import type { MaterializationSettlement } from "@harness-anything/kernel";

type MaterializedFileStat = readonly [size: number, mtimeMs: number, ctimeMs: number];

const STAT_RACY_WINDOW_MS = 2_000;

/** The shared fleet materialization owner; canonical absence removes only previously owned paths. */
export function applyCanonicalTree(input: {
  readonly layout: Pick<HarnessLayout, "authoredRoot" | "decisionsRoot">;
  readonly markerPath: string;
  readonly generation: number;
  readonly revision: number;
  readonly entries: ReadonlyMap<string, { readonly sha256: string }>;
  readonly changedPaths?: readonly string[];
  readonly selectedPaths?: readonly string[];
  readonly preview?: boolean;
  readonly acceptedRetired?: ReadonlyMap<string, string>;
  readonly readHistoricalDocument?: (logical: string) => { readonly blobSha256: string } | null;
  readonly readContent: (logical: string) => Uint8Array | null;
  readonly withFence?: WriteFence;
  readonly requirePreviousPaths?: (paths: readonly string[], previousEntries: Readonly<Record<string, string>>) => void;
}) {
  const markerPath = input.markerPath,
    markerExists = existsSync(markerPath),
    marker: {
      readonly revision?: number | null;
      readonly generation?: number;
      readonly entries?: Record<string, string>;
      readonly statTime?: number;
      readonly stats?: Record<string, MaterializedFileStat>;
    } = markerExists ? JSON.parse(readFileSync(markerPath, "utf8")) : {},
    previous = { revision: marker.revision ?? null, generation: marker.generation, entries: marker.entries ?? {} },
    hasMaterializationBaseline =
      markerExists &&
      previous.revision !== null &&
      marker.entries !== undefined &&
      (previous.generation === undefined || previous.generation === input.generation);
  input.requirePreviousPaths?.(Object.keys(previous.entries), previous.entries);
  const root = input.layout.authoredRoot,
    entries = { ...previous.entries },
    previousStats: Record<string, MaterializedFileStat> =
      hasMaterializationBaseline && marker.stats ? marker.stats : {},
    stats: Record<string, MaterializedFileStat> = { ...previousStats },
    nowMs = Date.now(),
    statSafeCutoffMs =
      hasMaterializationBaseline && typeof marker.statTime === "number"
        ? Math.min(marker.statTime, nowMs) - STAT_RACY_WINDOW_MS
        : null,
    dirtyPaths: string[] = [],
    settlements: MaterializationSettlement[] = [];
  const selected = input.selectedPaths
    ? new Set(input.selectedPaths)
    : hasMaterializationBaseline && input.changedPaths
      ? new Set(input.changedPaths)
      : null;
  const coldDecisionPass = !input.selectedPaths && (!hasMaterializationBaseline || !input.changedPaths);
  if (
    selected !== null &&
    selected.size === 0 &&
    !coldDecisionPass &&
    (!input.acceptedRetired || input.acceptedRetired.size === 0)
  ) {
    if (
      !input.preview &&
      (!hasMaterializationBaseline || previous.revision !== input.revision || previous.generation !== input.generation)
    ) {
      writeFileDurably(
        markerPath,
        JSON.stringify({
          revision: input.revision,
          generation: input.generation,
          entries,
          statTime: typeof marker.statTime === "number" ? marker.statTime : nowMs,
          stats,
        }),
        undefined,
        input.withFence,
      );
    }
    return { fromRevision: previous.revision, toRevision: input.revision, dirtyPaths, settlements };
  }
  if (!input.preview)
    /* @gate-identity state-store/document.source.storage.src.canonical-tree-materialization.filesystem-store */ mkdirSync(
      root,
      { recursive: true },
    );
  const upsertTargets: Array<readonly [string, { readonly sha256: string }]> = [];
  const removalTargets: Array<readonly [string, string]> = [];
  if (selected !== null) {
    for (const logical of selected) {
      const blob = input.entries.get(logical);
      if (blob !== undefined) upsertTargets.push([logical, blob]);
      else if (Object.hasOwn(previous.entries, logical)) removalTargets.push([logical, previous.entries[logical]!]);
    }
  } else {
    for (const entry of input.entries) upsertTargets.push(entry);
    for (const [logical, previousSha] of Object.entries(previous.entries)) {
      if (!input.entries.has(logical)) removalTargets.push([logical, previousSha]);
    }
  }
  for (const [logical, blob] of upsertTargets) {
    const target = path.join(root, ...logical.split("/")),
      targetStat = lstatSync(target, { throwIfNoEntry: false });
    // Local files can change after materialization; compare them with the last successful write,
    // not the newer center blob. Explicit selections also preserve an unowned local file.
    if (targetStat) {
      const recorded = previousStats[logical];
      if (
        selected === null &&
        statSafeCutoffMs !== null &&
        recorded !== undefined &&
        blob.sha256 === previous.entries[logical] &&
        targetStat.isFile() &&
        recorded[1] < statSafeCutoffMs &&
        targetStat.size === recorded[0] &&
        targetStat.mtimeMs === recorded[1] &&
        targetStat.ctimeMs === recorded[2]
      ) {
        entries[logical] = blob.sha256;
        stats[logical] = recorded;
        continue;
      }
      const local = sha256Bytes(readFileSync(target));
      if (local === blob.sha256) {
        entries[logical] = blob.sha256;
        if (targetStat.isFile()) stats[logical] = [targetStat.size, targetStat.mtimeMs, targetStat.ctimeMs];
        continue;
      }
      if ((hasMaterializationBaseline || input.selectedPaths !== undefined) && local !== previous.entries[logical]) {
        dirtyPaths.push(logical);
        delete stats[logical];
        continue;
      }
    }
    const bytes = input.readContent(logical);
    if (bytes === null)
      throw Object.assign(new Error(`Replica document object is missing: ${logical}`), { code: "replica_corrupt" });
    settlements.push({ path: logical, action: targetStat ? "overwrite" : "restore", copy: null });
    if (!input.preview) {
      writeFileDurably(target, bytes, undefined, input.withFence);
      const writtenStat = lstatSync(target, { throwIfNoEntry: false });
      if (writtenStat?.isFile()) stats[logical] = [writtenStat.size, writtenStat.mtimeMs, writtenStat.ctimeMs];
      else delete stats[logical];
    }
    entries[logical] = blob.sha256;
  }
  // A center deletion is represented by the path disappearing from the current cut. Remove only
  // files this mirror previously wrote; a local candidate remains untouched and is surfaced for
  // the caller to reconcile, just like a conflicting update.
  for (const [logical, previousSha] of removalTargets) {
    const target = path.join(root, ...logical.split("/"));
    if (!existsSync(target)) {
      delete entries[logical];
      delete stats[logical];
      continue;
    }
    if (sha256Bytes(readFileSync(target)) !== previousSha) {
      dirtyPaths.push(logical);
      delete stats[logical];
      continue;
    }
    settlements.push({ path: logical, action: "delete", copy: null });
    if (!input.preview) removeFileDurably(target, input.withFence);
    delete entries[logical];
    delete stats[logical];
  }
  const historicalCandidates = new Map<string, string>();
  if (input.acceptedRetired)
    for (const [logical, expectedSha] of input.acceptedRetired) {
      if (selected && !selected.has(logical)) continue;
      if (input.entries.has(logical) || Object.hasOwn(previous.entries, logical)) continue;
      historicalCandidates.set(logical, expectedSha);
    }
  if (coldDecisionPass && input.readHistoricalDocument)
    for (const logical of decisionDirectoryFiles(input.layout.decisionsRoot)) {
      if (input.entries.has(logical) || Object.hasOwn(previous.entries, logical) || historicalCandidates.has(logical))
        continue;
      const historical = input.readHistoricalDocument(logical);
      if (historical) historicalCandidates.set(logical, historical.blobSha256);
    }
  for (const [logical, expectedSha] of historicalCandidates) {
    const target = path.join(root, ...logical.split("/"));
    if (!existsSync(target) || !lstatSync(target).isFile()) continue;
    if (sha256Bytes(readFileSync(target)) !== expectedSha) {
      dirtyPaths.push(logical);
      continue;
    }
    settlements.push({ path: logical, action: "delete", copy: null });
    if (!input.preview) removeFileDurably(target, input.withFence);
  }
  if (!input.preview) {
    const deletedPaths = settlements.filter(({ action }) => action === "delete").map(({ path }) => path);
    if (deletedPaths.length > 0 || coldDecisionPass) {
      const taskDirectories = new Set<string>();
      for (const deleted of deletedPaths)
        if (deleted.startsWith("tasks/task_"))
          for (
            let directory = path.posix.dirname(deleted);
            directory.startsWith("tasks/task_");
            directory = path.posix.dirname(directory)
          )
            taskDirectories.add(directory);
      localGitWorktreeSettlement.retireEmptyDirectories(
        root,
        [
          ...decisionDirectoryRetirements(deletedPaths, input.layout.decisionsRoot, { cold: coldDecisionPass }),
          ...taskDirectories,
        ].sort((a, b) => b.split("/").length - a.split("/").length),
        input.withFence,
      );
    }
    writeFileDurably(
      markerPath,
      JSON.stringify({ revision: input.revision, generation: input.generation, entries, statTime: nowMs, stats }),
      undefined,
      input.withFence,
    );
  }
  return { fromRevision: previous.revision, toRevision: input.revision, dirtyPaths, settlements };
}

/** Revocation withdraws every mirror-owned path, including locally edited copies. */
export function revokeCanonicalTree(authoredRoot: string, markerPath: string): void {
  if (!existsSync(markerPath)) return;
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { readonly entries?: Record<string, string> };
  for (const logical of Object.keys(marker.entries ?? {})) {
    const file = path.join(authoredRoot, ...logical.split("/"));
    if (existsSync(file)) removeFileDurably(file);
  }
  removeFileDurably(markerPath);
}
