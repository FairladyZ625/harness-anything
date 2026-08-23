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
    ...added.map((body) => `+${body}`)
  ].join("\n");
}

test("hunks carry their destination path and start line", () => {
  const parsed = parseHunks(hunk("packages/kernel/src/a.ts", 12, { added: ["one", "two"] }));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].filePath, "packages/kernel/src/a.ts");
  assert.equal(parsed[0].startLine, 12);
  assert.deepEqual(parsed[0].added, ["one", "two"]);
});

test("a newly created long line is rejected and reported as new", () => {
  const violations = findViolations(hunk("packages/kernel/src/a.ts", 5, { added: [LONG] }));
  assert.deepEqual(violations, [{
    filePath: "packages/kernel/src/a.ts",
    lineNumber: 5,
    length: LONG.length,
    previousLength: null
  }]);
  assert.match(explain(violations), /new line, \d+ characters/u);
});

test("a line exactly at the limit passes", () => {
  assert.deepEqual(findViolations(hunk("packages/kernel/src/a.ts", 5, { added: ["x".repeat(MAX_LINE_LENGTH)] })), []);
});

test("editing an existing long line without growing it is allowed", () => {
  assert.deepEqual(findViolations(hunk("packages/kernel/src/a.ts", 5, { added: [LONG], removed: [LONG] })), []);
  assert.deepEqual(findViolations(hunk("packages/kernel/src/a.ts", 5, { added: [LONG], removed: [LONGER] })), []);
});

test("growing an already-long line is rejected and names both lengths", () => {
  const violations = findViolations(hunk("packages/kernel/src/a.ts", 5, { added: [LONGER], removed: [LONG] }));
  assert.deepEqual(violations, [{
    filePath: "packages/kernel/src/a.ts",
    lineNumber: 5,
    length: LONGER.length,
    previousLength: LONG.length
  }]);
  assert.match(explain(violations), /grew \d+ -> \d+ characters/u);
});

test("an added line beyond the replaced ones is new, not a pairing", () => {
  const violations = findViolations(hunk("packages/kernel/src/a.ts", 5, { added: [LONG, LONG], removed: [LONG] }));
  assert.deepEqual(violations.map((v) => [v.lineNumber, v.previousLength]), [[6, null]]);
});

test("non-production paths are out of scope", () => {
  assert.deepEqual(findViolations(hunk("tools/gates/line-density.mjs", 1, { added: [LONG] })), []);
  assert.deepEqual(findViolations(hunk("packages/kernel/test/a.test.ts", 1, { added: [LONG] })), []);
});

test("a pure deletion contributes no violations", () => {
  assert.deepEqual(findViolations(hunk("packages/kernel/src/a.ts", 5, { removed: [LONG] })), []);
});

test("the rejection carries the whole specification, not just a pointer", () => {
  const message = explain([{ filePath: "packages/kernel/src/a.ts", lineNumber: 5, length: 400, previousLength: null }]);

  // what failed, and the rule
  assert.match(message, /packages\/kernel\/src\/a\.ts:5/u);
  assert.match(message, /must be at most 120 characters/u);
  assert.match(message, /never asked to refactor a line you did not write/u);

  // the mechanism it closes, with the measurement that proves the pressure is real
  assert.match(message, /counts\s+newlines and nothing else/u);
  assert.match(message, /92\.8 characters per line/u);
  assert.match(message, /48\.1 characters per line/u);
  assert.match(message, /1\.93x apart/u);

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
    length: 400,
    previousLength: null
  }));
  const message = explain(many);
  assert.match(message, /25 added production line\(s\) over 120 characters/u);
  assert.match(message, /and 5 more \(25 total\)/u);
});
