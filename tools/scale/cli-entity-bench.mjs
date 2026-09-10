#!/usr/bin/env node
/**
 * Scale bench: every `ha` CLI command and every entity read/write path at 1k-10k Tasks, for data
 * correctness and latency. Run from the repository root; see tools/scale/README.md.
 *
 *   node tools/scale/cli-entity-bench.mjs --docker --tasks 1000 --out <host-dir>   # one-shot container
 *   node tools/scale/cli-entity-bench.mjs --tasks 1000 --out <dir>                  # inside the container
 *   node tools/scale/cli-entity-bench.mjs --matrix                                  # coverage matrix only
 *   node tools/scale/cli-entity-bench.mjs --compare a.json,b.json                   # latency ratios
 *
 * Population goes through the CLI's own parser and daemon client in one resident process with
 * --clients concurrent requests (the RPC arm). Every registry command is then measured as real
 * `ha` child processes (the CLI arm, with HA_CLI_TIMING phases); reads are also sampled on the
 * RPC arm. No SQL is written; the ledger is only opened read-only for the oracles.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { fixture, resourceSnapshot } from "../stress/entity-cli-calibration.fixture.mjs";
import { cli } from "../../packages/cli/test/daemon-multi-repo-lifecycle-cli.fixtures.ts";
import { benchKinds, commandTable, registryId } from "./cli-entity-bench.commands.mjs";
import { runOracles, runNegativeControls } from "./cli-entity-bench.oracles.mjs";
import * as report from "./cli-entity-bench.report.mjs";
import { benchContext, brief, factOp, issueServer, population, taskId } from "./cli-entity-bench.workload.mjs";

function parseArgs(argv) {
  const options = { tasks: 1000, samples: 5, clients: 8, seed: 20260911, out: null, populateBudgetS: Infinity };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (["--matrix", "--docker"].includes(key)) options[key.slice(2)] = true;
    else if (key === "--compare") options.compare = argv[++index].split(",");
    else if (["--tasks", "--samples", "--clients", "--seed"].includes(key))
      options[key.slice(2)] = Number(argv[++index]);
    else if (key === "--out") options.out = path.resolve(argv[++index]);
    else if (key === "--populate-budget-s") options.populateBudgetS = Number(argv[++index]);
    else throw new Error(`unknown option ${key}`);
  }
  return options;
}

async function runDocker() {
  const hostSamples = [];
  const name = `harness-test-isolation-scale-bench-${randomUUID().slice(0, 8)}`,
    inner = process.argv
      .slice(2)
      .filter((value, index, all) => value !== "--docker" && value !== "--out" && all[index - 1] !== "--out");
  const script = [
    "set -eu",
    "cd /workspace",
    "npm ci --no-audit --no-fund >/dev/null 2>&1",
    `node tools/test-hermetic-preflight.mjs --user-root /tmp/${name}`,
    `node tools/scale/cli-entity-bench.mjs ${inner.join(" ")} --out /out`,
  ].join("\n");
  const host = () => ({
    at: new Date().toISOString(),
    load: loadavg(),
    ncpu: spawnSync("sysctl", ["-n", "hw.ncpu"], { encoding: "utf8" }).stdout.trim(),
  });
  const hostBefore = host();
  const step = (command, commandArgs, options = {}) =>
    spawnSync(command, commandArgs, { stdio: "inherit", ...options }).status;
  let status = step("docker", [
    "create",
    "--init",
    "--name",
    name,
    "--workdir",
    "/workspace",
    "--entrypoint",
    "sh",
    "-e",
    `CLI_ENTITY_BENCH_SOURCE=${JSON.stringify(report.sourceIdentity())}`,
    "plt-center-testbed/source:latest",
    "-lc",
    script,
  ]);
  if (status !== 0) return status;
  try {
    const files = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "buffer",
    }).stdout;
    const tar = spawnSync("tar", ["--no-xattrs", "-cf", "-", "--null", "-T", "-"], {
      input: files,
      maxBuffer: 2 ** 31,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    status =
      tar.status === 0
        ? step("docker", ["cp", "-", `${name}:/workspace`], {
            input: tar.stdout,
            stdio: ["pipe", "inherit", "inherit"],
          })
        : tar.status;
    const samples = [],
      sampler = setInterval(() => samples.push(host()), 15_000);
    if (status === 0)
      status = await new Promise((resolve) =>
        spawn("docker", ["start", "-a", name], { stdio: "inherit" }).on("close", resolve),
      );
    clearInterval(sampler);
    hostSamples.push(...samples);
    mkdirSync(args.out, { recursive: true });
    step("docker", ["cp", `${name}:/out/.`, args.out]);
    writeFileSync(
      path.join(args.out, "host-load.json"),
      JSON.stringify({ container: name, before: hostBefore, during: hostSamples, after: host() }, null, 2),
    );
  } finally {
    step("docker", ["rm", "-f", name], { stdio: "ignore" });
  }
  return status;
}

async function main() {
  const { parseThinCommand } = await import("../../packages/cli/src/cli/thin-command.ts");
  const { runCommandThroughDaemon } = await import("../../packages/cli/src/daemon/client.ts");
  const { openSqliteEventStore } = await import("../../packages/kernel/src/store/sqlite-event-store.ts");
  mkdirSync(args.out, { recursive: true });
  const started = Date.now(),
    f = fixture(args.seed, { daemonId: "scale-bench", frames: false }),
    n = args.tasks,
    writes = [],
    rpcRows = [],
    phases = {},
    snapshots = [],
    errors = [],
    log = (message) => console.log(`[scale-bench ${((Date.now() - started) / 1000).toFixed(0)}s] ${message}`),
    // Phase boundaries after the CLI arm, in seconds since start, so a slow phase is attributable.
    mark = (label) => {
      (phases.marks ??= {})[label] = Math.round((Date.now() - started) / 1000);
      log(label);
    };
  // runtime instance create probes the provider CLI; a version-only stub stands in for it.
  const bin = path.join(f.parent, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "codex"), '#!/bin/sh\necho "codex-cli 0.0.0-scale-bench"\n', { mode: 0o755 });
  f.env.PATH = `${bin}${path.delimiter}${f.env.PATH}`;
  Object.assign(process.env, f.env);
  const snap = (label) => snapshots.push({ label, ...resourceSnapshot(f.root), cpuAndRss: undefined });
  const rpc = async (metric, argv, record = {}) => {
    const parsed = parseThinCommand(["--root", f.root, "--json", ...argv]),
      at = performance.now();
    let receipt = null,
      error = parsed.ok ? null : parsed.code;
    if (parsed.ok)
      try {
        receipt = await runCommandThroughDaemon(parsed.command, undefined, { env: f.env });
      } catch (thrown) {
        error = thrown.message;
      }
    const row = {
      metric,
      arm: "rpc",
      atMs: Math.round(at),
      wallMs: performance.now() - at,
      ...brief(receipt),
      error,
      ...record,
    };
    rpcRows.push(row);
    return row;
  };
  const pool = async (items, clients, work, deadline = Infinity) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: clients }, async () => {
        while (next < items.length && performance.now() < deadline) await work(items[next++]);
      }),
    );
    return next;
  };
  const issues = await issueServer();
  let initRevision = 0,
    beforeRebuild = {},
    afterRebuild = {};
  const lists = {};
  try {
    snap("start");
    f.invoke(
      "repo-bootstrap",
      ["init", "--repo-id", "scale-bench", "--person-id", "owner", "--display-name", "Owner"],
      { timeoutMs: 120_000 },
    );
    initRevision = readHead(openSqliteEventStore, f.root);
    // Population: Tasks first (the other kinds point at them), then every other kind interleaved.
    const ops = population(f, n),
      deadline = performance.now() + args.populateBudgetS * 1000;
    for (const [label, group] of [
      ["tasks", ops.filter((op) => op.kind === "task")],
      ["others", ops.filter((op) => op.kind !== "task")],
    ]) {
      const at = performance.now();
      const issued = await pool(
        group,
        args.clients,
        async (op) => {
          const row = await rpc(`populate:${op.kind}`, op.argv, { clients: args.clients });
          writes.push({ ...op, ...row, argv: undefined });
          if (writes.length % 1000 === 0) log(`populated ${writes.length}/${ops.length}`);
        },
        deadline,
      );
      // A budget stop is a result: the reached counts are what every later number was measured at.
      phases[`populate-${label}`] = { ops: issued, planned: group.length, wallMs: performance.now() - at };
      if (issued < group.length) log(`population budget exhausted at ${issued}/${group.length} ${label}`);
    }
    snap("populated");
    log(`population done: ${writes.filter((w) => w.status === "accepted_durable").length}/${ops.length} accepted`);
    // Throughput: the same write shape on 1 client and on --clients clients.
    for (const clients of [1, args.clients]) {
      const batch = Array.from({ length: 100 }, (_, index) => factOp(f, n, `tput-${clients}-${index}`)),
        at = performance.now();
      await pool(batch, clients, async (op) =>
        writes.push({
          ...op,
          ...(await rpc(`throughput:fact-record:${clients}`, op.argv, { clients })),
          argv: undefined,
        }),
      );
      phases[`throughput-${clients}`] = {
        ops: batch.length,
        wallMs: performance.now() - at,
        opsPerSecond: batch.length / ((performance.now() - at) / 1000),
      };
    }
    const context = benchContext(f, n, writes, args.samples);
    // CLI arm: every mapped registry command, --samples real processes each, in table order.
    const cliStart = f.rows.length;
    for (const [metric, build, options = {}] of commandTable) {
      if (typeof build === "string") continue;
      for (let s = 0; s < args.samples; s++) {
        let argv;
        try {
          argv = build(context, s);
        } catch (error) {
          f.rows.push({ metric, s, arm: "cli", buildError: error.message, wallMs: null });
          continue;
        }
        const receipt = f.invoke(metric, argv, { requireSuccess: false, timeoutMs: 600_000, ...options });
        Object.assign(f.rows.at(-1), { s, arm: "cli", expect: context.takeExpect() });
        context.got.set(`${metric}#${s}`, receipt);
      }
      log(`cli ${metric}`);
    }
    phases.cli = { rows: f.rows.length - cliStart };
    // RPC arm for every read command (no process start, same request path).
    const reads = await readMetrics();
    for (const [metric, build] of commandTable.filter(
      ([metric, build]) => typeof build === "function" && reads.has(registryId(metric)),
    ))
      for (let s = 0; s < args.samples; s++) await rpc(`read:${metric}`, build(context, s));
    mark("rpc-reads");
    // 8 concurrent CLI processes, write then read, three rounds.
    for (let round = 0; round < 3; round++) {
      await concurrentCli(
        f,
        "cli8:fact-record",
        Array.from({ length: args.clients }, (_, client) => factOp(f, n, `cli8-${round}-${client}`)),
        writes,
      );
      await concurrentCli(
        f,
        "cli8:task-show",
        Array.from({ length: args.clients }, (_, client) => ({ argv: ["task", "show", taskId(client % n)] })),
      );
    }
    snap("measured");
    mark("cli-concurrent");
    // Cold reads: stop -> start -> first read, per read shape.
    for (const [metric, argv] of coldReads()) {
      await stopDaemon(f);
      f.invoke("daemon-start", ["daemon", "start", "--service"], { requireSuccess: false, timeoutMs: 600_000 });
      f.invoke(`cold:${metric}`, argv, { requireSuccess: false, timeoutMs: 600_000 });
      f.invoke(`warm:${metric}`, argv, { requireSuccess: false, timeoutMs: 600_000 });
    }
    mark("cold-reads");
    // Rebuild oracle input: the same reads before and after a full projection rebuild.
    const listed = async () =>
      Object.fromEntries(
        await Promise.all(
          coldReads().map(async ([metric, argv]) => [
            metric,
            digestRows(await rpcFull(parseThinCommand, runCommandThroughDaemon, f, argv)),
          ]),
        ),
      );
    beforeRebuild = await listed();
    f.invoke("daemon-projection-rebuild", ["daemon", "projection", "rebuild"], {
      requireSuccess: false,
      timeoutMs: 1_800_000,
    });
    afterRebuild = await listed();
    for (const [metric, argv] of listReads())
      lists[metric] = await rpcFull(parseThinCommand, runCommandThroughDaemon, f, argv);
    snap("end");
    mark("rebuild-and-lists");
    phases.done = true;
  } catch (error) {
    errors.push({ phase: "measure", message: error.stack ?? String(error) });
    log(`phase failed: ${error.message}`);
  }
  let oracles = {},
    negativeControls = [];
  const cliRows = f.rows.map(report.compactRow);
  try {
    const store = openSqliteEventStore({ rootInput: f.root, repoId: "scale-bench", readOnly: true }),
      classes = new Map((await report.coverage()).map(({ id, commandClass }) => [id, commandClass]));
    const cliWrites = f.rows
      .filter((row) => row.receipt && ["repo-write", "arbiter", "admin"].includes(classes.get(registryId(row.metric))))
      .map((row) => ({ metric: row.metric, ...brief(row.receipt), receipt: row.receipt, expect: row.expect }));
    const oracleInput = {
      store,
      initRevision,
      writes: [...writes, ...cliWrites],
      lists,
      cliRows,
      beforeRebuild,
      afterRebuild,
    };
    oracles = runOracles(oracleInput);
    negativeControls = runNegativeControls(oracleInput);
    store.close();
    mark("oracles");
  } catch (error) {
    errors.push({ phase: "oracles", message: error.stack ?? String(error) });
  }
  try {
    const result = {
      schema: "cli-entity-bench/v1",
      source: report.sourceIdentity(),
      params: { ...args, out: undefined },
      counts: report.countBy(writes, (w) => `${w.kind}:${w.status ?? w.code ?? w.error}`),
      phases,
      oracles,
      negativeControls,
      coverage: await report.coverage(),
      summary: report.summarize([...cliRows, ...rpcRows]),
      snapshots,
      samples: {
        cli: cliRows,
        rpc: rpcRows,
        writes: writes.map(({ values: _values, blobs: _blobs, ...rest }) => rest),
      },
      errors,
      elapsedMs: Date.now() - started,
    };
    const file = path.join(args.out, `bench-results-${result.source.sha.slice(0, 12)}-${n}.json`);
    writeFileSync(file, JSON.stringify(result));
    writeFileSync(file.replace(/\.json$/u, ".md"), report.summaryMarkdown(result));
    log(
      `wrote ${file}; oracles ${Object.values(oracles)
        .map((o) => `${o.id}=${o.verdict}`)
        .join(" ")}`,
    );
  } finally {
    issues.close();
    await f.close().catch((error) => console.error(`cleanup: ${error.message}`));
  }
}

async function rpcFull(parseThinCommand, runCommandThroughDaemon, f, argv) {
  const parsed = parseThinCommand(["--root", f.root, "--json", ...argv]);
  return runCommandThroughDaemon(parsed.command, undefined, { env: f.env }).catch((error) => ({
    ok: false,
    error: error.message,
  }));
}

function digestRows(receipt) {
  let evidence = receipt?.evidence;
  if (typeof evidence === "string")
    try {
      evidence = JSON.parse(evidence);
    } catch {
      /* keep the raw string */
    }
  return {
    ok: receipt?.ok ?? null,
    code: receipt?.code ?? null,
    sha256: createHash("sha256")
      .update(JSON.stringify(evidence ?? null))
      .digest("hex"),
  };
}

