import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";

/**
 * Private ledger files a dispatch points at, as the worker can actually open them.
 *
 * `harness/` is a separate private subrepository, so a task worktree checks out none of it. A
 * mission or a declared prompt that names `harness/governance/standards/…` therefore addresses a
 * path that does not exist under the worker's root, and the worker spends its opening calls
 * retrying it. The authored root is readable by the same user, so the readable form of every such
 * reference is its canonical absolute path — read-only, never copied into the checkout (a copy
 * would duplicate a 12–20 KiB standard per dispatch and go stale the moment the ledger moves).
 */
export interface PrivateLedgerReadPath {
  /** The reference as the prompt wrote it, e.g. `harness/governance/standards/testing-standard.md`. */
  readonly asWritten: string;
  /** The canonical absolute path that exists and that the worker can open. */
  readonly readable: string;
}

const LEDGER_REFERENCE = /(?:^|[^A-Za-z0-9._/-])harness\/[A-Za-z0-9._\-/{},*]+/gu,
  // A trailing `}` is part of a brace group, not prose punctuation, so it is never stripped here.
  TRAILING_PROSE = /[.,;:)\]>'"`]+$/u,
  APPENDIX_LIMIT = 24;

/** Every distinct `harness/…` reference in one text, in first-seen order, prose punctuation stripped. */
export function privateLedgerReferences(text: string): readonly string[] {
  const references = new Set<string>();
  for (const match of text.matchAll(LEDGER_REFERENCE)) {
    const reference = match[0].replace(/^[^h]/u, "").replace(TRAILING_PROSE, "");
    if (reference.length > "harness/".length) references.add(reference);
  }
  return [...references];
}

/** A reference with its braces and glob segments expanded into the concrete paths it names. */
export function expandLedgerReference(reference: string, authoredRoot: string): readonly string[] {
  const brace = /^(.*?)\{([^{}]+)\}(.*)$/u.exec(reference);
  if (brace)
    return brace[2]!.split(",").flatMap((part) => expandLedgerReference(`${brace[1]}${part}${brace[3]}`, authoredRoot));
  if (!reference.startsWith("harness/")) return [];
  const walk = (relative: string, rest: readonly string[]): readonly string[] => {
    const [head, ...tail] = rest;
    if (head === undefined) return [relative];
    if (!head.includes("*")) return walk(relative === "" ? head : `${relative}/${head}`, tail);
    const directory = path.join(authoredRoot, relative),
      [prefix, suffix] = head.split("*");
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((entry) => entry.startsWith(prefix!) && entry.endsWith(suffix ?? ""))
      .sort()
      .flatMap((entry) => walk(relative === "" ? entry : `${relative}/${entry}`, tail));
  };
  return walk("", reference.slice("harness/".length).split("/")).map((relative) => `harness/${relative}`);
}

/**
 * Resolve the private references in these texts to canonical read-only paths. References that name
 * nothing on disk are prose, not reads, and are dropped rather than sent to the worker as 404s.
 */
export function resolvePrivateLedgerReads(input: {
  readonly rootDir: string;
  readonly cwd: string;
  readonly texts: readonly (string | null | undefined)[];
}): readonly PrivateLedgerReadPath[] {
  const authoredRoot = resolveHarnessLayout(input.rootDir).authoredRoot,
    // A cwd that contains the authored root resolves every relative reference already; only a
    // dispatch rooted elsewhere (a task worktree, a package directory) needs the absolute form.
    reachableRelative = !path.relative(path.resolve(input.cwd), path.resolve(authoredRoot)).startsWith(".."),
    reads = new Map<string, PrivateLedgerReadPath>();
  if (reachableRelative || !existsSync(authoredRoot)) return [];
  for (const text of input.texts) {
    if (!text) continue;
    for (const reference of privateLedgerReferences(text))
      for (const expanded of expandLedgerReference(reference, authoredRoot)) {
        const readable = path.join(authoredRoot, expanded.slice("harness/".length)),
          entry = statSync(readable, { throwIfNoEntry: false });
        if (!entry || reads.has(expanded)) continue;
        reads.set(expanded, { asWritten: expanded, readable });
      }
  }
  return [...reads.values()].sort((left, right) => left.asWritten.localeCompare(right.asWritten));
}

/**
 * The prompt section that makes those reads actionable. Every `harness/…` reference in the mission
 * and in the declared prompts is listed with the absolute path that resolves it; read-set locators
 * are ledger-relative, so the same section names their opening command instead of a checkout path.
 */
export function privateLedgerReadSection(reads: readonly PrivateLedgerReadPath[]): string | null {
  if (reads.length === 0) return null;
  const listed = reads.slice(0, APPENDIX_LIMIT),
    remaining = reads.length - listed.length,
    roots = [...new Set(reads.map((read) => path.dirname(read.readable)))];
  return [
    "# Private Ledger Paths (read-only)",
    "The private ledger is a separate subrepository, so this checkout does not contain it: every `harness/…` " +
      "reference in this prompt names a path that is absent here. Open the absolute path below instead. These " +
      "paths are outside the repository: never copy one into the checkout, never write through one.",
    ...listed.map((read) => `- ${read.asWritten} -> ${read.readable}`),
    ...(remaining > 0 ? [`- ${String(remaining)} more under ${roots.join(", ")}`] : []),
  ].join("\n");
}
