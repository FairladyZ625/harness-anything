// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Text } from "@harness-anything/kernel";
import {
  AuthorityCanonicalPublicationNotFoundError,
  createGitCanonicalPublicationInspector
} from "../src/authority/production/publication-evidence.ts";

test("publication evidence yields between blob reads so recovery admission timers remain live", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-evidence-responsive-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");
  const previousCommit = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-q", "-b", "session");
  const opId = "namespace:test-responsive-recovery";
  const semanticDigest = "a".repeat(64);
  mkdirSync(path.join(root, "attribution-events"));
  writeFileSync(
    path.join(root, "attribution-events", `${sha256Text(opId)}.jsonl`),
    `${JSON.stringify({
      schema: "attribution-event/v1",
      opId,
      authorityIntegrity: { semanticRequestDigest: semanticDigest }
    })}\n`
  );
  mkdirSync(path.join(root, "objects"));
  for (let index = 0; index < 16; index += 1) {
    writeFileSync(path.join(root, "objects", `${index}.txt`), `${index}\n`);
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", `test: publication [${opId}]`);
  git(root, "checkout", "-q", "-");
  git(root, "merge", "-q", "--no-ff", "session", "-m", "materializer: merge session responsive");
  const mergeCommit = git(root, "rev-parse", "HEAD");

  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 0);
  const inspector = createGitCanonicalPublicationInspector(root);
  await inspector.inspectPublication(
    previousCommit,
    [opId],
    mergeCommit
  );
  const tracePath = path.join(root, "historical-publication-git-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  try {
    assert.deepEqual(await inspector.findHistoricalPublicationForOperation(opId), {
      commitSha: mergeCommit,
      semanticDigest
    });
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }

  const lookupCommands = gitTraceCommands(tracePath);
  assert.equal(lookupCommands.filter(([command]) => command === "rev-list").length, 0);
  assert.equal(lookupCommands.filter((args) =>
    args[0] === "show" && args.includes("-s")
  ).length, 0);
  assert.equal(lookupCommands.filter((args) =>
    args[0] === "diff" && args.includes("--quiet")
  ).length, 0);
  assert.equal(lookupCommands.filter((args) =>
    args[0] === "diff" && args.includes("--name-only")
  ).length, 1);

  assert.equal(timerFired, true);
});

test("missing-operation recovery search yields and reuses one bounded history scan", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-evidence-history-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  let parent = git(root, "rev-parse", "HEAD");
  for (let index = 0; index < 2_048; index += 1) {
    parent = git(root, "commit-tree", tree, "-p", parent, "-m", `history ${index}`);
  }
  git(root, "update-ref", "HEAD", parent);

  let timerFired = false;
  const tracePath = path.join(root, "git-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  setTimeout(() => {
    timerFired = true;
  }, 0);
  try {
    const inspector = createGitCanonicalPublicationInspector(root);
    await assert.rejects(
      inspector.findPublicationForOperation("namespace:missing-publication"),
      AuthorityCanonicalPublicationNotFoundError
    );
    await assert.rejects(
      inspector.findPublicationForOperation("namespace:still-missing"),
      AuthorityCanonicalPublicationNotFoundError
    );
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }

  assert.equal(timerFired, true);
  const starts = gitTraceCommands(tracePath);
  assert.ok(starts.length <= 3, `expected one history scan plus HEAD checks, observed ${starts.length} Git processes`);
});

function gitTraceCommands(tracePath: string): ReadonlyArray<ReadonlyArray<string>> {
  return readFileSync(tracePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      readonly event: string;
      readonly argv?: ReadonlyArray<string>;
    })
    .filter((event) => event.event === "start")
    .map((event) => {
      const argv = event.argv ?? [];
      const rootFlag = argv.indexOf("-C");
      return rootFlag >= 0 ? argv.slice(rootFlag + 2) : argv.slice(1);
    });
}

function git(root: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
