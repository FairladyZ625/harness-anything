import path from "node:path";
import type { HarnessLayout } from "@harness-anything/kernel/internal/layout/index.ts";
import { decisionDirectoryRetirements } from "./store/decision-directory-settlement.ts";
import { localGitWorktreeSettlement } from "./store/local-version-control-system.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { sha256Bytes } from "@harness-anything/kernel";
import { writeFileDurably, removeFileDurably, type WriteFence } from "./durable-file.ts";
import type { MaterializationSettlement } from "@harness-anything/kernel";

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
  readonly readContent: (logical: string) => Uint8Array | null;
  readonly withFence?: WriteFence;
  readonly requirePreviousPaths?: (paths: readonly string[]) => void;
}) {
  const markerPath = input.markerPath,
    markerExists = existsSync(markerPath),
    marker: {
      readonly revision?: number | null;
      readonly generation?: number;
      readonly entries?: Record<string, string>;
    } = markerExists ? JSON.parse(readFileSync(markerPath, "utf8")) : {},
    previous = { revision: marker.revision ?? null, generation: marker.generation, entries: marker.entries ?? {} },
    hasMaterializationBaseline =
      markerExists &&
      previous.revision !== null &&
      marker.entries !== undefined &&
      (previous.generation === undefined || previous.generation === input.generation);
  input.requirePreviousPaths?.(Object.keys(previous.entries));
  const root = input.layout.authoredRoot,
    entries = { ...previous.entries },
    dirtyPaths: string[] = [],
    settlements: MaterializationSettlement[] = [];
  const selected = input.selectedPaths
    ? new Set(input.selectedPaths)
    : hasMaterializationBaseline && input.changedPaths
      ? new Set(input.changedPaths)
      : null;
  if (!input.preview)
    /* @gate-identity state-store/document.source.storage.src.canonical-tree-materialization.filesystem-store */ mkdirSync(
      root,
      { recursive: true },
    );
  for (const [logical, blob] of input.entries) {
    if (selected && !selected.has(logical)) continue;
    const target = path.join(root, ...logical.split("/"));
    // Local files can change after materialization; compare them with the last successful write,
    // not the newer center blob. An unowned local file has no baseline and must also be preserved.
    if (existsSync(target)) {
      const local = sha256Bytes(readFileSync(target));
      if (local === blob.sha256) {
        entries[logical] = blob.sha256;
        continue;
      }
      if (local !== previous.entries[logical]) {
        dirtyPaths.push(logical);
        continue;
      }
    }
    const bytes = input.readContent(logical);
    if (bytes === null)
      throw Object.assign(new Error(`Replica document object is missing: ${logical}`), { code: "replica_corrupt" });
    settlements.push({ path: logical, action: existsSync(target) ? "overwrite" : "restore", copy: null });
    if (!input.preview) writeFileDurably(target, bytes, undefined, input.withFence);
    entries[logical] = blob.sha256;
  }
  // A center deletion is represented by the path disappearing from the current cut. Remove only
  // files this mirror previously wrote; a local candidate remains untouched and is surfaced for
  // the caller to reconcile, just like a conflicting update.
  for (const [logical, previousSha] of Object.entries(previous.entries)) {
    if (selected && !selected.has(logical)) continue;
    if (input.entries.has(logical)) continue;
    const target = path.join(root, ...logical.split("/"));
    if (!existsSync(target)) {
      delete entries[logical];
      continue;
    }
    if (sha256Bytes(readFileSync(target)) !== previousSha) {
      dirtyPaths.push(logical);
      continue;
    }
    settlements.push({ path: logical, action: "delete", copy: null });
    if (!input.preview) removeFileDurably(target, input.withFence);
    delete entries[logical];
  }
  if (!input.preview) {
    const taskDirectories = new Set<string>();
    for (const row of settlements)
      if (row.action === "delete" && row.path.startsWith("tasks/task_"))
        for (
          let directory = path.posix.dirname(row.path);
          directory.startsWith("tasks/task_");
          directory = path.posix.dirname(directory)
        )
          taskDirectories.add(directory);
    localGitWorktreeSettlement.retireEmptyDirectories(
      root,
      [
        ...decisionDirectoryRetirements(
          settlements.filter(({ action }) => action === "delete").map(({ path }) => path),
          !input.selectedPaths && (!hasMaterializationBaseline || !input.changedPaths)
            ? input.layout.decisionsRoot
            : undefined,
        ),
        ...taskDirectories,
      ].sort((a, b) => b.split("/").length - a.split("/").length),
      input.withFence,
    );
    writeFileDurably(
      markerPath,
      JSON.stringify({ revision: input.revision, generation: input.generation, entries }),
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
