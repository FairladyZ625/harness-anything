// harness-test-tier: contract
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const lines = workflow.split(/\r?\n/u);

function topLevelValue(key) {
  const line = lines.find((candidate) => new RegExp(`^${key}:`, "u").test(candidate));
  if (line === undefined) return null;
  return line.slice(key.length + 1).trim();
}

function jobs() {
  const start = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  assert.notEqual(start, -1, "release workflow must declare jobs");
  const parsed = new Map();
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^  ([A-Za-z0-9_-]+):\s*$/u.exec(lines[index]);
    if (match) {
      current = { id: match[1], lines: [] };
      parsed.set(current.id, current);
      continue;
    }
    if (current) current.lines.push(lines[index]);
  }
  return parsed;
}

function jobDetails(job) {
  const permissions = new Map();
  let ifExpression = null;
  for (let index = 0; index < job.lines.length; index += 1) {
    const line = job.lines[index];
    const ifMatch = /^    if:\s*(.+?)\s*$/u.exec(line);
    if (ifMatch) ifExpression = ifMatch[1];
    if (/^    permissions:\s*$/u.test(line)) {
      for (let cursor = index + 1; cursor < job.lines.length; cursor += 1) {
        const entry = /^      ([A-Za-z-]+):\s*(.+?)\s*$/u.exec(job.lines[cursor]);
        if (!entry) break;
        permissions.set(entry[1], entry[2]);
      }
    }
  }
  return { permissions, ifExpression, body: job.lines.join("\n") };
}

test("release workflow keeps write permissions on the jobs that need them", () => {
  assert.equal(topLevelValue("permissions"), "{}", "top-level permissions must deny every scope");

  const expected = new Map([
    ["validate", new Map([["contents", "read"]])],
    ["build-app", new Map([["contents", "read"]])],
    [
      "publish-npm",
      new Map([
        ["contents", "read"],
        ["id-token", "write"],
      ]),
    ],
    ["github-release", new Map([["contents", "write"]])],
    ["upload-update-feed", new Map([["contents", "read"]])],
  ]);
  const parsed = jobs();
  for (const [jobId, permissions] of expected) {
    const job = parsed.get(jobId);
    assert.ok(job, `release workflow must define job ${jobId}`);
    assert.deepEqual(
      Object.fromEntries(jobDetails(job).permissions),
      Object.fromEntries(permissions),
      `${jobId} permissions`,
    );
  }
});

test("workflow_dispatch is a rehearsal: only validate runs", () => {
  const parsed = jobs();
  for (const jobId of ["build-app", "publish-npm", "github-release", "upload-update-feed"]) {
    const job = parsed.get(jobId);
    assert.ok(job, `release workflow must define job ${jobId}`);
    assert.equal(jobDetails(job).ifExpression, "github.event_name == 'push'", `${jobId} must run only for tag pushes`);
  }

  const validate = parsed.get("validate");
  assert.ok(validate, "release workflow must define validate");
  assert.equal(jobDetails(validate).ifExpression, null, "validate must run for both rehearsal and tag push");
});

test("release validate checks out the exact tag and runs the declared PR gate", () => {
  const validate = jobDetails(jobs().get("validate")).body;
  assert.match(validate, /ref:\s*\$\{\{\s*inputs\.release_tag \|\| github\.ref\s*\}\}/u);
  assert.match(validate, /fetch-depth:\s*0/u);
  assert.match(validate, /npm run check:pr/u, "validate must run the declared PR aggregate");
  assert.doesNotMatch(validate, /--exclude[^\n]*(?:test-fast|test-contract|test-integration|test-gui)/u);
});

test("a publishing tag is contained in main or a release line", () => {
  const validate = jobDetails(jobs().get("validate")).body;
  assert.match(validate, /git merge-base --is-ancestor/u);
  assert.match(validate, /refs\/remotes\/origin\/main/u);
  assert.match(validate, /refs\/remotes\/origin\/release/u);
  assert.match(validate, /refs\/tags\/\$\{?tag\}?\^\{commit\}/u);
});

test("third-party actions are pinned to a commit", () => {
  const actionReferences = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
  assert.ok(actionReferences.length > 0, "release workflow must use actions");
  for (const reference of actionReferences) {
    assert.match(
      reference,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u,
      `${reference} must be pinned to a 40-character commit`,
    );
  }
});
