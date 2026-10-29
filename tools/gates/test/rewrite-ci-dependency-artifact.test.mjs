// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// The patterns below are written against LF and match across an explicit "\n" inside a run block.
// The crlf-checkout lane checks this file out with core.autocrlf=true, where that "\n" is preceded
// by "\r" and the PR artifact ordering assertion misses a block that is right there. The workflow's
// bytes are not the assertion, so the reader normalizes; the patterns keep their exact content.
const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/rewrite-ci.yml"), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const attributes = readFileSync(path.join(process.cwd(), ".gitattributes"), "utf8");

test("the shared install job is scoped to PR and push artifact consumers", () => {
  const section = workflow.split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu).find((candidate) => candidate.startsWith("install:"));
  assert.ok(section);
  assert.match(section, /^    if: github\.event_name == 'pull_request' \|\| github\.event_name == 'push'/mu);
});

test("the dependency lockfile stays byte-stable in the CRLF checkout lane", () => {
  assert.match(attributes, /^package-lock\.json text eol=lf$/mu);
});

test("every shared dependency consumer refreshes the daemon build marker after extraction", () => {
  const jobs = workflow
    .split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu)
    .filter((section) => section.includes("actions/download-artifact@v4"));
  assert.ok(jobs.length > 0);
  for (const job of jobs) {
    assert.match(
      job,
      /actions\/download-artifact@v4[\s\S]*?run: tar -xf "\$RUNNER_TEMP\/node-modules\.tar" && touch packages\/daemon\/dist\/build-id\.txt/u,
    );
  }
});

test("dependency consumers remain fail-closed when the shared install fails", () => {
  const consumers = workflow
    .split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu)
    .filter((section) => section.includes("needs: install"));
  assert.ok(consumers.length > 0);
  for (const job of consumers) {
    assert.match(job, /^    if: always\(\) && .*github\.event_name/mu);
  }
});

test("Windows integration shards preserve runner diagnostics after failures", () => {
  const section = workflow
    .split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu)
    .find((candidate) => candidate.startsWith("windows-integration-shard:"));
  assert.ok(section);
  assert.match(section, /HARNESS_TEST_DIAGNOSTICS_DIR:\s*tmp\/node-test-diagnostics/u);
  assert.match(section, /name: Preserve Windows test diagnostics/u);
  assert.match(section, /if: always\(\)[\s\S]*?actions\/upload-artifact@v4/u);
  assert.match(section, /path: tmp\/node-test-diagnostics\//u);
  assert.match(section, /retention-days: 14/u);
});

test("crlf checkout orders PR artifact consumption and retains its nightly lane", () => {
  const section = workflow
    .split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu)
    .find((candidate) => candidate.startsWith("crlf-checkout:"));
  assert.ok(section);
  assert.match(section, /^    needs: install/mu);
  assert.match(
    section,
    /^    if: always\(\) && \(github\.event_name == 'pull_request' \|\| github\.event_name == 'push'\)$/mu,
  );
  assert.match(section, /- run: npm ci\n\s+if: github\.event_name != 'pull_request' && github\.event_name != 'push'/u);
  assert.match(
    section,
    /- uses: actions\/download-artifact@v4\n\s+if: github\.event_name == 'pull_request' \|\| github\.event_name == 'push'/u,
  );
});
