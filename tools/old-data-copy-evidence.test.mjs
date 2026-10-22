// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { seedSettingsEvent } from "../packages/daemon/test/repo-settings.fixture.ts";
import {
  copyTreeArgs,
  copyTreeMethod,
  forensicEnv,
  parseLastJsonObject,
  parsePeakRssBytes,
  resolveSourceRoot,
} from "./old-data-copy-evidence.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "tools/old-data-copy-evidence.mjs");

test("pure helpers: receipt parsing strips injections, rss parsing, source derivation, tree-copy flags", () => {
  assert.deepEqual(
    parseLastJsonObject('progress line\n{"a":1}\n{"b":2}'),
    { b: 2 },
    "the last top-level JSON object wins over preceding progress lines",
  );
  assert.equal(parseLastJsonObject("no json"), null);
  assert.equal(parsePeakRssBytes("\t123456789  maximum resident set size\n", "darwin"), 123456789);
  assert.equal(parsePeakRssBytes("Maximum resident set size (kbytes): 4096\n", "linux"), 4096 * 1024);
  assert.equal(parsePeakRssBytes("unrelated", "darwin"), null);
  assert.deepEqual(copyTreeArgs("darwin"), ["-cR"]);
  assert.deepEqual(copyTreeArgs("linux"), ["-a", "--reflink=auto"]);
  assert.deepEqual(copyTreeArgs("freebsd"), ["-a"]);
  assert.equal(copyTreeMethod("darwin"), "-cR");
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
  // An (empty) cache database so the cache-clone snapshot step is exercised end to end.
  mkdirSync(path.join(root, ".harness", "cache"), { recursive: true });
  writeFileSync(path.join(root, ".harness", "cache", "task.sqlite"), "", "utf8");
  return root;
}

function runCommand(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: repoRoot, timeout: 300_000 });
}

function processAlive(pid) {
  const result = spawnSync("ps", ["-o", "pid=", "-p", String(pid)], { encoding: "utf8" });
  return (result.stdout ?? "").trim() === String(pid);
}

