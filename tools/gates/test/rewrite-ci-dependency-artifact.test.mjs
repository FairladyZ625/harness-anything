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

test("nightly and manual runs do not queue push or pull request runs", () => {
  assert.match(
    workflow,
    /^  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}-\$\{\{ github\.event_name == 'schedule' && 'schedule' \|\| github\.event_name == 'workflow_dispatch' && 'workflow_dispatch' \|\| 'ci' \}\}$/mu,
  );
  assert.match(workflow, /^  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/mu);
  assert.match(
    workflow,
    /^  HARNESS_TEST_QUARANTINE: \$\{\{ \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\) && 'run' \|\| 'skip' \}\}$/mu,
  );
});

test("the shared install job is scoped to PR, merge-group, and push artifact consumers", () => {
  const section = workflow.split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu).find((candidate) => candidate.startsWith("install:"));
  assert.ok(section);
  assert.match(
    section,
    /^    if: github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group' \|\| github\.event_name == 'push'/mu,
  );
});

test("every npm ci job primes the version-keyed Electron cache before installing", () => {
  const jobs = workflow.split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu).filter((section) => /^\s+- run: npm ci$/mu.test(section));
  assert.ok(jobs.length > 0);
  for (const job of jobs) {
    const cache = job.indexOf("- uses: ./.github/actions/electron-runtime-cache");
    const install = job.indexOf("- run: npm ci");
    assert.notEqual(cache, -1, "job with npm ci must use ./.github/actions/electron-runtime-cache");
    assert.ok(cache < install, "the Electron cache step must run before npm ci");
  }
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

// cost-budget-read-summary joins G38 shards under Node 24 and uses an unconditional
// github-script check (step 1) plus install-success guards on node-modules download instead
// of a separate fail-fast shell step; see cost-budget-reads.test.mjs G38 CI contract.
const installArtifactConsumers = () =>
  workflow
    .split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu)
    .filter(
      (section) =>
        !section.startsWith("cost-budget-read-summary:") &&
        /^    needs:.*\binstall\b/mu.test(section) &&
        section.includes("name: node-modules-${{ hashFiles('package-lock.json') }}"),
    );

test("every node-modules consumer fails fast when upstream install does not succeed", () => {
  const consumers = installArtifactConsumers();
  assert.ok(consumers.length >= 9, "expected every shared node_modules artifact consumer with a fail-fast step to be covered");
  for (const job of consumers) {
    const label = job.split(":")[0];
    assert.match(job, /name: Fail fast when the shared install did not succeed/u, label);
    assert.match(job, /if: needs\.install\.result != 'success'/u, label);
    assert.match(job, /skipping artifact download/u, label);
  }
});

test("node-modules download steps stay gated on upstream install success", () => {
  const consumers = installArtifactConsumers();
  for (const job of consumers) {
    const label = job.split(":")[0];
    let cursor = 0;
    let downloads = 0;
    while (cursor < job.length) {
      const start = job.indexOf("- uses: actions/download-artifact@v4", cursor);
      if (start === -1) {
        break;
      }
      const end = job.indexOf("- uses: actions/download-artifact@v4", start + 1);
      const block = end === -1 ? job.slice(start) : job.slice(start, end);
      if (block.includes("name: node-modules-")) {
        downloads++;
        const guard = block.slice(0, block.indexOf("with:"));
        assert.match(guard, /if:.*needs\.install\.result == 'success'/u, label);
      }
      cursor = start + 1;
    }
    assert.ok(downloads > 0, label);
  }
});

test("a node-modules consumer without an install-success guard is rejected", () => {
  const quickGates = workflow
    .split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu)
    .find((section) => section.startsWith("quick-gates:"));
  assert.ok(quickGates);
  const offending = quickGates.replace(
    /- uses: actions\/download-artifact@v4\n\s+if: needs\.install\.result == 'success'\n/,
    "- uses: actions/download-artifact@v4\n",
  );
  const start = offending.indexOf("- uses: actions/download-artifact@v4");
  const block = offending.slice(start, offending.indexOf("with:", start) + 80);
  assert.throws(
    () => assert.match(block, /if:.*needs\.install\.result == 'success'/u),
    /AssertionError/,
    "unguarded download-artifact must not pass the install-success contract",
  );
});

test("cost-budget-read-summary keeps the G38 github-script first and guards node-modules download", () => {
  const section = workflow
    .split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu)
    .find((candidate) => candidate.startsWith("cost-budget-read-summary:"));
  assert.ok(section);
  assert.doesNotMatch(section, /name: Fail fast when the shared install did not succeed/u);
  assert.match(section, /^      - name: Check the G38 read jobs\n        uses: actions\/github-script@v7/mu);
  assert.match(
    section,
    /- uses: actions\/download-artifact@v4\n\s+if: env\.G38_SKIP_READS != 'true' && needs\.install\.result == 'success'/u,
  );
});

test("crlf checkout orders PR artifact consumption and retains its nightly lane", () => {
  const section = workflow
    .split(/^  (?=[A-Za-z0-9_-]+:\s*$)/mu)
    .find((candidate) => candidate.startsWith("crlf-checkout:"));
  assert.ok(section);
  assert.match(section, /^    needs: install/mu);
  assert.match(
    section,
    /^    if: always\(\) && \(github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group' \|\| github\.event_name == 'push'\)$/mu,
  );
  assert.match(
    section,
    /- run: npm ci\n\s+if: github\.event_name != 'pull_request' && github\.event_name != 'merge_group' && github\.event_name != 'push'/u,
  );
  assert.match(
    section,
    /- uses: actions\/download-artifact@v4\n\s+if: needs\.install\.result == 'success' && \(github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group' \|\| github\.event_name == 'push'\)/u,
  );
});
