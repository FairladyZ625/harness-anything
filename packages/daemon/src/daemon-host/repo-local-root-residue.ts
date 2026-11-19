import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { DEFAULT_HARNESS_LOCAL_ROOT, resolveHarnessLayout } from "@harness-anything/kernel";
import {
  aggregateLocalRootEntryClass,
  cachePurgePreservedLocalDirectories,
  classifyLocalRootLeaf,
  type LocalRootLeafClass,
} from "./repo-cache-purge.ts";

/**
 * Read-only classification of what a renamed `layout.localRoot` left in the default `.harness`
 * directory. The classification is **derived from the cache-purge policy**, never restated here:
 * `repo-cache-purge.ts` already decides which local paths a purge deletes and which it preserves,
 * and the diagnostic must not hold a second opinion about that.
 *
 * Every real file under an entry decides that entry's class:
 *
 *  - `derived` — every file sits on `cachePurgeDerivedDirectories` (including nested entries such
 *    as `runtime/dispatches`). A cache purge deletes all of it, so removal is safe once nothing
 *    has it open.
 *  - `authoritative` — at least one file sits on a `cachePurgePreservedPaths` entry (`store/`,
 *    `wal/`), and none is unknown. These are the ledger and its unflushed events.
 *  - `unrecognized` — any file on neither list. This includes `settings.local.json`,
 *    `preset-runs/`, `operations/`, `credentials/`, `conflicts/` and `wal.bricked-*`: this file
 *    has no evidence about them, so it never calls them disposable.
 *
 * A tree of empty directories holds no state, so it is never a finding. A zero-byte file is still
 * state: an empty `settings.local.json` is a truncated preference file, not an absent one. The
 * walk never follows a symbolic link (a self-referential link would otherwise make
 * `ha doctor health` throw instead of report).
 */
export interface OldLocalRootResidue {
  readonly rootDir: string;
  readonly path: string;
  readonly derived: readonly string[];
  readonly authoritative: readonly string[];
  readonly unrecognized: readonly string[];
}

type EntryClass = LocalRootLeafClass;

export function oldLocalRootResidue(rootDir: string): OldLocalRootResidue | null {
  const layout = resolveHarnessLayout(rootDir);
  if (layout.localRoot === path.join(layout.rootDir, DEFAULT_HARNESS_LOCAL_ROOT)) return null;
  const legacy = path.join(layout.rootDir, DEFAULT_HARNESS_LOCAL_ROOT);
  if (!existsSync(legacy)) return null;
  const entries = readdirSync(legacy).sort();
  if (entries.length === 0) return null;
  const preserved = cachePurgePreservedLocalDirectories(rootDir),
    classOf = (entry: string): EntryClass | null => {
      const leaves = leafFiles(path.join(legacy, entry), entry);
      if (leaves.length === 0) return null;
      return aggregateLocalRootEntryClass(
        leaves.map((leaf) => classifyLocalRootLeaf(leaf.relative, preserved, { isSymbolicLink: leaf.isSymbolicLink })),
      );
    },
    classified = entries.flatMap((entry) => {
      const kind = classOf(entry);
      return kind === null ? [] : [{ entry, kind }];
    });
  if (classified.length === 0) return null;
  return {
    rootDir: layout.rootDir,
    path: legacy,
    derived: classified.filter((item) => item.kind === "derived").map((item) => item.entry),
    authoritative: classified.filter((item) => item.kind === "authoritative").map((item) => item.entry),
    unrecognized: classified.filter((item) => item.kind === "unrecognized").map((item) => item.entry),
  };
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

/** Every non-directory path under `target`, as a path relative to the local root. Symbolic
 *  links are leaves (authored content), never traversed; directories with no files yield none. */
function leafFiles(
  target: string,
  relative: string,
  found: { readonly relative: string; readonly isSymbolicLink: boolean }[] = [],
): { readonly relative: string; readonly isSymbolicLink: boolean }[] {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return found;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    found.push({ relative, isSymbolicLink: stat.isSymbolicLink() });
    return found;
  }
  for (const entry of readdirSync(target)) leafFiles(path.join(target, entry), `${relative}/${entry}`, found);
  return found;
}

/** `ha doctor health`: a renamed local root must not leave state behind silently. Records only
 *  what exists and what the production purge lists say about it — the disposition stays with the
 *  person, because the repository is the only authority on whether an old preset pin or local
 *  preference is still wanted. */
export function doctorLocalRootResidue(rootDir: string): {
  readonly id: "local-root-residue";
  readonly status: Exclude<OperationalStatus.DoctorCheckStatus, "indeterminate">;
  readonly summary: string;
  readonly count: number;
  readonly next: string;
} {
  const id = "local-root-residue" as const,
    residue = oldLocalRootResidue(rootDir);
  if (residue === null)
    return {
      id,
      status: "ok",
      summary: "No stale default local root holds state; every local ledger path follows layout.localRoot.",
      count: 0,
      next: "Nothing to do.",
    };
  const stale = toPosix(path.relative(residue.rootDir, residue.path)),
    count = residue.derived.length + residue.authoritative.length + residue.unrecognized.length,
    reported = [
      residue.authoritative.length === 0 ? "" : `authoritative (ledger family): ${residue.authoritative.join(", ")}.`,
      residue.derived.length === 0 ? "" : `derived (a cache purge deletes these too): ${residue.derived.join(", ")}.`,
      residue.unrecognized.length === 0
        ? ""
        : `unrecognized (no production list classifies these): ${residue.unrecognized.join(", ")}.`,
    ]
      .filter(Boolean)
      .join(" "),
    // Anything not proven regenerable is a finding: this repository no longer reads it, and only
    // the person knows whether it can go. Reporting an unclassified entry as a mere warning would
    // be a verdict this file cannot support.
    finding = residue.authoritative.length + residue.unrecognized.length > 0,
    // Advice is per class and never widens: the ledger family has a conversion command, the
    // derived class has the purge as precedent, and an unrecognized entry gets no instruction at
    // all because this file holds no evidence about what it is.
    advice = [
      residue.authoritative.length === 0
        ? ""
        : `Convert ${residue.authoritative.join(", ")} with ha migrate ledger --help instead of a manual copy.`,
      residue.derived.length === 0 ? "" : `A cache purge removes ${residue.derived.join(", ")}.`,
      residue.unrecognized.length === 0
        ? ""
        : `Confirm what ${residue.unrecognized.join(", ")} hold before touching them; this check does not judge them.`,
    ]
      .filter(Boolean)
      .join(" ");
  return {
    id,
    status: finding ? "fail" : "warn",
    summary: finding
      ? `${stale}/ still holds state this repository no longer reads because layout.localRoot moved. ${reported}`
      : `${stale}/ still exists but holds only paths a cache purge deletes. ${reported}`,
    count,
    next: `${advice} Remove ${stale}/ only after every item above is accounted for.`,
  };
}
