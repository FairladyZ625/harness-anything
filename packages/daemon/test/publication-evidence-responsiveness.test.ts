// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Text } from "@harness-anything/kernel";
import {
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
  mkdirSync(path.join(root, "attribution-events"));
  writeFileSync(
    path.join(root, "attribution-events", `${sha256Text(opId)}.jsonl`),
    "{}\n"
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
  await createGitCanonicalPublicationInspector(root).inspectPublication(
    previousCommit,
    [opId],
    mergeCommit
  );

  assert.equal(timerFired, true);
});

function git(root: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
