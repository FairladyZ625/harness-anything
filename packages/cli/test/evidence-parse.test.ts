// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli/parse-args.ts";

// These cases pin the behavior of the --evidence parser when PATH cannot be
// encoded in the `type:PATH:summary` format. They were split out of
// parse-args.test.ts so that file stays under the 700-line test-file budget
// while keeping a focused home for evidence-specific regressions. See
// task_01KZ92RAJ1HXRSYDY4JP6APRCN.

test("parseArgs rejects --evidence values where PATH silently chopped a colon (URL scheme / drive letter)", () => {
  // The 'type:PATH:summary' format has no way to encode ':' inside PATH.
  // Without a guard, `url:https://x.com:summary` parses as type=url, path=https,
  // summary=//x.com:summary and is persisted to progress.md as a miscategorized pointer.
  // The same signature catches Windows drive letters (file:C:/... → path=C).
  const urlCases = [
    "url:https://github.com/o/r/pull/1:summary text",
    "url:https://x.com:摘要",
    "url:https://example.com"
  ];
  for (const evidence of urlCases) {
    const parsed = parseArgs(["task", "progress", "append", "task_1", "--text", "x", "--evidence", evidence]);
    assert.equal(parsed.ok, false, `expected rejection for ${evidence}`);
    if (parsed.ok) continue;
    assert.equal(parsed.error.code, "invalid_evidence", `code for ${evidence}`);
    assert.match(parsed.error.hint, /PATH cannot contain ':'/u, `hint names the colon-in-PATH cause for ${evidence}`);
    assert.match(parsed.error.hint, /URL scheme/u, `hint names URL scheme cause for ${evidence}`);
    assert.match(parsed.error.hint, /--evidence url:<short-label>:https:/u, `hint offers a copyable URL form for ${evidence}`);
  }
  const driveCases = [
    "file:C:/Users/me/report.md:summary",
    "file:D:\\path:summary"
  ];
  for (const evidence of driveCases) {
    const parsed = parseArgs(["task", "progress", "append", "task_1", "--text", "x", "--evidence", evidence]);
    assert.equal(parsed.ok, false, `expected rejection for ${evidence}`);
    if (parsed.ok) continue;
    assert.equal(parsed.error.code, "invalid_evidence", `code for ${evidence}`);
    assert.match(parsed.error.hint, /Windows drive letter/u, `hint names Windows drive cause for ${evidence}`);
    assert.match(parsed.error.hint, /POSIX-style path/u, `hint suggests POSIX path for ${evidence}`);
  }
});

test("parseArgs still accepts --evidence values whose PATH has no colon and keeps colon-in-summary semantics", () => {
  // Regression: summaries may freely contain colons; PATH looks like a normal relative path.
  const accepted = [
    { value: "log:artifacts/run.log:passed", expectPath: "artifacts/run.log", expectSummary: "passed" },
    { value: "file:path/to/a.md:some:colon:summary", expectPath: "path/to/a.md", expectSummary: "some:colon:summary" },
    { value: "url:github.com/o/r/pull/1:PR review", expectPath: "github.com/o/r/pull/1", expectSummary: "PR review" },
    { value: "test:artifacts/unit.log:green", expectPath: "artifacts/unit.log", expectSummary: "green" }
  ];
  for (const { value, expectPath, expectSummary } of accepted) {
    const parsed = parseArgs(["task", "progress", "append", "task_1", "--text", "x", "--evidence", value]);
    assert.equal(parsed.ok, true, `expected accept for ${value}`);
    if (!parsed.ok) continue;
    assert.equal(parsed.value.action.kind, "progress-append");
    if (parsed.value.action.kind !== "progress-append") continue;
    const evidence = parsed.value.action.evidence?.[0];
    assert.equal(evidence?.path, expectPath, `path for ${value}`);
    assert.equal(evidence?.summary, expectSummary, `summary for ${value}`);
  }
});