const coldReads = () => [
  ["task-list", ["task", "list"]],
  ["decision-list", ["decision", "list"]],
  ["fact-search", ["fact", "search", "bench"]],
  ["relation-list", ["relation", "list"]],
  ["agenda", ["agenda"]],
  ...benchKinds.map((kind) => [`entity-list~${kind}`, ["entity", "list", kind]]),
];
const listReads = () => [
  ["task", ["task", "list"]],
  ...benchKinds.map((kind) => [`entity:${kind}`, ["entity", "list", kind]]),
];

async function readMetrics() {
  const { thinCliCommands } = await import("../../packages/daemon/src/protocol/daemon-protocol.contract.ts");
  return new Set(thinCliCommands.filter(({ commandClass }) => commandClass === "repo-read").map(({ id }) => id));
}

// Same exit test as the calibration fixture's close(): an empty cmdline is a zombie, a foreign one a reused pid.
async function stopDaemon(f) {
  const stopped = f.invoke("daemon-stop", ["daemon", "stop"], { requireSuccess: false, timeoutMs: 600_000 }),
    alive = () => {
      try {
        return readFileSync(`/proc/${stopped.pid}/cmdline`, "utf8").includes(f.userRoot);
      } catch {
        return false;
      }
    };
  for (const deadline = Date.now() + 120_000; Number.isSafeInteger(stopped?.pid) && alive() && Date.now() < deadline; )
    await new Promise((resolve) => setTimeout(resolve, 50));
}

