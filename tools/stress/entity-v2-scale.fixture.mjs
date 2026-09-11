import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, loadavg, availableParallelism, cpus, totalmem, freemem } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cli, git } from "../../packages/cli/test/daemon-multi-repo-lifecycle-cli.fixtures.ts";
import { percentile } from "../measure-cli-command-timing.mjs";

export const frame = (type, value) =>
  console.log(`ENTITY_V2_SCALE\t${JSON.stringify({ type, at: Date.now(), ...value })}`);

export const workloadConfigPath = path.resolve(import.meta.dirname, "entity-v2-scale.workload.json");

export function readWorkloadConfig() {
  return JSON.parse(readFileSync(workloadConfigPath, "utf8"));
}

/** Deterministic bytes for one entity; the same seed always rebuilds the same buffer. */
export function syntheticBinary(seed, size) {
  const buffer = Buffer.alloc(size);
  let state = seed >>> 0 || 1;
  for (let offset = 0; offset < size; offset++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    buffer[offset] = state & 255;
  }
  return buffer;
}

export function fixture(seed, daemonId = "entity-v2-scale") {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-entity-v2-scale-"));
  const root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  mkdirSync(root);
  writeFileSync(path.join(root, "README.md"), "# V2 scale fixture\n");
  git(root, "init", "--quiet");
  git(root, "add", "README.md");
  git(root, "commit", "--quiet", "-m", "fixture");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("HARNESS_") || key.startsWith("HA_CLI_TIMING")) delete env[key];
  }
  Object.assign(env, {
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: daemonId,
    HARNESS_GIT_AUTHOR_NAME: "V2 Scale Fixture",
    HARNESS_GIT_AUTHOR_EMAIL: "v2-scale@example.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  const rows = [],
    checks = [];
  const record = (row) => {
    rows.push(row);
    if (row.frame !== false) frame("command", { ...row, stdout: row.stdout?.slice(0, 4096) });
    return row;
  };
  /** Arm A: one real `ha` child process per operation, the full CLI chain a user pays for. */
  const invoke = (
    metric,
    args,
    { actor, input, requireSuccess = true, frameRow = true, timeoutMs = 120_000, offline = false } = {},
  ) => {
    const started = performance.now();
    // Offline storage commands (backup, restore, events, migrate ledger) are recognised by argv[0].
    const argv = offline ? [...args, "--root", root, "--json"] : ["--root", root, "--json", ...args];
    const result = spawnSync(process.execPath, [cli, ...argv], {
      env: { ...env, ...(actor ? { HARNESS_ACTOR: actor } : {}) },
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
      ...(input === undefined ? {} : { input: JSON.stringify(input) }),
    });
    let receipt = null;
    try {
      receipt = JSON.parse(result.stdout);
    } catch {
      /* Parse failures are evidence too. */
    }
    const row = {
      seed,
      metric,
      arm: "cli-process",
      args: argv,
      wallMs: performance.now() - started,
      exit: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      receipt,
      stdout: result.stdout,
      stderr: result.stderr?.slice(0, 2048),
      frame: frameRow,
    };
    record(row);
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
      frame("check", { seed, ...checks.at(-1) });
      throw error;
    }
    frame("check", { seed, ...checks.at(-1) });
  };
  const publish = (receipt, metric, actor) => {
    assert.equal(receipt.status, "accepted_durable", JSON.stringify(receipt));
    const published = invoke(
      `${metric}.publication`,
      ["receipt", "show", receipt.opId, "--wait", "git_verified,worktree_visible", "--timeout-ms", "15000"],
      { actor },
    );
    check(`${metric}.publication-facets`, () => {
      assert.equal(published.wait?.state, "satisfied", JSON.stringify(published));
      assert.equal(published.git?.state, "verified");
      assert.equal(published.worktree?.state, "verified");
    });
    return published;
  };
  /** Stop this fixture's daemon and wait until its process is gone, so the ledger has no live writer. */
  const stopDaemon = async (metric) => {
    const stopped = invoke(metric, ["daemon", "stop"], { requireSuccess: false });
    if (!Number.isSafeInteger(stopped?.pid)) return stopped;
    const commandLine = `/proc/${stopped.pid}/cmdline`,
      deadline = Date.now() + 10_000;
    while (existsSync(commandLine) && Date.now() < deadline) {
      let command;
      try {
        command = readFileSync(commandLine, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") break;
        throw error;
      }
      if (!command.includes(userRoot)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return stopped;
  };
  const close = async () => {
    try {
      await stopDaemon("cleanup.daemon-stop");
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5 });
    }
  };
  return { seed, parent, root, userRoot, env, rows, checks, invoke, check, publish, stopDaemon, close };
}

export function resourceSnapshot(root, label) {
  const command = (args) =>
    spawnSync(args[0], args.slice(1), { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).stdout?.trim() ?? null;
  const sqlite = new DatabaseSync(":memory:");
  const sqliteVersion = sqlite.prepare("select sqlite_version() as version").get().version;
  sqlite.close();
  return {
    label,
    at: new Date().toISOString(),
    node: process.version,
    sqlite: sqliteVersion,
    platform: process.platform,
    arch: process.arch,
    parallelism: availableParallelism(),
    cpuModel: cpus()[0]?.model ?? null,
    totalMemBytes: totalmem(),
    freeMemBytes: freemem(),
    load: loadavg(),
    selfRssBytes: process.memoryUsage().rss,
    daemonProcesses: command([
      "bash",
      "-lc",
      "ps -eo pid,pcpu,rss,etime,args | grep -F 'daemon' | grep -v grep | head -20",
    ]),
    diskBytes: directoryBytes(root),
    filesystem: command(["df", "-T", root]),
  };
}

export function directoryBytes(target) {
  const output = spawnSync("du", ["-sb", target], { encoding: "utf8" }).stdout?.trim();
  return output ? Number(output.split(/\s+/u)[0]) : null;
}

/** Exact-byte oracle across the canonical blob, the materialized worktree and authored Git. */
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
  assert.deepEqual(
    execFileSync("git", ["-C", path.join(root, "harness"), "show", `HEAD:${relativePath}`], {
      maxBuffer: 128 * 1024 * 1024,
    }),
    expected,
  );
}

export function summarize(rows, filter = () => true) {
  const selected = rows.filter(filter);
  return Object.fromEntries(
    [...new Set(selected.map(({ metric }) => metric))].map((metric) => {
      const scoped = selected.filter((row) => row.metric === metric),
        values = scoped.map(({ wallMs }) => wallMs);
      return [
        metric,
        {
          arm: scoped[0]?.arm ?? null,
          samples: scoped.length,
          success: scoped.filter(({ exit, receipt, ok }) =>
            exit === undefined ? ok === true : exit === 0 && receipt?.ok,
          ).length,
          durableReceipts: scoped.filter(({ receipt }) => receipt?.status === "accepted_durable").length,
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          p99: percentile(values, 0.99),
          min: Math.min(...values),
          max: Math.max(...values),
          totalMs: values.reduce((sum, value) => sum + value, 0),
        },
      ];
    }),
  );
}
