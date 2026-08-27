import { pathToFileURL } from "node:url";
import { git, repoRoot } from "./git.mjs";
import { isBudgetedProductionPath } from "./module-policy.mjs";

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
      current =
        filePath === null || hunk === null ? null : { filePath, startLine: Number(hunk[1]), added: [], removed: [] };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }

  flush();
  return hunks;
}

/**
 * The length an overlong line contributes to both comparisons, with the two
 * decorations the canonical formatter owns removed: leading indentation and a
 * single trailing comma.
 *
 * Neither can be used to compress code, which is the only thing this gate exists
 * to catch. Compressing means joining statements onto one line, and that adds
 * content, which is still counted in full. Indentation is a function of nesting
 * depth; a trailing comma is a function of prettier.config.mjs's
 * `trailingComma: "all"`. But both do add to a line's raw length, so running the
 * formatter over an already-overlong line it does not otherwise touch grows that
 * line by a few characters — and the comparison then reads that as "you made this
 * longer" on a change that only ever shortened things. Measured case: restoring
 * packages/kernel/src/entity/disposition.ts cut its overlong total from 1405 to
 * 280 characters while its longest line went 279 -> 280, the entire delta being
 * one comma appended to a string literal whose contents are byte-identical.
 *
 * This is applied to both halves rather than only the longest-line one. The same
 * comma inflates the total by the same character, and a rule that discounted a
 * decoration in one comparison while counting it in the other would have no
 * principled reading.
 *
 * The >120 threshold test still uses raw length, because that is about what a
 * reader actually sees on screen.
 */
function comparableLength(text) {
  return text.trimStart().replace(/,$/u, "").length;
}

function measureOverlongCorpus(lines, limit) {
  let characters = 0,
    maximum = 0;
  for (const text of lines) {
    if (text.length <= limit) continue;
    const comparable = comparableLength(text);
    characters += comparable;
    maximum = Math.max(maximum, comparable);
  }
  return { characters, maximum };
}

export function findViolations(diffText, limit = MAX_LINE_LENGTH) {
  // Aggregate per file, not per hunk. `git diff -U0` is free to draw hunk
  // boundaries anywhere it finds a plausible anchor line, and a single restored
  // function routinely lands its removal in one hunk and the bulk of its
  // insertion in the next (git treats the tail of an unwrapped call as a fresh
  // insertion once the rewritten header no longer looks like a small edit of the
  // old one). Comparing hunk-by-hunk then blames a hunk for content that its own
  // sibling hunk freed up two lines earlier. G32 counts lines per file, and this
  // gate exists only to keep that count honest, so it must compare at the same
  // granularity G32 does.
  const byFile = new Map();

  for (const hunk of parseHunks(diffText)) {
    if (!isBudgetedProductionPath(hunk.filePath)) continue;
    const added = measureOverlongCorpus(hunk.added, limit);
    const removed = measureOverlongCorpus(hunk.removed, limit);
    const entry = byFile.get(hunk.filePath) ?? {
      addedCharacters: 0,
      removedCharacters: 0,
      addedMaximum: 0,
      removedMaximum: 0,
      firstLine: hunk.startLine,
    };
    entry.addedCharacters += added.characters;
    entry.removedCharacters += removed.characters;
    entry.addedMaximum = Math.max(entry.addedMaximum, added.maximum);
    entry.removedMaximum = Math.max(entry.removedMaximum, removed.maximum);
    byFile.set(hunk.filePath, entry);
  }

  const violations = [];
  for (const [filePath, entry] of byFile) {
    // Compare the overlong corpus across the whole file's diff. Formatting can split one
    // compressed source line into many lines without positionally pairing them, but
    // neither the file's overlong corpus size nor its longest line may grow.
    if (entry.addedCharacters <= entry.removedCharacters && entry.addedMaximum <= entry.removedMaximum) continue;
    violations.push({
      filePath,
      lineNumber: entry.firstLine,
      addedLongCharacters: entry.addedCharacters,
      removedLongCharacters: entry.removedCharacters,
      addedMaxLineLength: entry.addedMaximum,
      removedMaxLineLength: entry.removedMaximum,
    });
  }

  return violations;
}

export function explain(violations, limit = MAX_LINE_LENGTH) {
  const shown = violations.slice(0, REPORT_LIMIT);
  const found = shown.map(
    (v) =>
      `  ${v.filePath}:${v.lineNumber}  overlong characters ${v.removedLongCharacters} -> ${v.addedLongCharacters}; longest line ${v.removedMaxLineLength} -> ${v.addedMaxLineLength}`,
  );
  if (violations.length > shown.length) {
    found.push(`  ... and ${violations.length - shown.length} more (${violations.length} total)`);
  }

  return [
    "=".repeat(78),
    `G36 line-density FAILED — ${violations.length} budgeted production file(s) increased overlong content`,
    "=".repeat(78),
    "",
    "WHAT FAILED",
    ...found,
    "",
    "THE RULE",
    `  Across each budgeted production file's diff, added lines longer than ${limit} characters may`,
    "  increase neither their total characters nor their longest line. Total means the",
    `  complete line length: a ${limit + 1}-character line contributes ${limit + 1}, not 1.`,
    `  A file with no removed content starts from zero, so every added line must be at most ${limit} characters.`,
    "  You are never asked to refactor a line you did not write.",
    "",
    "IF YOU DID NOT COMPRESS ANYTHING, YOU ARE PROBABLY STILL RIGHT",
    "  Most first-time failures here are not someone shaving lines. They are someone",
    "  writing new code in the style of the code already around it — and in the files",
    "  this gate guards, that style is one very long line. That is a real condition of",
    "  this repository, not a mistake you made, and this gate does not ask you to fix",
    "  it. Restoring the existing compressed code is its own tracked work (PLT-LineHonesty,",
    "  task_7fc88830d00f0b8157a498a85c); doing it opportunistically inside an unrelated",
    "  change will collide with it. Your obligation is bounded to the files listed above.",
    "",
    "WHY THIS GATE EXISTS — read this before you try to satisfy it",
    "  G32 enforces per-module line ceilings and counts newlines and nothing else.",
    "  Joining statements can therefore lower its reading without removing code.",
    "  G36 closes that loophole by reusing G32's explicit budget scope: production",
    "  modules with a committed line budget. Budget-exempt production modules are",
    "  outside this gate because their lines cannot relieve or pressure a G32 ceiling.",
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
    "  code outside its budgeted module to get it out of scope. Do not reformat unrelated",
    "  lines in the same file to offset new overlong content; that is not a legitimate fix.",
    "",
    "AUTHORITY",
    "  dec_12BE7EB602461E84F6F0BA019B — establishes this gate (standing policy)",
    "  dec_D848EF980B86800CFC6BD82125 — doubles every ceiling and design limit",
    "=".repeat(78),
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
