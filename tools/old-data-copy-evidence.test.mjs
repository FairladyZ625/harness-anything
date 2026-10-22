// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { seedSettingsEvent } from "../packages/daemon/test/repo-settings.fixture.ts";
import { forensicEnv, parseLastJsonObject, parsePeakRssBytes, resolveSourceRoot } from "./old-data-copy-evidence.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "tools/old-data-copy-evidence.mjs");

test("pure helpers: receipt parsing strips injections, rss parsing, source derivation", () => {
  assert.deepEqual(
    parseLastJsonObject('progress line\n{"a":1}\n{"b":2}'),
    { b: 2 },
    "the last top-level JSON object wins over preceding progress lines",
  );
  assert.equal(parseLastJsonObject("no json"), null);
  assert.equal(parsePeakRssBytes("\t123456789  maximum resident set size\n", "darwin"), 123456789);
  assert.equal(parsePeakRssBytes("Maximum resident set size (kbytes): 4096\n", "linux"), 4096 * 1024);
  assert.equal(parsePeakRssBytes("unrelated", "darwin"), null);
  const env = forensicEnv({
    HARNESS_DAEMON_ID: "default",
    HARNESS_EXECUTION_CREDENTIAL: "dispatched",
    HARNESS_ACTOR: "runtime",
    CODEX_HOME: "/codex",
    ANTHROPIC_API_KEY: "secret",
    PATH: "/bin",
  });
  assert.equal(env.PATH, "/bin");
  for (const stripped of [
    "HARNESS_DAEMON_ID",
    "HARNESS_EXECUTION_CREDENTIAL",
    "HARNESS_ACTOR",
    "CODEX_HOME",
    "ANTHROPIC_API_KEY",
  ])
    assert.equal(env[stripped], undefined, `${stripped} must not reach the forensic daemon`);
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=8192");
  assert.equal(env.HARNESS_DAEMON_OWNER_PID, String(process.pid));
  // Explicit wins verbatim; the default derivation walks git-common-dir of the given cwd.
  assert.equal(resolveSourceRoot("/some/explicit"), "/some/explicit");
});

function git(root, ...args) {
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** A miniature stand-in for the canonical workspace: an authored harness/ git repository of its
 *  own (that is the canonical shape) plus a real generation-3 ledger seeded through the
 *  production store, holding one settings event. */
function createSourceFixture(parent) {
  const root = path.join(parent, "source"),
    harness = path.join(root, "harness");
  mkdirSync(harness, { recursive: true });
  // Committed before the snapshot so the harness/ git local clone (committed state only) carries it.
  writeFileSync(
    path.join(harness, "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    "utf8",
  );
  git(harness, "init", "--quiet");
  git(harness, "config", "user.name", "Old Copy Fixture");
  git(harness, "config", "user.email", "oldcopy@example.test");
  git(harness, "add", "harness.yaml");
  git(harness, "commit", "--quiet", "-m", "fixture");
  seedSettingsEvent({ repoId: "canonical", rootDir: root });
  return root;
}

function runCommand(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: repoRoot, timeout: 300_000 });
}

function processAlive(pid) {
  const result = spawnSync("ps", ["-o", "pid=", "-p", String(pid)], { encoding: "utf8" });
  return (result.stdout ?? "").trim() === String(pid);
}

test("one command: snapshot, isolated daemon attach, reads, cold rebuild, receipt, cleanup", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-evidence-test-"));
  try {
    const source = createSourceFixture(parent);
    const out = path.join(parent, "out");
    const result = runCommand(["--source", source, "--out", out, "--attach-timeout-ms", "120000"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, true, JSON.stringify(receipt.failures));
    assert.deepEqual(receipt.failures, []);
    assert.equal(receipt.copy.generation, "3");
    assert.equal(receipt.copy.sourceRevision, 1, "one seeded event");
    assert.equal(receipt.attach.outcome, "terminal-record");
    assert.equal(receipt.attach.record.event, "repo_attach_completed");
    assert.match(String(receipt.attach.record.rootDir), /\/ws$/u, "attach record names the copied workspace");
    // The default source derivation walks git-common-dir from a repository cwd; the authored
    // harness/ directory is itself the git repository in the canonical shape.
    assert.equal(resolveSourceRoot(undefined, path.join(source, "harness")), path.join(source, "harness"));
    assert.equal(receipt.attach.daemonStatusRepo?.state, "attached");
    assert.ok(receipt.attach.daemonPeakRssBytes > 0, "daemon rss was sampled");
    assert.equal(receipt.build.entry, "dist");
    assert.equal(receipt.build.drifted, false);
    const headCommit = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
    if (headCommit.status === 0) assert.equal(receipt.build.commit, headCommit.stdout.trim());
    assert.equal(receipt.reads.storeHead.revision, 1);
    assert.ok(Array.isArray(receipt.reads.taskIndex.first) && receipt.reads.taskIndex.first.length === 0);
    assert.ok(Array.isArray(receipt.reads.events) && receipt.reads.events.length === 1);
    assert.equal(receipt.reads.events[0].schema, "settings-event/v1");
    assert.equal(receipt.coldRebuild.watermark, 1);
    assert.equal(receipt.coldRebuild.sourceRevision, 1);
    assert.match(receipt.coldRebuild.stateDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(receipt.coldRebuild.elapsedMs >= 0);
    if (existsSync("/usr/bin/time"))
      assert.ok(receipt.peakRss.rebuildBytes > 0, "/usr/bin/time reports the rebuild peak rss");
    else assert.equal(receipt.peakRss.rebuildBytes, null);
    assert.equal(receipt.cleanup.kept, false);
    assert.equal(existsSync(receipt.cleanup.tempRoot), false, "temp root removed");
    assert.ok(existsSync(path.join(out, "old-data-copy-evidence-receipt.json")), "receipt file in --out");
    assert.ok(existsSync(path.join(out, "daemon-lifecycle.jsonl")), "lifecycle log in --out");
    assert.equal(receipt.cleanup.daemonStopped, true);
    assert.equal(processAlive(receipt.build.pid), false, "no daemon left behind");
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("empty-ledger copy: raw failure in the receipt, non-zero exit, cleanup still runs", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-evidence-test-"));
  try {
    const source = createSourceFixture(parent);
    const generations = path.join(source, ".harness", "store", "generations");
    const generation = readdirSync(generations).find(
      (entry) =>
        statSync(path.join(generations, entry)).isDirectory() &&
        existsSync(path.join(generations, entry, "ledger.sqlite")),
    );
    assert.ok(generation, `a seeded generation exists under ${generations}`);
    truncateSync(path.join(generations, generation, "ledger.sqlite"));
    const result = runCommand(["--source", source, "--attach-timeout-ms", "120000"]);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, false);
    assert.ok(receipt.failures.length >= 1, "the raw failure is recorded");
    const flattened = JSON.stringify(receipt.failures) + JSON.stringify(receipt.attach ?? {});
    assert.match(
      flattened,
      /invalid_store|empty ledger|no such table|sqlite/iu,
      "the failure names the store, not a generic timeout",
    );
    assert.equal(receipt.cleanup.kept, false);
    assert.equal(existsSync(receipt.cleanup.tempRoot), false, "temp root removed even after failure");
    if (receipt.build?.pid) assert.equal(processAlive(receipt.build.pid), false, "no daemon left behind after failure");
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
