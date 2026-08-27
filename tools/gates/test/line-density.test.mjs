// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { explain, findViolations, MAX_LINE_LENGTH, parseHunks } from "../line-density.mjs";

const LONG = "x".repeat(MAX_LINE_LENGTH + 1);
const LONGER = "x".repeat(MAX_LINE_LENGTH + 50);

function hunk(filePath, startLine, { added = [], removed = [] }) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${startLine},${removed.length} +${startLine},${added.length} @@`,
    ...removed.map((body) => `-${body}`),
    ...added.map((body) => `+${body}`),
  ].join("\n");
}

test("hunks carry their destination path and start line", () => {
  const parsed = parseHunks(hunk("packages/kernel/src/a.ts", 12, { added: ["one", "two"] }));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].filePath, "packages/kernel/src/a.ts");
  assert.equal(parsed[0].startLine, 12);
  assert.deepEqual(parsed[0].added, ["one", "two"]);
});

test("a purely added overlong line is rejected", () => {
  const violations = findViolations(hunk("packages/kernel/src/a.ts", 5, { added: [LONG] }));
  assert.deepEqual(violations, [
    {
      filePath: "packages/kernel/src/a.ts",
      lineNumber: 5,
      addedLongCharacters: LONG.length,
      removedLongCharacters: 0,
      addedMaxLineLength: LONG.length,
      removedMaxLineLength: 0,
    },
  ]);
  assert.match(explain(violations), /overlong characters 0 -> 121; longest line 0 -> 121/u);
});

test("a line exactly at the limit passes", () => {
  assert.deepEqual(findViolations(hunk("packages/kernel/src/a.ts", 5, { added: ["x".repeat(MAX_LINE_LENGTH)] })), []);
});

test("a one-to-one edit that shortens an overlong line is allowed", () => {
  assert.deepEqual(findViolations(hunk("packages/kernel/src/a.ts", 5, { added: [LONG], removed: [LONGER] })), []);
});

test("a one-to-one edit that lengthens an overlong line is rejected", () => {
  const violations = findViolations(hunk("packages/kernel/src/a.ts", 5, { added: [LONGER], removed: [LONG] }));
  assert.deepEqual(violations, [
    {
      filePath: "packages/kernel/src/a.ts",
      lineNumber: 5,
      addedLongCharacters: LONGER.length,
      removedLongCharacters: LONG.length,
      addedMaxLineLength: LONGER.length,
      removedMaxLineLength: LONG.length,
    },
  ]);
});

test("a one-to-many restoration with less overlong content is allowed", () => {
  assert.deepEqual(
    findViolations(
      hunk("packages/kernel/src/a.ts", 5, {
        added: ["x".repeat(200), LONG],
        removed: ["x".repeat(400)],
      }),
    ),
    [],
  );
});

test("a one-to-many change with more overlong content is rejected", () => {
  const violations = findViolations(
    hunk("packages/kernel/src/a.ts", 5, {
      added: [LONG, LONG],
      removed: ["x".repeat(200)],
    }),
  );
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    filePath: "packages/kernel/src/a.ts",
    lineNumber: 5,
    addedLongCharacters: LONG.length * 2,
    removedLongCharacters: 200,
    addedMaxLineLength: LONG.length,
    removedMaxLineLength: 200,
  });
});

test("a many-to-one compression is rejected when the longest line grows even as the total shrinks", () => {
  const violations = findViolations(
    hunk("packages/kernel/src/a.ts", 5, {
      added: ["x".repeat(1200)],
      removed: Array.from({ length: 10 }, () => "x".repeat(130)),
    }),
  );
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    filePath: "packages/kernel/src/a.ts",
    lineNumber: 5,
    addedLongCharacters: 1200,
    removedLongCharacters: 1300,
    addedMaxLineLength: 1200,
    removedMaxLineLength: 130,
  });
});

// Measured on the real restoration of packages/kernel/src/entity/disposition.ts:
// overlong total 1405 -> 280 (a large reduction, exactly what restoration should
// do) while the longest line went 279 -> 280. The whole one-character delta was a
// trailing comma prettier.config.mjs's `trailingComma: "all"` appends to a string
// literal whose contents are byte-identical. Nothing was compressed, and there is
// no way to compress code with a comma.
test("a formatter's trailing comma on an otherwise untouched overlong line is not a longer longest line", () => {
  const body = "x".repeat(279);
  const violations = findViolations(
    hunk("packages/kernel/src/a.ts", 5, {
      added: [`${body},`],
      removed: [body],
    }),
  );
  assert.deepEqual(violations, []);
});

// Same reasoning for indentation: it is a function of nesting depth, so deepening
// a block grows its lines without joining anything onto them. Measured on the real
// restoration of packages/kernel/src/projection/entity-declaration-projection.ts,
// whose longest line went 124 -> 127 as prettier nested it two spaces deeper and
// appended a comma to an otherwise byte-identical template literal.
test("re-indenting an otherwise untouched overlong line is not an increase in either half", () => {
  const body = "x".repeat(200);
  const violations = findViolations(
    hunk("packages/kernel/src/a.ts", 5, {
      added: [`      ${body},`],
      removed: [`  ${body}`],
    }),
  );
  assert.deepEqual(violations, []);
});

// The narrowing above must not become a general exemption: one more character of
// real content past the baseline is still a longer longest line, comma or not.
test("real content added past the baseline is still rejected despite the trailing-comma allowance", () => {
  const violations = findViolations(
    hunk("packages/kernel/src/a.ts", 5, {
      added: [`${"x".repeat(280)},`],
      removed: ["x".repeat(279)],
    }),
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].addedMaxLineLength, 280);
  assert.equal(violations[0].removedMaxLineLength, 279);
});

test("a restoration split across git's own hunk boundaries is allowed", () => {
  // `git diff -U0` can put a removal in one hunk and the bulk of the matching
  // insertion in the very next hunk once the rewritten header no longer looks
  // like a small edit of the old one. This is exactly what happened restoring
  // packages/kernel/src/domain/fact-event.ts: the compressed one-liner was
  // removed in one hunk, and most of its expansion landed in a second,
  // zero-removal hunk immediately after. Per-hunk comparison blames the second
  // hunk for content the first hunk already paid for; per-file comparison must
  // not.
  const first = hunk("packages/kernel/src/a.ts", 39, {
    added: ["function body(records) {"],
    removed: ["x".repeat(600)],
  });
  const second = hunk("packages/kernel/src/a.ts", 51, {
    added: [LONG, "  return records.join(newline);", "}"],
    removed: [],
  });
  assert.deepEqual(findViolations([first, second].join("\n")), []);
});

test("a genuinely new overlong line is still rejected when a sibling hunk in the same file is unrelated", () => {
  const first = hunk("packages/kernel/src/a.ts", 5, {
    added: ["const a = 1;"],
    removed: ["const a = 1;"],
  });
  const second = hunk("packages/kernel/src/a.ts", 40, { added: [LONG] });
  const violations = findViolations([first, second].join("\n"));
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    filePath: "packages/kernel/src/a.ts",
    lineNumber: 5,
    addedLongCharacters: LONG.length,
    removedLongCharacters: 0,
    addedMaxLineLength: LONG.length,
    removedMaxLineLength: 0,
  });
});

test("paths outside G32's explicit budget scope are out of scope", () => {
  assert.deepEqual(findViolations(hunk("tools/gates/line-density.mjs", 1, { added: [LONG] })), []);
  assert.deepEqual(findViolations(hunk("packages/kernel/test/a.test.ts", 1, { added: [LONG] })), []);
});

test("a pure deletion contributes no violations", () => {
  assert.deepEqual(findViolations(hunk("packages/kernel/src/a.ts", 5, { removed: [LONG] })), []);
});

test("the rejection carries the whole specification, not just a pointer", () => {
  const message = explain([
    {
      filePath: "packages/kernel/src/a.ts",
      lineNumber: 5,
      addedLongCharacters: 400,
      removedLongCharacters: 0,
      addedMaxLineLength: 400,
      removedMaxLineLength: 0,
    },
  ]);

  // what failed, and the rule
  assert.match(message, /packages\/kernel\/src\/a\.ts:5/u);
  assert.match(message, /must be at most 120 characters/u);
  assert.match(message, /complete line length: a 121-character line contributes 121, not 1/u);
  assert.match(message, /never asked to refactor a line you did not write/u);

  // the mechanism it closes, scoped exactly like G32
  assert.match(message, /counts\s+newlines and nothing else/u);
  assert.match(message, /explicit budget scope/u);
  assert.match(message, /Budget-exempt production modules are\s+outside this gate/u);

  // the standard quoted in full, because a public worktree cannot read the ledger
  assert.match(message, /file-complexity-structural-decomposition-standard\.md/u);
  assert.match(message, /Line shaving to pass a gate is prohibited/u);
  assert.match(message, /NOT by deleting blank lines, compressing/u);
  assert.match(message, /not present in a public/u);

  // the ordered fix path, ending at the legitimate ceiling-raise route
  assert.match(message, /Break the flagged line into ordinary multi-line statements/u);
  assert.match(message, /split it\s+by responsibility/u);
  assert.match(message, /signed receipt/u);
  assert.match(message, /Never edit\s+tools\/gates\/line-budgets\.json without one/u);

  // tell the honest first-time reader that the house style, not their diff, is the cause
  assert.match(message, /IF YOU DID NOT COMPRESS ANYTHING, YOU ARE PROBABLY STILL RIGHT/u);
  assert.match(message, /writing new code in the style of the code already around it/u);
  assert.match(message, /not a mistake you made/u);
  assert.match(message, /task_7fc88830d00f0b8157a498a85c/u);
  assert.match(message, /obligation is bounded to the files listed above/u);

  // preempt the reflex the gate is most likely to provoke
  assert.match(message, /ceiling and design limit was doubled/u);
  assert.match(message, /node tools\/gates\/line-budget\.mjs --base origin\/main/u);

  // what not to do, and where the authority comes from
  assert.match(message, /Do not lower the threshold/u);
  assert.match(message, /dec_12BE7EB602461E84F6F0BA019B/u);
  assert.match(message, /dec_D848EF980B86800CFC6BD82125/u);
});

test("a truncated report still states the true total", () => {
  const many = Array.from({ length: 25 }, (unused, index) => ({
    filePath: "packages/kernel/src/a.ts",
    lineNumber: index + 1,
    addedLongCharacters: 400,
    removedLongCharacters: 0,
    addedMaxLineLength: 400,
    removedMaxLineLength: 0,
  }));
  const message = explain(many);
  assert.match(message, /25 budgeted production file\(s\) increased overlong content/u);
  assert.match(message, /and 5 more \(25 total\)/u);
});
