import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { DEFAULT_HARNESS_LOCAL_ROOT, resolveHarnessLayout } from "@harness-anything/kernel";
import { cachePurgeDerivedDirectories, cachePurgePreservedPaths } from "./repo-cache-purge.ts";

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

type EntryClass = "derived" | "authoritative" | "unrecognized";

export function oldLocalRootResidue(rootDir: string): OldLocalRootResidue | null {
  const layout = resolveHarnessLayout(rootDir);
  if (layout.localRoot === path.join(layout.rootDir, DEFAULT_HARNESS_LOCAL_ROOT)) return null;
  const legacy = path.join(layout.rootDir, DEFAULT_HARNESS_LOCAL_ROOT);
  if (!existsSync(legacy)) return null;
  const entries = readdirSync(legacy).sort();
  if (entries.length === 0) return null;
  const legacyPrefix = `${toPosix(path.relative(layout.rootDir, legacy))}/`,
    localPrefix = `${toPosix(path.relative(layout.rootDir, layout.localRoot))}/`,
    derived = cachePurgeDerivedDirectories.map((relative) => `${legacyPrefix}${relative}`),
    // `cachePurgePreservedPaths` names what a purge keeps *under the active local root*; the same
    // relative names are what the renamed root would have held, so re-anchor them to the old
    // prefix. Entries outside the local root (authored root, .worktrees) cannot sit under it.
    preserved = cachePurgePreservedPaths(rootDir).flatMap((pathFromRoot) => {
      const normalized = toPosix(pathFromRoot);
      return normalized.startsWith(localPrefix) ? [`${legacyPrefix}${normalized.slice(localPrefix.length)}`] : [];
    }),
    classOf = (entry: string): EntryClass | null => {
      const leaves = leafFiles(path.join(legacy, entry), `${legacyPrefix}${entry}`);
      if (leaves.length === 0) return null;
      const classes = leaves.map((leaf) => classifyLeaf(leaf, derived, preserved));
      if (classes.includes("unrecognized")) return "unrecognized";
      return classes.includes("authoritative") ? "authoritative" : "derived";
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

/** `relative` is a file path (or a bare list entry) from the legacy root. A list entry matches its
 *  own directory and everything under it, which is what a purge deletes. */
function classifyLeaf(relative: string, derived: readonly string[], preserved: readonly string[]): EntryClass {
  const coveredBy = (prefixes: readonly string[]): boolean =>
    prefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
  if (coveredBy(derived)) return "derived";
  return coveredBy(preserved) ? "authoritative" : "unrecognized";
}

/** Every non-directory path under `target`, as a path relative to the repository root. Symbolic
 *  links are leaves (authored content), never traversed; directories with no files yield none. */
function leafFiles(target: string, relative: string, found: string[] = []): string[] {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return found;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    found.push(relative);
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
  readonly status: "ok" | "warn" | "fail";
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
