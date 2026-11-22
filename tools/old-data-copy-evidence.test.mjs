// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { waitForArrival, watchFileArrival } from "./fixtures/event-arrival.ts";
import { writeDaemonRegistryRepo } from "../packages/kernel/src/daemon/registry.ts";
import { seedSettingsEvent } from "../packages/daemon/test/repo-settings.fixture.ts";
import {
  copyFilesIntoDirectory,
  copyLayout,
  copyRepoId,
  copyTree,
  copyTreeArgs,
  copyTreeMethod,
  cleanupStaleTempRoots,
  cliInvocation,
  externalWorkspaceLinks,
  forensicEnv,
  harnessCloneArgs,
  mirrorWorkspaceNodeModules,
  npmInvocation,
  parseArgs,
  parseLastJsonObject,
  parsePeakRssBytes,
  parseProcessRssBytes,
  planDaemonDistSteps,
  processAlive,
  processRssBytes,
  processRssMethod,
  resolveSourceDataRoot,
  resolveSourceRoot,
  resolveBuild,
  snapshotRepository,
} from "./old-data-copy-evidence.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "tools/old-data-copy-evidence.mjs");

test("build SHA uses a plain archive without changing the repository's worktree registry", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-build-")),
    source = path.join(parent, "source");
  try {
    mkdirSync(path.join(source, "node_modules"), { recursive: true });
    git(source, "init", "--quiet");
    git(source, "config", "core.autocrlf", "false");
    git(source, "config", "user.name", "Old Copy Fixture");
    git(source, "config", "user.email", "oldcopy@example.test");
    writeFileSync(path.join(source, "README.md"), "pinned archive\n");
    git(source, "add", "README.md");
    git(source, "commit", "--quiet", "-m", "fixture");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
      registry = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: source, encoding: "utf8" }),
      build = await resolveBuild(head, parent, source);
    assert.equal(build.resolvedSha, head);
    assert.equal(build.sourceArchive, true);
    assert.equal(existsSync(path.join(build.root, ".git")), false);
    assert.equal(existsSync(path.join(build.root, "node_modules")), false);
    assert.equal(readFileSync(path.join(build.root, "README.md"), "utf8"), "pinned archive\n");
    assert.equal(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: source, encoding: "utf8" }), registry);
    await assert.rejects(resolveBuild("missing-cut", path.join(parent, "missing"), source), /does not name a commit/);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

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
  assert.equal(parseArgs([]).mediumSubmit, false);
  assert.equal(parseArgs(["--medium-submit"]).mediumSubmit, true);
  assert.deepEqual(copyTreeArgs("darwin"), ["-cR"]);
  assert.deepEqual(copyTreeArgs("linux"), ["-a", "--reflink=auto"]);
  assert.deepEqual(copyTreeArgs("win32"), []);
  assert.deepEqual(copyTreeArgs("freebsd"), ["-a"]);
  assert.equal(copyTreeMethod("darwin"), "-cR");
  assert.equal(copyTreeMethod("win32"), "node fs.cp recursive");
  assert.deepEqual(npmInvocation(["run", "build", "--workspace", "@harness-anything/daemon"], "linux", {}), {
    command: "npm",
    args: ["run", "build", "--workspace", "@harness-anything/daemon"],
    windowsVerbatimArguments: false,
  });
  const winNpmCmd = npmInvocation(
    ["run", "build", "--workspace", "@harness-anything/daemon"],
    "win32",
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    null,
  );
  assert.equal(winNpmCmd.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(winNpmCmd.windowsVerbatimArguments, true);
  assert.deepEqual(winNpmCmd.args.slice(0, 4), ["/e:ON", "/v:OFF", "/d", "/c"]);
  assert.match(winNpmCmd.args[4], /^""[^"]*npm\.cmd" run build --workspace @harness-anything\/daemon"$/u);
  const mockNpmParent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-npm-"));
  try {
    const mockCliJs = path.join(mockNpmParent, "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(path.dirname(mockCliJs), { recursive: true });
    writeFileSync(mockCliJs, "// mock npm-cli.js\n", "utf8");
    const winNpmScript = npmInvocation(["ci"], "win32", { Path: mockNpmParent }, "C:\\Program Files\\nodejs\\node.exe");
    assert.equal(winNpmScript.command, "C:\\Program Files\\nodejs\\node.exe");
    assert.equal(winNpmScript.windowsVerbatimArguments, false);
    assert.equal(winNpmScript.args[1], "ci");
    assert.match(winNpmScript.args[0], /npm-cli\.js$/u);
  } finally {
    rmSync(mockNpmParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
  assert.equal(parseProcessRssBytes("58875904\r\n", "win32"), 58875904);
  assert.equal(parseProcessRssBytes("  4096\n", "linux"), 4096 * 1024);
  assert.equal(parseProcessRssBytes("", "win32"), null);
  assert.equal(parseProcessRssBytes("0", "win32"), null);
  assert.equal(parseProcessRssBytes("ps: unknown option -- o", "win32"), null);
  assert.match(processRssMethod("win32"), /WorkingSet64/u);
  assert.match(processRssMethod("linux"), /ps -o rss=/u);
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(0), false);
  assert.equal(processAlive(-1), false);
  assert.equal(processAlive(999_999_999), false);
  const selfRss = processRssBytes(process.pid);
  assert.ok(typeof selfRss === "number" && selfRss > 0, `expected positive RSS for pid ${process.pid}, got ${selfRss}`);
  assert.deepEqual(harnessCloneArgs("/src/harness", "/tmp/ws/harness"), [
    "clone",
    "--quiet",
    "--no-checkout",
    "/src/harness",
    "/tmp/ws/harness",
  ]);
  const env = forensicEnv({
    HARNESS_DAEMON_ID: "default",
    HARNESS_EXECUTION_CREDENTIAL: "dispatched",
    HARNESS_ACTOR: "runtime",
    HARNESS_WRITER_READY_WATCHDOG_MS: "600000",
    CODEX_HOME: "/codex",
    ANTHROPIC_API_KEY: "secret",
    PATH: "/bin",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(
    forensicEnv({ Path: "D:\\repo\\tools\\git-hooks;C:\\Program Files\\Git\\cmd" }, "win32").Path,
    "C:\\Program Files\\Git\\cmd",
  );
  assert.equal(forensicEnv({ PATH: "/repo/tools/git-hooks:/usr/bin" }, "linux").PATH, "/usr/bin");
  for (const stripped of [
    "HARNESS_DAEMON_ID",
    "HARNESS_EXECUTION_CREDENTIAL",
    "HARNESS_ACTOR",
    "HARNESS_WRITER_READY_WATCHDOG_MS",
    "CODEX_HOME",
    "ANTHROPIC_API_KEY",
  ])
    assert.equal(env[stripped], undefined, `${stripped} must not reach the forensic daemon`);
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=8192");
  assert.equal(env.HARNESS_DAEMON_OWNER_PID, String(process.pid));
  const invocation = cliInvocation("/build", ["task", "show", "task_example"], env, "/workspace", {
    userRoot: "/isolated/user-root",
    daemonId: "isolated-daemon",
  });
  assert.ok(!invocation.args.includes("--user-root"), "task commands do not accept daemon-control flags");
  assert.ok(!invocation.args.includes("--daemon-id"), "task commands do not accept daemon-control flags");
  assert.deepEqual(invocation.options.env, {
    ...env,
    HARNESS_DAEMON_USER_ROOT: "/isolated/user-root",
    HARNESS_DAEMON_ID: "isolated-daemon",
  });
  // Explicit wins verbatim; the default derivation walks git-common-dir of the given cwd.
  assert.equal(resolveSourceRoot("/some/explicit"), path.resolve("/some/explicit"));
});

test("temp cleanup removes only expired, dead-owner ha-oldcopy roots", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-cleanup-test-"));
  try {
    const deadPid = Array.from({ length: 100 }, (_, index) => 2_000_000_000 - index).find((pid) => !processAlive(pid));
    assert.ok(deadPid, "the test found an unused pid for the orphan marker");
    const expired = path.join(parent, `ha-oldcopy-${deadPid}-expired`);
    const active = path.join(parent, `ha-oldcopy-${process.pid}-active`);
    const unrelated = path.join(parent, `harness-test-isolation-${deadPid}-expired`);
    const legacy = path.join(parent, "ha-oldcopy-legacy-without-owner");
    for (const target of [expired, active, unrelated, legacy]) mkdirSync(target);

    assert.deepEqual(cleanupStaleTempRoots({ now: Date.now(), tempDir: parent, maxAgeMs: 60_000 }), []);
    assert.deepEqual(cleanupStaleTempRoots({ now: Date.now() + 120_000, tempDir: parent, maxAgeMs: 60_000 }), [
      expired,
    ]);
    assert.equal(existsSync(expired), false);
    assert.equal(existsSync(active), true, "a live owner protects an old directory");
    assert.equal(existsSync(unrelated), true, "the other temp-directory prefix is out of scope");
    assert.equal(existsSync(legacy), true, "a legacy directory without an owner pid is left untouched");
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("timeout abort removes its owned temp root before exiting non-zero", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-timeout-test-"));
  try {
    const tempRoot = path.join(parent, "ha-oldcopy-timeout-root");
    mkdirSync(tempRoot);
    const moduleUrl = new URL("./old-data-copy-evidence.mjs", import.meta.url).href;
    const scriptText = `
      const { installInterruptHandlers } = await import(${JSON.stringify(moduleUrl)});
      const tempRoot = process.env.tempRoot;
      const session = { tempRoot };
      installInterruptHandlers(session);
      session.abort("SIGTERM", "timed out after test");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", scriptText], {
      encoding: "utf8",
      cwd: repoRoot,
      timeout: 10_000,
      env: { ...process.env, tempRoot },
    });
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /timed out after test/u);
    assert.equal(existsSync(tempRoot), false, "timeout cleanup removed the temp root");
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function git(root, ...args) {
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** A miniature stand-in for the canonical workspace: an authored harness/ git repository of its
 *  own (that is the canonical shape) plus a real generation-3 ledger seeded through the
 *  production store, holding one settings event. */
async function createSourceFixture(parent, localRoot = ".harness") {
  const root = path.join(parent, "source"),
    harness = path.join(root, "harness");
  mkdirSync(harness, { recursive: true });
  // Committed before the snapshot so the harness/ git local clone (committed state only) carries it.
  writeFileSync(
    path.join(harness, "harness.yaml"),
    `schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: ${localRoot}\n`,
    "utf8",
  );
  git(harness, "init", "--quiet");
  git(harness, "config", "core.autocrlf", "false");
  git(harness, "config", "user.name", "Old Copy Fixture");
  git(harness, "config", "user.email", "oldcopy@example.test");
  git(harness, "add", "harness.yaml");
  git(harness, "commit", "--quiet", "-m", "fixture");
  const store = seedSettingsEvent({ repoId: "canonical", rootDir: root, keepOpen: true });
  assert.ok(store);
  // The fixture describes an already settled old cut. Drain the seeder's WAL/outbox
  // before its independent copy starts VACUUM INTO (dec_04A9211B073F29F0FC1E1CA573 CH2).
  await store.drain();
  // An (empty) cache database so the cache-clone snapshot step is exercised end to end.
  mkdirSync(path.join(root, ...localRoot.split("/"), "cache"), { recursive: true });
  writeFileSync(path.join(root, ...localRoot.split("/"), "cache", "task.sqlite"), "", "utf8");
  return root;
}

test("copy layout: the source harness.yaml decides the local root, not a default literal", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-layout-"));
  try {
    const defaultRoot = await createSourceFixture(path.join(parent, "default"));
    assert.equal(copyLayout(defaultRoot).localRootRelative, ".harness");
    const renamedParent = path.join(parent, "renamed");
    mkdirSync(renamedParent, { recursive: true });
    const renamedRoot = await createSourceFixture(renamedParent, ".harness.nosync");
    const renamed = copyLayout(renamedRoot);
    assert.equal(renamed.localRootRelative, ".harness.nosync");
    assert.equal(renamed.localRoot, path.join(renamedRoot, ".harness.nosync"));
    assert.equal(renamed.configRelative, "harness/harness.yaml");
    assert.equal(copyLayout(path.join(renamedRoot, "harness")).localRootRelative, ".harness.nosync");
    assert.throws(() => copyLayout(path.join(parent, "elsewhere")), /no harness\.yaml found/u);
    assert.equal(copyRepoId(defaultRoot).repoId, "canonical");
    assert.ok(copyRepoId(defaultRoot).certificate.split(path.sep).join("/").includes(".harness/store/generations/3/"));
    assert.match(copyRepoId(defaultRoot).certificate, /ledger\.sqlite\.activation\.json$/u);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("snapshot: the harness clone carries objects and config, not the authored tree", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-snapshot-"));
  try {
    const source = await createSourceFixture(parent),
      harness = path.join(source, "harness");
    // A committed authored file of the kind the old checkout materialized. Attach and the cold
    // rebuild read projected documents and the live config, never a task package file.
    mkdirSync(path.join(harness, "tasks", "task_fixture"), { recursive: true });
    writeFileSync(path.join(harness, "tasks", "task_fixture", "task_plan.md"), "# fixture task package\n", "utf8");
    git(harness, "add", "tasks");
    git(harness, "commit", "--quiet", "-m", "fixture task package");
    const workspace = path.join(parent, "ws"),
      snapshot = await snapshotRepository(source, workspace),
      copiedHarness = path.join(workspace, "harness");
    assert.deepEqual(
      snapshot.steps.find((step) => step.item === "harness"),
      {
        item: "harness",
        method: "git local clone --no-checkout (no working tree)",
      },
    );
    assert.ok(existsSync(path.join(copiedHarness, ".git")), "the clone keeps the git metadata attach probes");
    assert.ok(existsSync(path.join(copiedHarness, "harness.yaml")), "the live config is still materialized");
    assert.equal(
      existsSync(path.join(copiedHarness, "tasks", "task_fixture", "task_plan.md")),
      false,
      "tracked task packages are not checked out",
    );
    assert.equal(copyLayout(workspace).localRootRelative, ".harness", "the copied config still resolves the layout");
    const witness = snapshot.steps.find((step) => step.item === "cache/task.sqlite")?.witness;
    assert.ok(witness?.ino > 0, "the cache clone has an identity before attach");
    assert.equal(witness?.schemaVersion, null, "an empty cache is distinct from an old warm projection");
    assert.equal(witness?.missingArchivedDescriptors, 0);
    assert.equal(
      realpathSync(
        execFileSync("git", ["-C", copiedHarness, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
      ),
      realpathSync(copiedHarness),
      "attach's ledger-git probe still resolves the copy",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function runCommand(args, env = process.env) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: repoRoot, env, timeout: 300_000 });
}

function repoHead() {
  return spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
}

test("one command: snapshot, isolated daemon attach, reads, cold rebuild, receipt, cleanup", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-evidence-test-"));
  try {
    const source = await createSourceFixture(parent);
    const out = path.join(parent, "out");
    const result = runCommand(["--source", source, "--out", out, "--cold-attach", "--attach-timeout-ms", "120000"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, true, JSON.stringify(receipt.failures));
    assert.deepEqual(receipt.failures, []);
    assert.equal(receipt.copy.generation, "3");
    assert.equal(
      receipt.copy.steps.find((step) => step.item === "harness")?.method,
      "git local clone --no-checkout (no working tree)",
      "the snapshot transfers harness objects without checking out the authored tree",
    );
    assert.equal(receipt.copy.sourceRevision, 1, "one seeded event");
    const cacheStep = receipt.copy.steps.find((step) => step.item === "cache/task.sqlite");
    assert.ok(cacheStep, "the cache database is part of the snapshot steps");
    assert.equal(receipt.copy.coldAttach, true);
    assert.equal(receipt.census.ledger.eventRows, 1);
    assert.deepEqual(receipt.census.ledger.eventSchemas, [{ schema: "settings-event/v1", count: 1 }]);
    assert.equal(receipt.census.ledger.documentHeads, 1);
    assert.equal(receipt.census.ledger.entityDeclarationHeads, 0);
    assert.deepEqual(receipt.census.ledger.settingsAndVerticalDocumentHeads, [{ surface: "settings", count: 1 }]);
    assert.ok(receipt.census.projections.tableCount > 0);
    assert.equal(receipt.census.projections.tables.find((table) => table.table === "task")?.rows ?? 0, 0);
    assert.equal(receipt.census.projections.presetSnapshotRows, 0);
    assert.equal(
      receipt.copy.steps.find((step) => step.item === "cache/task.sqlite" && step.discarded)?.discarded,
      true,
      "cold attach discards only the copied task projection before writer startup",
    );
    const ledgerStep = receipt.copy.steps.find((step) => step.item === "store/generations/3/ledger.sqlite"),
      objectsStep = receipt.copy.steps.find(
        (step) => step.item === "store/generations/3 objects and retired generations",
      );
    assert.ok(ledgerStep && objectsStep, "the active ledger and its immutable objects are captured");
    assert.ok(
      receipt.copy.steps.indexOf(cacheStep) < receipt.copy.steps.indexOf(ledgerStep),
      "projection caches are captured before the ledger cut",
    );
    assert.ok(
      receipt.copy.steps.indexOf(ledgerStep) < receipt.copy.steps.indexOf(objectsStep),
      "the ledger cut is captured before object cloning so concurrent appends cannot lose their blobs",
    );
    if (process.platform === "win32") assert.match(cacheStep.method, /^node fs\.cp recursive \+ checkpoint$/u);
    else assert.match(cacheStep.method, /-cR|reflink/u, "cache databases take the block-clone path");
    assert.equal(cacheStep.discarded, undefined, "a checkpointed empty cache is not torn");
    assert.equal(receipt.attach.outcome, "terminal-record");
    assert.equal(receipt.attach.record.event, "repo_attach_completed");
    assert.match(String(receipt.attach.record.rootDir), /(?:^|[\\/])ws$/u, "attach record names the copied workspace");
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
    assert.equal(receipt.build.headCommit, receipt.build.loadedBuildId);
    const headCommit = repoHead();
    if (headCommit.status === 0) assert.equal(receipt.build.headCommit, headCommit.stdout.trim());
    assert.equal(receipt.reads.storeHead.revision, 1);
    assert.equal(receipt.reads.taskIndex.count, 0);
    assert.equal(receipt.reads.taskIndex.hasAnyTask, false);
    assert.equal(
      Object.hasOwn(receipt.reads.taskIndex, "first"),
      false,
      "receipts contain counts, not authored content",
    );
    assert.ok(Array.isArray(receipt.reads.events) && receipt.reads.events.length === 1);
    assert.equal(receipt.reads.events[0].schema, "settings-event/v1");
    assert.equal(receipt.coldRebuild.watermark, 1);
    assert.equal(receipt.coldRebuild.sourceRevision, 1);
    assert.deepEqual(receipt.archivedFactHistory, {
      warmCount: 0,
      coldCount: 0,
      equal: true,
      allContentReadable: true,
    });
    assert.equal(receipt.warmProjection.preserved, false, "cold attach cannot be reported as warm evidence");
    assert.equal(receipt.warmProjection.before.schemaVersion, null);
    assert.ok(receipt.warmProjection.after.ino > 0);
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

test("one command: medium submission records missing local auth and still cold-rebuilds the copy", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-medium-submit-test-"));
  try {
    const source = await createSourceFixture(parent);
    const result = runCommand(["--source", source, "--medium-submit", "--attach-timeout-ms", "120000"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout),
      medium = receipt.mediumSubmission;
    assert.equal(receipt.ok, false);
    assert.equal(medium, null);
    assert.match(JSON.stringify(receipt.failures), /authentication_required/u);
    assert.equal(receipt.coldRebuild.sourceRevision, 1, "the denied create does not append copied-ledger events");
    assert.equal(receipt.coldRebuild.watermark, receipt.coldRebuild.sourceRevision);
    assert.equal(receipt.cleanup.kept, false);
    assert.equal(existsSync(receipt.cleanup.tempRoot), false, "temporary submitted copy removed");
    assert.equal(receipt.cleanup.daemonStopped, true);
    assert.equal(processAlive(receipt.build.pid), false, "no daemon left behind");
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("dist plan: a marker that disagrees with HEAD forces a rebuild; a current one is trusted", () => {
  const head = "a".repeat(40);
  const npmCi = { command: "npm", args: ["ci"] };
  const daemonBuild = { command: "npm", args: ["run", "build", "--workspace", "@harness-anything/daemon"] };
  // The normal state of a worktree after a rebase — dist stamped by an older HEAD — is rebuilt,
  // never trusted. This is pinned as the pure decision only: provisioning a deliberately stale
  // marker in a real checkout makes daemons concurrently running from that dist exit for build
  // supersession, the invariant smoke-identity.integration.test.mjs asserts.
  assert.deepEqual(planDaemonDistSteps({ nodeModules: true, distEntry: true, head, marker: "0".repeat(40) }), [
    daemonBuild,
  ]);
  // A dist already stamped with the checkout HEAD is trusted: no provisioning step runs.
  assert.deepEqual(planDaemonDistSteps({ nodeModules: true, distEntry: true, head, marker: head }), []);
  // A fresh build worktree: dependencies first, and a missing dist entry builds regardless of
  // any marker value.
  assert.deepEqual(planDaemonDistSteps({ nodeModules: false, distEntry: false, head, marker: head }), [
    npmCi,
    daemonBuild,
  ]);
  // A tree with no git HEAD names no required build, so only a missing dist entry builds.
  assert.deepEqual(planDaemonDistSteps({ nodeModules: true, distEntry: true, head: null, marker: "stale" }), []);
  assert.deepEqual(planDaemonDistSteps({ nodeModules: true, distEntry: false, head: null, marker: null }), [
    daemonBuild,
  ]);
  // A missing or empty marker file is as stale as a mismatched one.
  assert.deepEqual(planDaemonDistSteps({ nodeModules: true, distEntry: true, head, marker: null }), [daemonBuild]);
});

test(
  "SIGTERM/SIGINT mid-copy: temp copy deleted, non-zero exit, no ok receipt",
  {
    skip:
      process.platform === "win32"
        ? "requires POSIX signal delivery semantics (kill -TERM/-INT reaches the registered handler); Windows termination bypasses handlers"
        : false,
    timeout: 180_000,
  },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-evidence-test-"));
    try {
      const source = await createSourceFixture(parent);
      const wal = path.join(source, ".harness", "wal");
      const bin = path.join(parent, "bin");
      const ready = path.join(parent, "copy-started");
      const release = path.join(parent, "copy-release");
      mkdirSync(wal, { recursive: true });
      mkdirSync(bin);
      writeFileSync(path.join(wal, "journal.jsonl"), "copied before interruption\n");
      execFileSync("mkfifo", [release]);
      // Copy one WAL file, publish the destination atomically, and hold the copy child open
      // until the command under test kills its process group.
      writeFileSync(
        path.join(bin, "cp"),
        `#!/bin/sh
set -eu
from=""
to=""
for arg do
  from="$to"
  to="$arg"
done
if [ "$from" != "$OLD_COPY_TEST_WAL" ]; then
  exec "$OLD_COPY_TEST_CP" "$@"
fi
mkdir -p "$to"
"$OLD_COPY_TEST_CP" "$from/journal.jsonl" "$to/"
printf '%s\n' "$to" > "$OLD_COPY_TEST_READY.tmp"
mv "$OLD_COPY_TEST_READY.tmp" "$OLD_COPY_TEST_READY"
read -r released < "$OLD_COPY_TEST_RELEASE"
`,
        { mode: 0o755 },
      );
      const env = {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        TMPDIR: parent,
        OLD_COPY_TEST_CP: execFileSync("which", ["cp"], { encoding: "utf8" }).trim(),
        OLD_COPY_TEST_WAL: wal,
        OLD_COPY_TEST_READY: ready,
        OLD_COPY_TEST_RELEASE: release,
      };
      for (const [signal, expectedExit] of [
        ["SIGTERM", 143],
        ["SIGINT", 130],
      ]) {
        const child = spawn(process.execPath, [script, "--source", source, "--attach-timeout-ms", "120000"], {
          cwd: repoRoot,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const exited = once(child, "close");
        const abort = () => child.kill("SIGTERM");
        t.signal.addEventListener("abort", abort, { once: true });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        try {
          const destination = await waitForArrival(
            () => {
              if (child.exitCode !== null || child.signalCode !== null)
                assert.fail(`the command exited before the WAL copy started: ${stdout}${stderr}`);
              return existsSync(ready) ? readFileSync(ready, "utf8").trim() : null;
            },
            (arrive) => {
              const unwatch = watchFileArrival(ready)(arrive);
              child.once("exit", arrive);
              return () => {
                child.off("exit", arrive);
                unwatch();
              };
            },
          );
          const target = path.resolve(destination, "../../..");
          assert.ok(existsSync(path.join(destination, "journal.jsonl")), "the command reached the WAL copy phase");
          assert.equal(child.kill(signal), true, `${signal} delivered while the copy child is held open`);
          const [exit] = await exited;
          assert.equal(exit, expectedExit, `${signal} exits ${expectedExit}: ${stdout}${stderr}`);
          assert.ok(!stdout.includes('"ok": true'), "an interrupted run must not print an ok receipt");
          assert.match(stderr, new RegExp(`interrupted by ${signal}`), "the interrupt note says what was cleaned");
          assert.equal(existsSync(target), false, `${signal}: the temp copy is deleted`);
          assert.deepEqual(
            readdirSync(parent).filter((name) => name.startsWith("ha-oldcopy-")),
            [],
            `${signal}: no ha-oldcopy-* residue in the fixture temp dir`,
          );
        } finally {
          child.kill("SIGTERM");
          await exited;
          t.signal.removeEventListener("abort", abort);
          rmSync(ready, { force: true });
        }
      }
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

test("empty-ledger copy: raw failure in the receipt, non-zero exit, cleanup still runs", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-evidence-test-"));
  try {
    const source = await createSourceFixture(parent);
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

test("native copyTree and copyFilesIntoDirectory work without external cp (win32 path)", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-native-cp-"));
  try {
    const srcDir = path.join(parent, "src");
    const nestedDir = path.join(srcDir, "nested");
    const bucketA = path.join(srcDir, "3", "objects", "sha256", "00");
    const bucketB = path.join(srcDir, "3", "objects", "sha256", "ff");
    const emptyBucket = path.join(srcDir, "3", "objects", "sha256", "aa");
    const dstDir = path.join(parent, "dst");
    const filesOut = path.join(parent, "files-out");
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(bucketA, { recursive: true });
    mkdirSync(bucketB, { recursive: true });
    mkdirSync(emptyBucket, { recursive: true });
    mkdirSync(filesOut, { recursive: true });
    writeFileSync(path.join(nestedDir, "state.txt"), "copied-tree\n", "utf8");
    writeFileSync(path.join(bucketA, "blob-a"), "blob-a-bytes", "utf8");
    writeFileSync(path.join(bucketB, "blob-b"), "blob-b-bytes", "utf8");
    writeFileSync(path.join(srcDir, "cache.sqlite"), "sqlite-bytes", "utf8");
    writeFileSync(path.join(srcDir, "cache.sqlite-wal"), "wal-bytes", "utf8");

    const treeMethod = await copyTree(srcDir, dstDir, { platform: "win32" });
    assert.equal(treeMethod, "node fs.cp recursive");
    assert.equal(readFileSync(path.join(dstDir, "nested", "state.txt"), "utf8"), "copied-tree\n");
    assert.equal(readFileSync(path.join(dstDir, "3", "objects", "sha256", "00", "blob-a"), "utf8"), "blob-a-bytes");
    assert.equal(readFileSync(path.join(dstDir, "3", "objects", "sha256", "ff", "blob-b"), "utf8"), "blob-b-bytes");
    assert.equal(existsSync(path.join(dstDir, "3", "objects", "sha256", "aa")), true);

    const filesMethod = await copyFilesIntoDirectory(
      [path.join(srcDir, "cache.sqlite"), path.join(srcDir, "cache.sqlite-wal")],
      filesOut,
      { platform: "win32" },
    );
    assert.equal(filesMethod, "node fs.cp recursive");
    assert.equal(readFileSync(path.join(filesOut, "cache.sqlite"), "utf8"), "sqlite-bytes");
    assert.equal(readFileSync(path.join(filesOut, "cache.sqlite-wal"), "utf8"), "wal-bytes");
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("snapshot and one-command work when harness/ is a plain edge directory without nested .git", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-plain-harness-"));
  try {
    const source = await createSourceFixture(parent);
    const harness = path.join(source, "harness");
    rmSync(path.join(harness, ".git"), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    mkdirSync(path.join(harness, "tasks", "task_edge"), { recursive: true });
    writeFileSync(path.join(harness, "tasks", "task_edge", "task_plan.md"), "# edge task\n", "utf8");
    mkdirSync(path.join(harness, "restore-drills"), { recursive: true });
    writeFileSync(path.join(harness, "restore-drills", "skip.bin"), "ignored\n", "utf8");

    const workspace = path.join(parent, "ws-snapshot");
    const snapshot = await snapshotRepository(source, workspace, { platform: "win32" });
    const copiedHarness = path.join(workspace, "harness");
    assert.deepEqual(
      snapshot.steps.find((step) => step.item === "harness"),
      { item: "harness", method: "node fs.cp recursive + git init (no nested .git)" },
    );
    assert.ok(existsSync(path.join(copiedHarness, ".git")), "minimal git repo initialized for attach");
    assert.ok(existsSync(path.join(copiedHarness, "harness.yaml")), "live harness.yaml preserved");
    assert.ok(existsSync(path.join(copiedHarness, "tasks", "task_edge", "task_plan.md")), "authored files copied");
    assert.equal(existsSync(path.join(copiedHarness, "restore-drills")), false, "restore-drills excluded");
    assert.equal(
      execFileSync("git", ["-C", copiedHarness, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
      "main",
    );

    const out = path.join(parent, "out");
    const result = runCommand(["--source", source, "--out", out, "--attach-timeout-ms", "120000"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, true, JSON.stringify(receipt.failures));
    assert.deepEqual(receipt.failures, []);
    assert.equal(receipt.attach.record.event, "repo_attach_completed");
    assert.equal(receipt.coldRebuild.watermark, 1);
    assert.equal(receipt.coldRebuild.sourceRevision, 1);
    assert.equal(processAlive(receipt.build.pid), false, "no daemon left behind");
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("remote-edge workspace resolves fleet-basebackup/v3 replica store without leaking fleet-edge.json", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-remote-edge-"));
  try {
    const seeded = await createSourceFixture(path.join(parent, "seeded"));
    const edgeRoot = path.join(parent, "edge");
    const edgeUser = path.join(parent, "edge-user");
    const edgeHarness = path.join(edgeRoot, "harness");
    const edgeLocal = path.join(edgeRoot, ".harness");
    const viewRoot = path.join(parent, "edge-view");
    const nodeId = "node-test-edge-1";
    const genId = "gen-56e6b6ed-edge";
    const viewDir = path.join(viewRoot, "repos", "canonical", "views", nodeId);
    const replicaHarness = path.join(viewDir, "generations", genId, ".harness");

    mkdirSync(edgeHarness, { recursive: true });
    mkdirSync(edgeLocal, { recursive: true });
    writeFileSync(
      path.join(edgeHarness, "harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
      "utf8",
    );
    writeFileSync(
      path.join(edgeLocal, "settings.local.json"),
      '{"nodeTaskMaterializationPolicy":"in_flight"}\n',
      "utf8",
    );
    writeDaemonRegistryRepo({
      userRoot: edgeUser,
      canonicalRoot: edgeRoot,
      repoId: "canonical",
      mode: "remote-edge",
      authoredBranch: "main",
      createConvenienceLinks: false,
    });
    const edgeConfigDir = path.join(edgeUser, "fleet", "edge", "canonical");
    mkdirSync(edgeConfigDir, { recursive: true });
    writeFileSync(
      path.join(edgeConfigDir, "fleet-edge.json"),
      JSON.stringify({
        schema: "fleet-edge-config/v1",
        repoId: "canonical",
        host: "127.0.0.1",
        port: 9443,
        caPath: "ca.pem",
        nodeId,
        credential: "test-credential-must-not-be-copied",
        viewRoot: "../edge-view",
        quotaBytes: 1024 * 1024 * 1024,
      }),
      "utf8",
    );

    // Negative control: before replica pointer exists, resolving the remote-edge store fails closed.
    assert.throws(() => resolveSourceDataRoot(edgeRoot, edgeLocal, edgeUser), /no published replica generation/u);

    await copyTree(path.join(seeded, ".harness"), replicaHarness, { platform: "win32" });
    writeFileSync(
      path.join(viewDir, "current.json"),
      JSON.stringify({
        id: genId,
        metadata: {
          schema: "fleet-basebackup/v3",
          repoId: "canonical",
          readerProfile: null,
          position: { history: "hist-1", sequence: 1, revision: 1 },
          ledgerGeneration: 3,
          projectionSchema: 38,
        },
      }),
      "utf8",
    );

    assert.equal(copyRepoId(edgeRoot, edgeUser).repoId, "canonical");
    const ws = path.join(parent, "ws-edge");
    const snap = await snapshotRepository(edgeRoot, ws, { platform: "win32", userRoot: edgeUser });
    assert.equal(
      existsSync(path.join(ws, "fleet-edge.json")),
      false,
      "fleet-edge.json must not enter the isolated copy",
    );
    assert.ok(!JSON.stringify(snap).includes("test-credential-must-not-be-copied"), "credential never enters steps");
    assert.deepEqual(
      snap.steps.find((step) => step.item === "fleet-edge-replica"),
      {
        item: "fleet-edge-replica",
        method: "active fleet-basebackup/v3 replica generation",
        generationId: genId,
        replicaRevision: 1,
      },
    );
    assert.ok(existsSync(path.join(ws, ".harness", "settings.local.json")), "edge settings.local.json copied");

    const out = path.join(parent, "out");
    const result = runCommand(["--source", edgeRoot, "--out", out, "--attach-timeout-ms", "120000"], {
      ...process.env,
      HARNESS_DAEMON_USER_ROOT: edgeUser,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, true, JSON.stringify(receipt.failures));
    assert.deepEqual(receipt.failures, []);
    assert.equal(receipt.copy.sourceRevision, 1);
    assert.equal(receipt.coldRebuild.watermark, 1);
    assert.equal(processAlive(receipt.build.pid), false, "no daemon left behind");
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("workspace link isolation detects external Windows worktree junctions and mirrors local workspace links", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-ws-links-"));
  try {
    const canonical = path.join(parent, "canonical");
    const worktree = path.join(parent, "worktree");
    const isolated = path.join(parent, "isolated");
    const linkType = process.platform === "win32" ? "junction" : "dir";

    mkdirSync(path.join(canonical, "packages", "kernel"), { recursive: true });
    writeFileSync(
      path.join(canonical, "packages", "kernel", "package.json"),
      '{"name":"@harness-anything/kernel"}\n',
      "utf8",
    );
    mkdirSync(path.join(canonical, "node_modules", "ext-dep"), { recursive: true });
    writeFileSync(path.join(canonical, "node_modules", "ext-dep", "index.js"), "export const v = 1;\n", "utf8");
    mkdirSync(path.join(canonical, "node_modules", "@harness-anything"), { recursive: true });
    symlinkSync(
      path.join(canonical, "packages", "kernel"),
      path.join(canonical, "node_modules", "@harness-anything", "kernel"),
      linkType,
    );

    mkdirSync(path.join(worktree, "packages", "kernel"), { recursive: true });
    writeFileSync(
      path.join(worktree, "packages", "kernel", "package.json"),
      '{"name":"@harness-anything/kernel"}\n',
      "utf8",
    );
    mkdirSync(path.join(worktree, "node_modules", "@harness-anything"), { recursive: true });
    symlinkSync(
      path.join(canonical, "node_modules", "ext-dep"),
      path.join(worktree, "node_modules", "ext-dep"),
      linkType,
    );
    // Simulate Windows worktree mirror bug: @harness-anything/kernel points at canonical, not worktree.
    symlinkSync(
      path.join(canonical, "packages", "kernel"),
      path.join(worktree, "node_modules", "@harness-anything", "kernel"),
      linkType,
    );

    assert.equal(externalWorkspaceLinks(canonical), false);
    assert.equal(externalWorkspaceLinks(worktree), true);

    mkdirSync(path.join(isolated, "packages", "kernel"), { recursive: true });
    writeFileSync(
      path.join(isolated, "packages", "kernel", "package.json"),
      '{"name":"@harness-anything/kernel"}\n',
      "utf8",
    );
    mirrorWorkspaceNodeModules(worktree, isolated);

    assert.equal(externalWorkspaceLinks(isolated), false);
    assert.equal(
      realpathSync(path.join(isolated, "node_modules", "@harness-anything", "kernel")),
      realpathSync(path.join(isolated, "packages", "kernel")),
    );
    assert.equal(
      realpathSync(path.join(isolated, "node_modules", "ext-dep")),
      realpathSync(path.join(canonical, "node_modules", "ext-dep")),
    );
    // Donor worktree and canonical links remain completely untouched.
    assert.equal(
      realpathSync(path.join(worktree, "node_modules", "@harness-anything", "kernel")),
      realpathSync(path.join(canonical, "packages", "kernel")),
    );
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
