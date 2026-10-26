// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/rewrite-ci.yml"), "utf8");
const attributes = readFileSync(path.join(process.cwd(), ".gitattributes"), "utf8");

test("the dependency lockfile stays byte-stable in the CRLF checkout lane", () => {
  assert.match(attributes, /^package-lock\.json text eol=lf$/mu);
});

test("every shared dependency consumer refreshes the daemon build marker after extraction", () => {
  const jobs = workflow
    .split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu)
    .filter((section) => section.includes("actions/download-artifact@v4"));
  assert.ok(jobs.length > 0);
  for (const job of jobs) {
    assert.match(job, /needs: install/u);
    assert.match(
      job,
      /actions\/download-artifact@v4[\s\S]*?run: tar -xf "\$RUNNER_TEMP\/node-modules\.tar" && touch packages\/daemon\/dist\/build-id\.txt/u,
    );
  }
});