function repoHead() {
  return spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
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
    const cacheStep = receipt.copy.steps.find((step) => step.item === "cache/task.sqlite");
    assert.ok(cacheStep, "the cache database is part of the snapshot steps");
    assert.match(cacheStep.method, /-cR|reflink/u, "cache databases take the block-clone path");
    assert.equal(cacheStep.discarded, undefined, "a checkpointed empty cache is not torn");
    assert.equal(receipt.attach.outcome, "terminal-record");
    assert.equal(receipt.attach.record.event, "repo_attach_completed");
    assert.match(String(receipt.attach.record.rootDir), /\/ws$/u, "attach record names the copied workspace");
    assert.ok(
      receipt.attach.history.some((record) => record.event === "repo_attach_started"),
      "attach history lists the intermediate records of this daemon",
    );
    assert.ok(
      receipt.attach.history.every((record) => String(record.event).startsWith("repo_attach")),
      "attach history holds only this run's attach records",
    );
    // The default source derivation walks git-common-dir from a repository cwd; the authored
    // harness/ directory is itself the git repository in the canonical shape.
    assert.equal(resolveSourceRoot(undefined, path.join(source, "harness")), path.join(source, "harness"));
    assert.equal(receipt.attach.daemonStatusRepo?.state, "attached");
    assert.ok(receipt.attach.daemonPeakRssBytes > 0, "daemon rss was sampled");
    assert.equal(receipt.build.entry, "dist");
    assert.equal(receipt.build.drifted, false);
    // The receipt may only name the build that ran: the daemon's own stamp and the loaded dist
    // marker are two independent sources and must agree.
    assert.equal(receipt.build.commit, receipt.build.loadedBuildId);
    const headCommit = repoHead();
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

test("stale dist marker: the command rebuilds so the loaded build is the checkout HEAD", () => {
  const headCommit = repoHead();
  assert.equal(headCommit.status, 0, "this arm needs a git checkout to name the required build");
  const marker = path.join(repoRoot, "packages", "daemon", "dist", "build-id.txt");
  assert.ok(existsSync(marker), "a previous arm provisioned the daemon dist");
  const original = readFileSync(marker, "utf8");
  // The normal state of a worktree after a rebase: dist from an older HEAD.
  writeFileSync(marker, `${"0".repeat(40)}\n`, "utf8");
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-evidence-test-"));
  try {
    const source = createSourceFixture(parent);
    const result = runCommand(["--source", source, "--attach-timeout-ms", "120000"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, true, JSON.stringify(receipt.failures));
    assert.ok(
      receipt.build.prepared.includes("npm run build --workspace @harness-anything/daemon"),
      "a marker that disagrees with HEAD forces a rebuild",
    );
    assert.equal(receipt.build.commit, receipt.build.loadedBuildId);
    assert.equal(receipt.build.loadedBuildId, headCommit.stdout.trim(), "the rebuilt dist is stamped with HEAD");
  } finally {
    writeFileSync(marker, original, "utf8");
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

/** Interruptible phase targeting: the fixture's .harness/wal carries many small files, so the
 *  snapshot's bulk-copy step is long enough that a signal sent once copy progress is visible
 *  always lands mid-copy (the exact phase a worker's Ctrl-C hits on a real multi-GB copy). */
function runUntilWalCopying(source, signal) {
  const baseline = new Set(readdirSync(tmpdir()));
  const child = spawn(process.execPath, [script, "--source", source, "--attach-timeout-ms", "120000"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const deadline = Date.now() + 120_000;
  let target = null;
  while (Date.now() < deadline) {
    for (const name of readdirSync(tmpdir())) {
      if (baseline.has(name) || !name.startsWith("ha-oldcopy-")) continue;
      const wal = path.join(tmpdir(), name, "ws", ".harness", "wal");
      if (!existsSync(wal)) continue;
      const copied = readdirSync(wal).length;
      if (copied >= 2) {
        target = path.join(tmpdir(), name);
        break;
      }
    }
    if (target) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.ok(target, "the command reached the wal copy phase");
  child.kill(signal);
  return { child, target, baseline, readOutput: () => ({ stdout, stderr }) };
}

test(
  "SIGTERM/SIGINT mid-copy: temp copy deleted, non-zero exit, no ok receipt",
  {
    skip:
      process.platform === "win32"
        ? "requires POSIX signal delivery semantics (kill -TERM/-INT reaches the registered handler); Windows termination bypasses handlers"
        : false,
  },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-evidence-test-"));
    try {
      const source = createSourceFixture(parent);
      mkdirSync(path.join(source, ".harness", "wal"), { recursive: true });
      const payload = "x".repeat(32 * 1024);
      for (let index = 0; index < 3000; index += 1)
        writeFileSync(path.join(source, ".harness", "wal", `journal-${index}.jsonl`), payload, "utf8");
      for (const [signal, expectedExit] of [
        ["SIGTERM", 143],
        ["SIGINT", 130],
      ]) {
        const { child, target, baseline, readOutput } = runUntilWalCopying(source, signal);
        const exit = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
        const { stdout, stderr } = readOutput();
        assert.equal(exit, expectedExit, `${signal} exits ${expectedExit}: ${stdout}${stderr}`);
        assert.ok(!stdout.includes('"ok": true'), "an interrupted run must not print an ok receipt");
        assert.match(stderr, new RegExp(`interrupted by ${signal}`), "the interrupt note says what was cleaned");
        assert.equal(existsSync(target), false, `${signal}: the temp copy is deleted`);
        const leftovers = readdirSync(tmpdir()).filter((name) => !baseline.has(name) && name.startsWith("ha-oldcopy-"));
        assert.deepEqual(leftovers, [], `${signal}: no ha-oldcopy-* residue in the system temp dir`);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

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
