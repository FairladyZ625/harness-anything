import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import type { PublicationDelete, PublicationWrite } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { readAuthoredNode } from "../authored-node-read.ts";

type GitEntry = { readonly mode: string; readonly oid: string };
type IndexEntry = GitEntry & { readonly hidden: boolean };
type IndexChange = { readonly before: GitEntry | null; readonly after: GitEntry | null };
type GitCommand = { readonly args: readonly string[]; readonly input?: Buffer };

export interface FollowerIndexCut {
  readonly repoRoot: string;
  readonly authoredRef: string;
  readonly authoredPrefix: string;
  readonly head: string;
  readonly previous: string | null;
  /** The exact import inputs and the parent entries already read for worktree settlement. */
  readonly transition?: {
    readonly files: readonly (PublicationWrite | PublicationDelete)[];
    readonly tree: ReadonlyMap<string, GitEntry>;
  };
  /** Only a certified cut can settle visibility without changing its tree. */
  readonly visibility?: readonly (PublicationWrite | PublicationDelete)[];
  /** On attach, prove older missing entries without resetting user staging. */
  readonly ownedDocuments?: (targets: readonly string[]) => ReadonlySet<string>;
  /** Generated paths retired by the existing ledger-format conversion. */
  readonly retiredLegacyPaths?: ReadonlySet<string>;
}

const zeroOid = "0".repeat(40);
const entry = (mode: string, oid: string): GitEntry | null => (mode === "000000" ? null : { mode, oid });
const equal = (left: GitEntry | null, right: GitEntry | null): boolean =>
  left?.mode === right?.mode && left?.oid === right?.oid;
const records = (output: Buffer): string[] => output.toString("utf8").split("\0").slice(0, -1);

function rawChanges(output: Buffer): Map<string, IndexChange> {
  const values = records(output),
    changes = new Map<string, IndexChange>();
  for (let index = 0; index < values.length; index += 2) {
    const [beforeMode, afterMode, beforeOid, afterOid] = values[index]!.slice(1).split(" "),
      target = values[index + 1]!;
    changes.set(target, { before: entry(beforeMode!, beforeOid!), after: entry(afterMode!, afterOid!) });
  }
  return changes;
}

function readIndexEntries(output: Buffer, targets: ReadonlySet<string>): Map<string, IndexEntry | null> {
  const entries = new Map<string, IndexEntry | null>();
  for (const row of records(output)) {
    const tab = row.indexOf("\t"),
      target = row.slice(tab + 1);
    if (!targets.has(target)) continue;
    const [mode, oid, stage] = row.slice(2, tab).split(" ");
    // Keep conflict stages and any genuine staging intact.
    entries.set(target, stage === "0" ? { mode: mode!, oid: oid!, hidden: row[0]?.toUpperCase() === "S" } : null);
  }
  return entries;
}

const scopedArgByteLimit = process.platform === "win32" ? 4 * 1024 : 8 * 1024;

function scopedArgs(scope: string, targets: ReadonlySet<string>): readonly string[] {
  let bytes = 0;
  for (const target of targets) {
    bytes += Buffer.byteLength(target) + 1;
    // Bulk reconciliation may need a whole authored subtree. Read it once and intersect
    // with the changed paths, instead of reopening a large index for every argv chunk.
    if (bytes > scopedArgByteLimit) return [scope];
  }
  return [...targets];
}

function worktreeMatches(repoRoot: string, target: string, tree: GitEntry): boolean {
  const node = readAuthoredNode(path.join(repoRoot, target));
  return node?.mode === tree.mode && gitBlobOid(node.bytes) === tree.oid;
}

