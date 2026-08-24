import { pathToFileURL } from "node:url";
import { git, repoRoot } from "./git.mjs";
import { isProductionPath } from "./module-policy.mjs";

export const MAX_LINE_LENGTH = 120;

const STANDARD_PATH = "harness/governance/standards/file-complexity-structural-decomposition-standard.md";
const REPORT_LIMIT = 20;

/**
 * Parse `git diff -U0` output into changed hunks, keeping each hunk's
 * destination path and starting line so a violation can be pointed at.
 */
export function parseHunks(diffText) {
  const hunks = [];
  let filePath = null;
  let current = null;

  const flush = () => {
    if (current !== null && current.added.length > 0) hunks.push(current);
    current = null;
  };

  for (const line of diffText.split(/\r?\n/u)) {
    if (line.startsWith("+++ ")) {
      flush();
      const target = line.slice(4).trim();
      filePath = target === "/dev/null" ? null : target.replace(/^b\//u, "");
      continue;
    }
    if (line.startsWith("@@")) {
      flush();
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
      current = filePath === null || hunk === null
        ? null
        : { filePath, startLine: Number(hunk[1]), added: [], removed: [] };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }

  flush();
  return hunks;
}

function measureOverlongCorpus(lines, limit) {
  let characters = 0, maximum = 0;
  for (const text of lines) {
    if (text.length <= limit) continue;
    characters += text.length;
    maximum = Math.max(maximum, text.length);
  }
  return { characters, maximum };
}

export function findViolations(diffText, limit = MAX_LINE_LENGTH) {
  const violations = [];

  for (const hunk of parseHunks(diffText)) {
    if (!isProductionPath(hunk.filePath)) continue;
    const added = measureOverlongCorpus(hunk.added, limit);
    const removed = measureOverlongCorpus(hunk.removed, limit);
    // Compare the overlong corpus within the whole hunk. Formatting can split one
    // compressed source line into many lines without positionally pairing them, but
    // neither the corpus size nor its longest line may grow.
    if (added.characters <= removed.characters && added.maximum <= removed.maximum) continue;
    violations.push({
      filePath: hunk.filePath,
      lineNumber: hunk.startLine,
      addedLongCharacters: added.characters,
      removedLongCharacters: removed.characters,
      addedMaxLineLength: added.maximum,
      removedMaxLineLength: removed.maximum
    });
  }

  return violations;
}

export function explain(violations, limit = MAX_LINE_LENGTH) {
  const shown = violations.slice(0, REPORT_LIMIT);
  const found = shown.map((v) => `  ${v.filePath}:${v.lineNumber}  overlong characters ${v.removedLongCharacters} -> ${v.addedLongCharacters}; longest line ${v.removedMaxLineLength} -> ${v.addedMaxLineLength}`);
  if (violations.length > shown.length) {
    found.push(`  ... and ${violations.length - shown.length} more (${violations.length} total)`);
  }

  return [
    "=".repeat(78),
    `G36 line-density FAILED — ${violations.length} production hunk(s) increased overlong content`,
    "=".repeat(78),
    "",
    "WHAT FAILED",
    ...found,
    "",
    "THE RULE",
    `  In each production diff hunk, added lines longer than ${limit} characters may`,
    "  increase neither their total characters nor their longest line. Total means the",
    `  complete line length: a ${limit + 1}-character line contributes ${limit + 1}, not 1.`,
    `  An all-new hunk starts from zero, so every added line must be at most ${limit} characters.`,
    "  You are never asked to refactor a line you did not write.",
    "",
    "IF YOU DID NOT COMPRESS ANYTHING, YOU ARE PROBABLY STILL RIGHT",
    "  Most first-time failures here are not someone shaving lines. They are someone",
    "  writing new code in the style of the code already around it — and in the files",
    "  this gate guards, that style is one very long line. That is a real condition of",
    "  this repository, not a mistake you made, and this gate does not ask you to fix",
    "  it. Restoring the existing compressed code is its own tracked work (PLT-LineHonesty,",
    "  task_7fc88830d00f0b8157a498a85c); doing it opportunistically inside an unrelated",
    "  change will collide with it. Your obligation is bounded to the hunks listed above.",
    "",
    "WHY THIS GATE EXISTS — read this before you try to satisfy it",
    "  G32 (line-budget) enforces a per-module ceiling on production lines. It counts",
    "  newlines and nothing else:",
    "",
    "      const lines = body.split(/\\r?\\n/u);",
    "      return lines.length - (lines.at(-1) === \"\" ? 1 : 0);",
    "",
    "  So joining two statements onto one line lowers G32's reading while removing no",
    "  code at all. That made line-joining a free, invisible way to pass a ceiling —",
    "  and it was used. Measured on this repository:",
    "",
    "      packages/*/src/**  (governed by G32)     92.8 characters per line",
    "      tools/**/*.mjs     (not governed)        48.1 characters per line",
    "",
    "  Same repository, same authors, same period, 1.93x apart. The modules whose",
    "  ceiling could not be raised at all sat at 97.0% average utilisation — three of",
    "  them at exactly 100.0% — while raisable modules sat at 75.8%. Pressure with no",
    "  legitimate outlet went into the lines.",
    "",
    "  Compressed lines do not reduce complexity. They hide it, and they corrupt the",
    "  number every future ceiling decision is judged against.",
    "",
    "YOU ALMOST CERTAINLY DO NOT NEED TO COMPRESS",
    "  Every module ceiling and design limit was doubled so that no one has to. If you",
    "  are near a ceiling now, that is a real signal about the module, not a formatting",
    "  problem. Check your headroom before assuming you are stuck:",
    "",
    "      node tools/gates/line-budget.mjs --base origin/main",
    "",
    "GOVERNING STANDARD",
    `  ${STANDARD_PATH}`,
    "    line 11: 300 lines is the recommended design target. Past it, reviewers should",
    "             actively check whether several responsibilities have been mixed.",
    "    line 15: When you hit a limit, fix it by splitting responsibilities across",
    "             directories and modules — NOT by deleting blank lines, compressing",
    "             expressions, or squeezing a file to just under the threshold.",
    "    line 30: Line shaving to pass a gate is prohibited.",
    "    line 31: Adding a new inline `harness:max-lines` override is prohibited.",
    "",
    "  (That file lives in the private harness ledger and is not present in a public",
    "   worktree, which is why the rules are quoted here in full.)",
    "",
    "HOW TO FIX, IN ORDER",
    "  1. Break the flagged line into ordinary multi-line statements. In almost every",
    "     case this is the whole fix and it takes under a minute.",
    "  2. If the file now reads as several responsibilities stacked together, split it",
    "     by responsibility into separate modules. That is the outcome the ceiling was",
    "     designed to produce.",
    "  3. If, and only if, the module genuinely exceeds its ceiling after that, raise",
    "     the ceiling the legitimate way: record a decision, then add a signed receipt",
    "     under tools/gates/receipts/ naming that decision id. Never edit",
    "     tools/gates/line-budgets.json without one.",
    "",
    "WHAT NOT TO DO",
    "  Do not lower the threshold, add an ignore entry, or skip this gate. Do not move",
    "  code into a non-production path to get it out of scope. Do not reformat unrelated",
    "  lines in the same hunk to offset new overlong content; that is not a legitimate fix.",
    "",
    "AUTHORITY",
    "  dec_12BE7EB602461E84F6F0BA019B — establishes this gate (standing policy)",
    "  dec_D848EF980B86800CFC6BD82125 — doubles every ceiling and design limit",
    "=".repeat(78)
  ].join("\n");
}

export function run({ rootDir = repoRoot(), base, head = "HEAD", limit = MAX_LINE_LENGTH } = {}) {
  const diffText = git(rootDir, ["diff", "-U0", "--no-color", `${base}...${head}`]);
  const violations = findViolations(diffText, limit);
  return { ok: violations.length === 0, violations };
}

export function main(argv = process.argv.slice(2)) {
  let base = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") base = argv[index + 1] ?? null;
  }
  if (base === null) {
    console.error("usage: node tools/gates/line-density.mjs --base <sha>");
    return 2;
  }
  try {
    const result = run({ base });
    if (!result.ok) {
      console.error(explain(result.violations));
      return 1;
    }
    console.log("G36 line-density: pass");
    return 0;
  } catch (error) {
    console.error(`G36 line-density: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
