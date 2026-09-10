import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, loadavg, availableParallelism } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cli, git } from "../../packages/cli/test/daemon-multi-repo-lifecycle-cli.fixtures.ts";
import { lastTimingRecord, percentile } from "../measure-cli-command-timing.mjs";

// Freeze this workload before measuring either arm. This is a small calibration, not a scale gate.
export const workload = Object.freeze({ seeds: [1103, 2207, 3301], tasks: 3, entities: 3, binaryBytes: 4096 });
export const frame = (type, value) => console.log(`ENTITY_CLI_CALIBRATION\t${JSON.stringify({ type, ...value })}`);

export function fixture(seed) {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-entity-cli-calibration-"));
  const root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  mkdirSync(root);
  writeFileSync(path.join(root, "README.md"), "# Calibration fixture\n");
  git(root, "init", "--quiet");
  git(root, "add", "README.md");
  git(root, "commit", "--quiet", "-m", "fixture");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("HARNESS_") || key.startsWith("HA_CLI_TIMING")) delete env[key];
  }
  Object.assign(env, {
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: "entity-cli-calibration",
    HARNESS_GIT_AUTHOR_NAME: "Calibration Fixture",
    HARNESS_GIT_AUTHOR_EMAIL: "calibration@example.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HA_CLI_TIMING: "1",
  });
  const rows = [],
    checks = [];
  const invoke = (metric, args, { actor, input, requireSuccess = true } = {}) => {
    const startedAt = new Date().toISOString(),
      started = performance.now();
    const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
      env: { ...env, ...(actor ? { HARNESS_ACTOR: actor } : {}) },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      ...(input === undefined ? {} : { input: JSON.stringify(input) }),
    });
    let receipt = null;
    try {
      receipt = JSON.parse(result.stdout);
    } catch {
      /* Raw parse failures are evidence too. */
    }
    const row = {
      seed,
      metric,
      args,
      startedAt,
      wallMs: performance.now() - started,
      exit: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      receipt,
      stdout: result.stdout,
      stderr: result.stderr,
      timing: lastTimingRecord(result.stderr ?? ""),
    };
    rows.push(row);
    frame("command", row);
    if (requireSuccess) {
      assert.equal(result.status, 0, `${metric}: ${result.stdout}\n${result.stderr}`);
      assert.equal(receipt?.ok, true, `${metric}: ${result.stdout}`);
    }
    return receipt;
  };
  const check = (name, operation) => {
    try {
      operation();
      checks.push({ name, passed: true });
    } catch (error) {
      checks.push({ name, passed: false, error: error.message });
      throw error;
    } finally {
      frame("check", { seed, ...checks.at(-1) });
    }
  };
  const publish = (receipt, metric, actor) => {
    assert.equal(receipt.status, "accepted_durable", JSON.stringify(receipt));
    const published = invoke(
      `${metric}.publication`,
      ["receipt", "show", receipt.opId, "--wait", "git_verified,worktree_visible", "--timeout-ms", "5000"],
      { actor },
    );
    check(`${metric}.publication-facets`, () => {
      assert.equal(published.wait?.state, "satisfied", JSON.stringify(published));
      assert.equal(published.git?.state, "verified");
      assert.equal(published.worktree?.state, "verified");
    });
    return published;
  };
  const close = async () => {
    try {
      const stopped = invoke("cleanup.daemon-stop", ["daemon", "stop"], { requireSuccess: false });
      if (Number.isSafeInteger(stopped?.pid)) {
        const commandLine = `/proc/${stopped.pid}/cmdline`,
          deadline = Date.now() + 5000;
        while (existsSync(commandLine)) {
          let command;
          try {
            command = readFileSync(commandLine, "utf8");
          } catch (error) {
            if (error.code === "ENOENT") break;
            throw error;
          }
          // An empty command line is an exited zombie; a reused PID is no longer our daemon.
          if (!command.includes(userRoot)) break;
          assert.ok(Date.now() < deadline, `fixture daemon ${stopped.pid} did not exit after daemon stop`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        frame("daemon-exited", { seed, pid: stopped.pid });
      }
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5 });
    }
  };
  return { seed, parent, root, userRoot, rows, checks, invoke, check, publish, close };
}

export function resourceSnapshot(root) {
  const command = (args) => spawnSync(args[0], args.slice(1), { encoding: "utf8" }).stdout?.trim() ?? null;
  const sqlite = new DatabaseSync(":memory:");
  const sqliteVersion = sqlite.prepare("select sqlite_version() as version").get().version;
  sqlite.close();
  return {
    at: new Date().toISOString(),
    node: process.version,
    sqlite: sqliteVersion,
    platform: process.platform,
    arch: process.arch,
    parallelism: availableParallelism(),
    load: loadavg(),
    cpuAndRss: command(["ps", "-eo", "pid,ppid,pcpu,rss,time,args"]),
    disk: command(["du", "-sk", root]),
    filesystem: command(["df", "-T", root]),
  };
}

export function assertBytes(root, relativePath, expected, receipt, reader) {
  const event = reader.readEvent(receipt.opId);
  const claims =
    event?.payload?.changes?.map(({ path: claimPath, candidate }) => ({ path: claimPath, ...candidate })) ??
    event?.payload?.initialDocumentClaims ??
    [];
  const owned = event?.payload?.ownedContent;
  const binding = owned?.bindings?.find(({ path: claimPath }) => claimPath === relativePath);
  const claim = claims.find(({ path: claimPath }) => claimPath === relativePath);
  const digest = binding?.contentSha256 ?? claim?.sha256;
  assert.ok(digest, `No accepted content claim for ${relativePath} in ${event?.schema}`);
  assert.deepEqual(Buffer.from(reader.readContentBlob(digest)), expected);
  assert.deepEqual(readFileSync(path.join(root, "harness", relativePath)), expected);
  // Real `ha init` owns a nested authored Git repository, unlike the legacy hand-built fixture.
  assert.deepEqual(execFileSync("git", ["-C", path.join(root, "harness"), "show", `HEAD:${relativePath}`]), expected);
}

export function summarize(rows) {
  return Object.fromEntries(
    [...new Set(rows.map(({ metric }) => metric))].map((metric) => {
      const selected = rows.filter((row) => row.metric === metric),
        values = selected.map(({ wallMs }) => wallMs);
      return [
        metric,
        {
          samples: selected.length,
          success: selected.filter(({ exit, receipt }) => exit === 0 && receipt?.ok).length,
          durableReceiptResponses: selected.filter(({ receipt }) => receipt?.status === "accepted_durable").length,
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          p99: percentile(values, 0.99),
          min: Math.min(...values),
          max: Math.max(...values),
        },
      ];
    }),
  );
}

export function sourceIdentity() {
  const marker = path.resolve("tools/stress/entity-cli-calibration.source.json");
  return existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : { sha: "unverified" };
}
