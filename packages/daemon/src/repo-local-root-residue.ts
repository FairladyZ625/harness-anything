import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { DEFAULT_HARNESS_LOCAL_ROOT, resolveHarnessLayout } from "@harness-anything/kernel";

/**
 * Durable local state a renamed `layout.localRoot` leaves behind in the default `.harness`
 * directory: the entries a person would have to move by hand or deliberately drop, because no
 * code path reads them from the old root any more.
 *
 *  - `settings.local.json` — this machine's preferences; losing it silently reverts locale and
 *    GUI request deadlines to their defaults.
 *  - `presets/` — installed preset objects and their active pins; resolution then reports
 *    "not installed" even though the person installed it.
 *  - `store/` — the ledger itself. Its presence at the old root means history was never moved,
 *    and attach cannot repair that by rebuilding a projection cache.
 *  - `wal/` — unflushed legacy generation-1/2 events, which attach consumes only from the active
 *    local root.
 *  - `preset-runs/` — in-flight or historical preset run witnesses.
 *
 * Everything else under the default root (`cache`, `generated`, `restore-drills`, `runtime`,
 * `conflicts`, `adopt-claims`, ...) is derived state a purge or rebuild recreates, so its
 * presence is reported as ignorable residue rather than a finding.
 */
const durableOldRootEntries: readonly string[] = ["settings.local.json", "presets", "store", "wal", "preset-runs"];

export interface OldLocalRootResidue {
  readonly rootDir: string;
  readonly path: string;
  readonly durable: readonly string[];
  readonly derived: readonly string[];
}

/** Read-only inspection of the default `.harness` directory when this repository renamed its
 *  local root. A default-layout, absent or empty directory reports `null`, so the check is silent
 *  everywhere the rename question does not apply. */
export function oldLocalRootResidue(rootDir: string): OldLocalRootResidue | null {
  const layout = resolveHarnessLayout(rootDir);
  if (layout.localRoot === path.join(layout.rootDir, DEFAULT_HARNESS_LOCAL_ROOT)) return null;
  const legacy = path.join(layout.rootDir, DEFAULT_HARNESS_LOCAL_ROOT);
  if (!existsSync(legacy)) return null;
  const entries = readdirSync(legacy).sort();
  if (entries.length === 0) return null;
  return {
    rootDir: layout.rootDir,
    path: legacy,
    durable: entries.filter((entry) => durableOldRootEntries.includes(entry)),
    derived: entries.filter((entry) => !durableOldRootEntries.includes(entry)),
  };
}

/** `ha doctor health`: a renamed local root must not leave durable state behind silently.
 *  Records only what exists — the disposition stays with the person, because the repository is
 *  the only authority on whether an old preset pin or local preference is still wanted. */
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
  const stale = path.relative(residue.rootDir, residue.path).split(path.sep).join("/"),
    derivedNote =
      residue.derived.length === 0 ? "" : ` Derived residue there is safe to ignore: ${residue.derived.join(", ")}.`;
  if (residue.durable.length === 0)
    return {
      id,
      status: "warn",
      summary:
        `${stale}/ still exists but holds only derived state: ${residue.derived.join(", ")}. ` +
        "Nothing durable is stranded; it is a leftover from before the rename.",
      count: residue.derived.length,
      next: `Delete ${stale}/ once no daemon has it open; its contents are rebuilt on demand.`,
    };
  return {
    id,
    status: "fail",
    summary:
      `Durable local state is still under ${stale}/, which this repository no longer reads because ` +
      `layout.localRoot moved: ${residue.durable.join(", ")}.${derivedNote}`,
    count: residue.durable.length,
    next:
      `settings.local.json and presets/ can be moved into the active local root; store/ and wal/ are the ledger and ` +
      `must go through ha migrate ledger --help instead of a manual copy. Confirm the destination, then remove ${stale}/.`,
  };
}