function gitBlobOid(body: string | Uint8Array): string {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function plannedChanges(transition: NonNullable<FollowerIndexCut["transition"]>): Map<string, IndexChange> {
  const changes = new Map<string, IndexChange>();
  for (const file of transition.files) {
    const target = "delete" in file ? file.delete : file.target;
    changes.set(target, {
      before: transition.tree.get(target) ?? null,
      after: "delete" in file ? null : { mode: file.mode, oid: gitBlobOid(file.body) },
    });
  }
  return changes;
}

/** Drives the same checkout-index transaction plan through synchronous and detached Git ports. */
export function* followerIndexCommands(input: FollowerIndexCut): Generator<GitCommand, void, Buffer> {
  const scope = input.authoredPrefix || ".",
    changes = input.transition
      ? plannedChanges(input.transition)
      : input.previous && input.previous !== input.head
        ? rawChanges(
            yield {
              args: [
                "--literal-pathspecs",
                "diff-tree",
                "-r",
                "--no-commit-id",
                "--no-renames",
                "--raw",
                "--no-abbrev",
                "-z",
                input.previous,
                input.head,
                "--",
                scope,
              ],
            },
          )
        : new Map<string, IndexChange>(),
    visibility = new Map(
      input.visibility?.map((file) => ["delete" in file ? file.delete : file.target, "delete" in file]),
    );
  if (visibility.size > 0) {
    const tree = yield {
      args: [
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "-z",
        input.head,
        "--",
        ...scopedArgs(scope, new Set(visibility.keys())),
      ],
    };
    for (const row of records(tree)) {
      const tab = row.indexOf("\t"),
        target = row.slice(tab + 1);
      if (!visibility.has(target)) continue;
      const [mode, , oid] = row.slice(0, tab).split(" "),
        after = { mode: mode!, oid: oid! };
      if (!changes.has(target)) changes.set(target, { before: after, after });
    }
  }
  const visibleRepairs = new Set<string>();
  if (input.ownedDocuments) {
    const missing = rawChanges(
      yield {
        args: [
          "--literal-pathspecs",
          "diff-index",
          "--cached",
          "--no-renames",
          "--raw",
          "--no-abbrev",
          "--diff-filter=D",
          "-z",
          input.head,
          "--",
          scope,
        ],
      },
    );
    const owned = input.ownedDocuments([...missing.keys()].filter((target) => !visibility.get(target)));
    for (const target of owned) {
      const head = missing.get(target)?.before;
      if (head && worktreeMatches(input.repoRoot, target, head)) {
        visibleRepairs.add(target);
        if (!changes.has(target)) changes.set(target, { before: null, after: head });
      }
    }
  }
  for (const target of input.retiredLegacyPaths ?? [])
    if (!changes.has(target)) changes.set(target, { before: null, after: null });
  if (changes.size === 0) return;
  const targets = new Set(changes.keys()),
    index = readIndexEntries(
      yield { args: ["--literal-pathspecs", "ls-files", "-v", "--stage", "-z", "--", ...scopedArgs(scope, targets)] },
      targets,
    ),
    indexInfo: string[] = [],
    hide: string[] = [],
    show: string[] = [];
  for (const [target, { before, after }] of changes) {
    const current = index.get(target);
    if (current === null) continue;
    const plannedDelete = visibility.get(target) === true,
      matchesHead = equal(current ?? null, after),
      matchesPreimage = equal(current ?? null, before),
      staleLegacyEntry =
        before === null &&
        after === null &&
        input.retiredLegacyPaths?.has(target) &&
        lstatSync(path.join(input.repoRoot, target), { throwIfNoEntry: false }) === undefined;
    if (
      !matchesHead &&
      !matchesPreimage &&
      !staleLegacyEntry &&
      !(
        current === undefined &&
        (plannedDelete ||
          visibleRepairs.has(target) ||
          (after && visibility.has(target) && worktreeMatches(input.repoRoot, target, after)))
      )
    )
      continue;
    if (!matchesHead) indexInfo.push(`${after?.mode ?? "0"} ${after?.oid ?? zeroOid}\t${target}\0`);
    if (after && (input.transition || visibility.has(target))) {
      const hidden =
        plannedDelete && lstatSync(path.join(input.repoRoot, target), { throwIfNoEntry: false }) === undefined;
      if (hidden && (!matchesHead || !current?.hidden)) hide.push(`${target}\0`);
      if (!hidden && matchesHead && current?.hidden) show.push(`${target}\0`);
    }
  }
  if (indexInfo.length > 0)
    yield { args: ["update-index", "-z", "--index-info"], input: Buffer.from(indexInfo.join("")) };
  if (hide.length > 0)
    yield { args: ["update-index", "--skip-worktree", "-z", "--stdin"], input: Buffer.from(hide.join("")) };
  if (show.length > 0)
    yield { args: ["update-index", "--no-skip-worktree", "-z", "--stdin"], input: Buffer.from(show.join("")) };
}