function concurrentCli(f, metric, ops, writes) {
  return Promise.all(
    ops.map(
      (op, client) =>
        new Promise((resolve) => {
          const at = performance.now(),
            child = spawn(process.execPath, [cli, "--root", f.root, "--json", ...op.argv], { env: f.env });
          let stdout = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.resume();
          child.on("close", (exit) => {
            let receipt = null;
            try {
              receipt = JSON.parse(stdout);
            } catch {
              /* parse failures are evidence */
            }
            const row = {
              metric,
              arm: "cli-concurrent",
              client,
              wallMs: performance.now() - at,
              exit,
              ...brief(receipt),
            };
            f.rows.push({ ...row, receipt: null });
            if (writes) writes.push({ ...op, ...row, argv: undefined });
            resolve(row);
          });
        }),
    ),
  );
}

function readHead(openSqliteEventStore, root) {
  const store = openSqliteEventStore({ rootInput: root, repoId: "scale-bench", readOnly: true });
  try {
    return store.revision();
  } finally {
    store.close();
  }
}

// Dispatch last: the module-level helpers above must be initialized before main() runs.
const args = parseArgs(process.argv.slice(2));
if (args.matrix) console.log(report.matrixMarkdown(await report.coverage()));
else if (args.compare)
  console.log(report.compareMarkdown(...args.compare.map((file) => JSON.parse(readFileSync(file, "utf8")))));
else if (args.docker) process.exitCode = await runDocker();
else await main();
