import { pathToFileURL } from "node:url";
import { git, repoRoot } from "./git.mjs";
import { isProductionPath } from "./module-policy.mjs";

export const MAX_LINE_LENGTH = 120;

const STANDARD_PATH = "harness/governance/standards/file-complexity-structural-decomposition-standard.md";
const REPORT_LIMIT = 20;

/**
 * Parse `git diff -U0` output into the added lines it introduces, keeping each
 * line's destination path and line number so a violation can be pointed at.
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

export function findViolations(diffText, limit = MAX_LINE_LENGTH) {
  const violations = [];

  for (const hunk of parseHunks(diffText)) {
    if (!isProductionPath(hunk.filePath)) continue;
    for (const [index, text] of hunk.added.entries()) {
      if (text.length <= limit) continue;
      // A modified line is paired positionally with the line it replaced. Editing an
      // already-long line is allowed as long as it does not grow: the corpus can only
      // shrink, and nobody is forced to refactor a line they did not write.
      const replaced = hunk.removed[index];
      if (replaced !== undefined && text.length <= replaced.length) continue;
      violations.push({
        filePath: hunk.filePath,
        lineNumber: hunk.startLine + index,
        length: text.length,
        previousLength: replaced === undefined ? null : replaced.length
      });
    }
  }

  return violations;
}

export function explain(violations, limit = MAX_LINE_LENGTH) {
  const shown = violations.slice(0, REPORT_LIMIT);
  const found = shown.map((v) => v.previousLength === null
    ? `  ${v.filePath}:${v.lineNumber}  new line, ${v.length} characters`
    : `  ${v.filePath}:${v.lineNumber}  grew ${v.previousLength} -> ${v.length} characters`);
  if (violations.length > shown.length) {
    found.push(`  ... and ${violations.length - shown.length} more (${violations.length} total)`);
  }

  return [
    "=".repeat(78),
    `G36 line-density FAILED — ${violations.length} added production line(s) over ${limit} characters`,
    "=".repeat(78),
    "",
    "WHAT FAILED",
    ...found,
    "",
    "THE RULE",
    `  A production line you create, or make longer, must be at most ${limit} characters.`,
    "  Editing an existing long line is fine as long as you do not make it longer.",
    "  You are never asked to refactor a line you did not write.",
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
    "  lines to buy budget — this gate is a ratchet precisely so that never helps.",
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
