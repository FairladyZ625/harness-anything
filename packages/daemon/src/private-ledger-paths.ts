import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { workerLedgerPath } from "./worktree-setup.ts";

/**
 * A private ledger reference a dispatch points at, next to the path this worker can open.
 *
 * `harness/` is a separate private subrepository, so a task worktree checks out none of it. A
 * mission or a declared prompt that names `harness/governance/standards/…` therefore addresses a
 * path that does not exist under the worker's root, and the worker spends its opening calls
 * retrying it. Resolving goes through the same port Required Skills already uses —
 * `workerLedgerPath` — so one file has exactly one path in the prompt and keeps that port's
 * write-isolation policy. A directory is a pointer the worker lists, not a file it opens, so it
 * keeps its canonical absolute path instead of being copied.
 */
export interface PrivateLedgerRead {
  /** The reference as the prompt wrote it, e.g. `harness/governance/standards/testing-standard.md`. */
  readonly asWritten: string;
  /** The path that exists for this worker and that it can open. */
  readonly readable: string;
  /** True when this answers a glob or names a directory: list it, never treat it as a file. */
  readonly directory: boolean;
}

const LEDGER_REFERENCE = /(?:^|[^A-Za-z0-9._/-])harness\/[A-Za-z0-9._\-/{},*]+/gu,
  // A trailing `}` is part of a brace group, not prose punctuation, so it is never stripped here.
  TRAILING_PROSE = /[.,;:)\]>'"`]+$/u;

/** Every distinct `harness/…` reference in one text, in first-seen order, prose punctuation stripped. */
export function privateLedgerReferences(text: string): readonly string[] {
  const references = new Set<string>();
  for (const match of text.matchAll(LEDGER_REFERENCE)) {
    const reference = match[0].replace(/^[^h]/u, "").replace(TRAILING_PROSE, "");
    if (reference.length > "harness/".length) references.add(reference);
  }
  return [...references];
}

/** `harness/a/{b,c}.md` enumerates two concrete files; a brace group is not a wildcard. */
function braceVariants(reference: string): readonly string[] {
  const brace = /^(.*?)\{([^{}]+)\}(.*)$/u.exec(reference);
  if (!brace) return [reference];
  return brace[2]!.split(",").flatMap((part) => braceVariants(`${brace[1]}${part}${brace[3]}`));
}

/**
 * The directory a glob names, e.g. `harness/agents/*.json` -> `harness/agents`. A glob's fan-out is
 * unbounded (`harness/governance/standards/*.md` is 25 files; `harness/tasks/*` is 2.4 GiB), and a
 * list that size either truncates — withholding the very file the mission said to read first — or
 * drowns the reference the worker actually needs. The directory is the one thing that always fits.
 */
function globRoot(reference: string): string | null {
  const segments = reference.split("/"),
    root: string[] = [];
  for (const segment of segments) {
    if (segment.includes("*")) break;
    root.push(segment);
  }
  return root.length === segments.length ? null : root.join("/");
}

/**
 * Resolve the private references in these texts to paths this worker can open. References that name
 * nothing on disk are prose, not reads, and are dropped rather than sent to the worker as 404s.
 */
export function resolvePrivateLedgerReads(input: {
  readonly rootDir: string;
  readonly cwd: string;
  /** Source priority: declared prompts first, then instructions, then the mission. */
  readonly texts: readonly (string | null | undefined)[];
}): readonly PrivateLedgerRead[] {
  const authoredRoot = resolveHarnessLayout(input.rootDir).authoredRoot,
    // A cwd that contains the authored root resolves every relative reference already; only a
    // dispatch rooted elsewhere (a task worktree, a package directory) needs a resolved path.
    reachableRelative = !path.relative(path.resolve(input.cwd), path.resolve(authoredRoot)).startsWith("..");
  if (reachableRelative || !existsSync(authoredRoot)) return [];
  const reads = new Map<string, PrivateLedgerRead>();
  const record = (asWritten: string, readable: string, directory: boolean): void => {
    if (!reads.has(readable)) reads.set(readable, { asWritten, readable, directory });
  };
  for (const text of input.texts) {
    if (!text) continue;
    for (const reference of privateLedgerReferences(text))
      for (const variant of braceVariants(reference)) {
        const root = globRoot(variant);
        if (root !== null) {
          const directory = path.resolve(authoredRoot, root.slice("harness/".length));
          if (statSync(directory, { throwIfNoEntry: false })?.isDirectory()) record(reference, directory, true);
          continue;
        }
        const target = path.join(authoredRoot, variant.slice("harness/".length)),
          entry = statSync(target, { throwIfNoEntry: false });
        // A file is opened, so it goes through the port that hands the worker a readable copy. A
        // directory is only listed: copying one is unbounded (`harness/tasks` is 2.4 GiB), so it
        // keeps its canonical absolute path.
        if (entry?.isFile()) record(variant, workerLedgerPath(input.rootDir, input.cwd, target), false);
        else if (entry?.isDirectory()) record(variant, path.resolve(target), true);
      }
  }
  return [...reads.values()];
}

/**
 * The prompt section that makes those reads actionable. Every reference is listed — nothing is
 * truncated, because a truncated list silently withholds the file the declaration said to read
 * first, and the cut lands on whatever sorts last.
 */
export function privateLedgerReadSection(reads: readonly PrivateLedgerRead[]): string | null {
  if (reads.length === 0) return null;
  return [
    "# Private Ledger Paths (read-only)",
    "The private ledger is a separate subrepository, so this checkout does not contain it: every `harness/…` " +
      "reference in this prompt names a path that is absent here. Open the path below instead. Each is " +
      "read-only: the worker-local copy where one exists, otherwise the canonical file. Never copy one into " +
      "this repository, never write through one.",
    ...reads.map((read) =>
      read.directory
        ? `- ${read.asWritten} -> ${read.readable} (directory: list it; a glob is not a file list)`
        : `- ${read.asWritten} -> ${read.readable}`,
    ),
  ].join("\n");
}
