// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAuthorityReplicationContentStore
} from "../src/authority/replication-content-store.ts";

test("replication snapshot reads a large Git tree with bounded subprocess work", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "replication-content-batch-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  mkdirSync(path.join(root, "files"));
  for (let index = 0; index < 256; index += 1) {
    writeFileSync(path.join(root, "files", `${index}.txt`), `${index}\n`);
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "tree");
  const commitSha = git(root, "rev-parse", "HEAD");
  const values = new Map<string, unknown>();
  const tracePath = path.join(root, "git-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  try {
    const snapshot = createAuthorityReplicationContentStore({
      gitRoot: root,
      workspaceId: "workspace-batch",
      epoch: "1",
      state: {
        get: <Value>(key: string) => values.get(key) as Value | undefined,
        put: (key, value) => { values.set(key, structuredClone(value)); },
        entries: <Value>() => [...values.entries()] as ReadonlyArray<readonly [string, Value]>
      }
    }).snapshot(commitSha, 1);
    assert.equal(snapshot.entries.length, 256);
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }

  const starts = readFileSync(tracePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly event: string })
    .filter((event) => event.event === "start");
  assert.ok(starts.length <= 2, `expected at most two Git subprocesses, observed ${starts.length}`);
});

test("replication snapshot retains empty blobs without rewriting them", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "replication-content-restart-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  mkdirSync(path.join(root, "files"));
  for (let index = 0; index < 64; index += 1) {
    writeFileSync(path.join(root, "files", `${index}.txt`), "");
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "initial tree");

  const values = new Map<string, unknown>();
  let putCalls = 0;
  const state = {
    get: <Value>(key: string) => values.get(key) as Value | undefined,
    put: (key: string, value: unknown) => {
      putCalls += 1;
      values.set(key, structuredClone(value));
    },
    entries: <Value>() => [...values.entries()] as ReadonlyArray<readonly [string, Value]>
  };
  createAuthorityReplicationContentStore({
    gitRoot: root,
    workspaceId: "workspace-restart",
    epoch: "1",
    state
  }).snapshot(git(root, "rev-parse", "HEAD"), 1);

  const snapshot = createAuthorityReplicationContentStore({
    gitRoot: root,
    workspaceId: "workspace-restart",
    epoch: "1",
    state
  }).snapshot(git(root, "rev-parse", "HEAD"), 1);

  assert.equal(snapshot.entries.length, 64);
  assert.equal(putCalls, 1, "the shared empty blob should be retained exactly once");
});

function git(root: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
