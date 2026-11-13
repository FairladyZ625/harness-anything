#!/usr/bin/env node
/**
 * Scale bench: every `ha` CLI command and every entity read/write path at 1k-10k Tasks, for data
 * correctness and latency. Run from the repository root; see tools/scale/README.md.
 *
 *   node tools/scale/cli-entity-bench.mjs --tasks 1000 --out <dir>                  # inside the container
 *   node tools/scale/cli-entity-bench.mjs --matrix                                  # coverage matrix only
 *   node tools/scale/cli-entity-bench.mjs --compare a.json,b.json                   # latency ratios
 *
 * Population goes through the CLI's own parser and daemon client in one resident process with
 * --clients concurrent requests (the RPC arm). Every registry command is then measured as real
 * `ha` child processes (the CLI arm, with HA_CLI_TIMING phases); reads are also sampled on the
 * RPC arm. No SQL is written; the ledger is only opened read-only for the oracles.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    if (key === "--matrix") options.matrix = true;
    else if (key === "--compare") options.compare = argv[++index].split(",");
    else if (["--tasks", "--samples", "--clients", "--seed"].includes(key))
      options[key.slice(2)] = Number(argv[++index]);
    else if (key === "--out") options.out = path.resolve(argv[++index]);
    else if (key === "--populate-budget-s") options.populateBudgetS = Number(argv[++index]);
    else throw new Error(`unknown option ${key}`);
  }
  return options;
}

async function main() {
  const { parseThinCommand } = await import("../../packages/cli/src/cli/thin-command.ts");
  const { runCommandThroughDaemon } = await import("../../packages/cli/src/daemon/client.ts");
  const { openSqliteEventStore } = await import("../../packages/storage/src/store/sqlite-event-store.ts");
  mkdirSync(args.out, { recursive: true });
  const started = Date.now(),
    f = await fixture(args.seed, { daemonId: "scale-bench", frames: false }),
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
    const invokeReadBenchCommand = (commandId, metric, argv, callOptions) => {
      const runRead = (prefix) => f.invoke(metric, [...prefix, ...argv.slice(prefix.length)], callOptions);
      switch (commandId) {
        case "task-show":
          return runRead(["task", "show"]);
        case "task-read-set":
          return runRead(["task", "read-set"]);
        case "task-dispatches":
          return runRead(["task", "dispatches"]);
        case "receipt-show":
          return runRead(["receipt", "show"]);
        case "doc-status":
          return runRead(["doc", "status"]);
        case "doc-sync-dry-run":
          return runRead(["doc", "sync", "--dry-run"]);
        case "doc-show":
          return runRead(["doc", "show"]);
        case "task-review":
          return runRead(["task", "review"]);
        case "task-list":
          return runRead(["task", "list"]);
        case "agenda":
          return runRead(["agenda"]);
        case "fact-show":
          return runRead(["fact", "show"]);
        case "fact-type-list":
          return runRead(["fact", "type", "list"]);
        case "decision-show":
          return runRead(["decision", "show"]);
        case "decision-list":
          return runRead(["decision", "list"]);
        case "decision-validate":
          return runRead(["decision", "validate"]);
        case "decision-verify":
          return runRead(["decision", "verify"]);
        case "relation-list":
          return runRead(["relation", "list"]);
        case "entity-get":
          return runRead(["entity", "get"]);
        case "entity-list":
          return runRead(["entity", "list"]);
        case "explain":
          return runRead(["explain"]);
        case "agent-validate":
          return runRead(["agent", "validate"]);
        case "agent-list":
          return runRead(["agent", "list"]);
        case "agent-inspect":
          return runRead(["agent", "inspect"]);
        case "squad-validate":
          return runRead(["squad", "validate"]);
        case "squad-list":
          return runRead(["squad", "list"]);
        case "squad-inspect":
          return runRead(["squad", "inspect"]);
        case "runtime-status":
          return runRead(["runtime", "status"]);
        case "schedule-list":
          return runRead(["schedule", "list"]);
        case "schedule-show":
          return runRead(["schedule", "show"]);
        case "schedule-runs":
          return runRead(["schedule", "runs"]);
        case "settings-read":
          return runRead(["settings", "read"]);
        case "vertical-validate":
          return runRead(["vertical", "validate"]);
        case "preset-list":
          return runRead(["preset", "list"]);
        case "preset-inspect":
          return runRead(["preset", "inspect"]);
        case "preset-check":
          return runRead(["preset", "check"]);
        case "preset-audit":
          return runRead(["preset", "audit"]);
        case "preset-validate":
          return runRead(["preset", "validate"]);
        case "template-list":
          return runRead(["template", "list"]);
        case "template-render":
          return runRead(["template", "render"]);
        case "script-list":
          return runRead(["script", "list"]);
        case "script-inspect":
          return runRead(["script", "inspect"]);
        case "ledger-reconcile":
          return runRead(["ledger", "reconcile"]);
        case "daemon-status":
          return runRead(["daemon", "status"]);
        case "events-tail":
          return runRead(["events", "tail"]);
        default:
          return undefined;
      }
    };
    const invokeBenchCommand = (metric, argv, callOptions) => {
      const commandId = metric.split("~", 1)[0];
      const readReceipt = invokeReadBenchCommand(commandId, metric, argv, callOptions);
      if (readReceipt !== undefined) return readReceipt;
      switch (commandId) {
        case "version":
          return f.invoke(metric, ["--version"], callOptions);
        case "help":
          return f.invoke(metric, ["--help"], callOptions);
        case "capabilities":
          return f.invoke(metric, ["capabilities"], callOptions);
        case "task-create":
          return f.invoke(metric, ["task", "create", ...argv.slice(2)], callOptions);
        case "task-amend":
          return f.invoke(metric, ["task", "amend", ...argv.slice(2)], callOptions);
        case "task-pin":
          return f.invoke(metric, ["task", "pin", ...argv.slice(2)], callOptions);
        case "task-unpin":
          return f.invoke(metric, ["task", "unpin", ...argv.slice(2)], callOptions);
        case "doc-sync-submit":
          return f.invoke(metric, ["doc", "sync", "--submit", ...argv.slice(3)], callOptions);
        case "task-start":
          return f.invoke(metric, ["task", "start", ...argv.slice(2)], callOptions);
        case "task-progress-append":
          return f.invoke(metric, ["task", "progress", "append", ...argv.slice(3)], callOptions);
        case "task-artifact-add":
          return f.invoke(metric, ["task", "artifact", "add", ...argv.slice(3)], callOptions);
        case "fact-record":
          return f.invoke(metric, ["fact", "record", ...argv.slice(2)], callOptions);
        case "task-submit":
          return f.invoke(metric, ["task", "submit", ...argv.slice(2)], callOptions);
        case "task-review-execution":
          return f.invoke(metric, ["task", "review-execution", ...argv.slice(2)], callOptions);
        case "task-review-consent":
          return f.invoke(metric, ["task", "review-consent", ...argv.slice(2)], callOptions);
        case "task-complete":
          return f.invoke(metric, ["task", "complete", ...argv.slice(2)], callOptions);
        case "task-release":
          return f.invoke(metric, ["task", "release", ...argv.slice(2)], callOptions);
        case "task-transition":
          return f.invoke(metric, ["task", "transition", ...argv.slice(2)], callOptions);
        case "task-declare-executor":
          return f.invoke(metric, ["task", "declare-executor", ...argv.slice(2)], callOptions);
        case "task-archive":
          return f.invoke(metric, ["task", "archive", ...argv.slice(2)], callOptions);
        case "task-reopen":
          return f.invoke(metric, ["task", "reopen", ...argv.slice(2)], callOptions);
        case "task-supersede":
          return f.invoke(metric, ["task", "supersede", ...argv.slice(2)], callOptions);
        case "task-delete":
          return f.invoke(metric, ["task", "delete", ...argv.slice(2)], callOptions);
        case "task-contract-migrate":
          return f.invoke(metric, ["task", "contract", "migrate", ...argv.slice(3)], callOptions);
        case "fact-type-register":
          return f.invoke(metric, ["fact", "type", "register", ...argv.slice(3)], callOptions);
        case "fact-reclassify":
          return f.invoke(metric, ["fact", "reclassify", ...argv.slice(2)], callOptions);
        case "distill-candidate":
          return f.invoke(metric, ["distill", "candidate", ...argv.slice(2)], callOptions);
        case "distill-promote":
          return f.invoke(metric, ["distill", "promote", ...argv.slice(2)], callOptions);
        case "decision-propose":
          return f.invoke(metric, ["decision", "propose", ...argv.slice(2)], callOptions);
        case "decision-amend":
          return f.invoke(metric, ["decision", "amend", ...argv.slice(2)], callOptions);
        case "decision-claim-add":
          return f.invoke(metric, ["decision", "claim", "add", ...argv.slice(3)], callOptions);
        case "decision-reckon":
          return f.invoke(metric, ["decision", "reckon", ...argv.slice(2)], callOptions);
        case "relation-relate":
          return f.invoke(metric, ["relation", "relate", ...argv.slice(2)], callOptions);
        case "decision-accept":
          return f.invoke(metric, ["decision", "accept", ...argv.slice(2)], callOptions);
        case "decision-claim-fulfill":
          return f.invoke(metric, ["decision", "claim", "fulfill", ...argv.slice(3)], callOptions);
        case "decision-transition":
          return f.invoke(metric, ["decision", "transition", ...argv.slice(2)], callOptions);
        case "decision-defer":
          return f.invoke(metric, ["decision", "defer", ...argv.slice(2)], callOptions);
        case "decision-reject":
          return f.invoke(metric, ["decision", "reject", ...argv.slice(2)], callOptions);
        case "decision-retire":
          return f.invoke(metric, ["decision", "retire", ...argv.slice(2)], callOptions);
        case "decision-repin":
          return f.invoke(metric, ["decision", "repin", ...argv.slice(2)], callOptions);
        case "relation-reconfirm":
          return f.invoke(metric, ["relation", "reconfirm", ...argv.slice(2)], callOptions);
        case "relation-unrelate":
          return f.invoke(metric, ["relation", "unrelate", ...argv.slice(2)], callOptions);
        case "entity-import":
          return f.invoke(metric, ["entity", "import", ...argv.slice(2)], callOptions);
        case "entity-update":
          return f.invoke(metric, ["entity", "update", ...argv.slice(2)], callOptions);
        case "entity-archive":
          return f.invoke(metric, ["entity", "archive", ...argv.slice(2)], callOptions);
        case "entity-delete":
          return f.invoke(metric, ["entity", "delete", ...argv.slice(2)], callOptions);
        case "agent-install":
          return f.invoke(metric, ["agent", "install", ...argv.slice(2)], callOptions);
        case "squad-install":
          return f.invoke(metric, ["squad", "install", ...argv.slice(2)], callOptions);
        case "runtime-instance-create":
          return f.invoke(metric, ["runtime", "instance", "create", ...argv.slice(3)], callOptions);
        case "runtime-instance-list":
          return f.invoke(metric, ["runtime", "instance", "list", ...argv.slice(3)], callOptions);
        case "runtime-instance-show":
          return f.invoke(metric, ["runtime", "instance", "show", ...argv.slice(3)], callOptions);
        case "runtime-instance-update":
          return f.invoke(metric, ["runtime", "instance", "update", ...argv.slice(3)], callOptions);
        case "schedule-create":
          return f.invoke(metric, ["schedule", "create", ...argv.slice(2)], callOptions);
        case "schedule-update":
          return f.invoke(metric, ["schedule", "update", ...argv.slice(2)], callOptions);
        case "schedule-disable":
          return f.invoke(metric, ["schedule", "disable", ...argv.slice(2)], callOptions);
        case "schedule-delete":
          return f.invoke(metric, ["schedule", "delete", ...argv.slice(2)], callOptions);
        case "runtime-instance-delete":
          return f.invoke(metric, ["runtime", "instance", "delete", ...argv.slice(3)], callOptions);
        case "agent-delete":
          return f.invoke(metric, ["agent", "delete", ...argv.slice(2)], callOptions);
        case "squad-delete":
          return f.invoke(metric, ["squad", "delete", ...argv.slice(2)], callOptions);
        case "settings-update":
          return f.invoke(metric, ["settings", "update", ...argv.slice(2)], callOptions);
        case "vertical-declaration-migrate":
          return f.invoke(metric, ["migrate", "vertical-declaration", ...argv.slice(2)], callOptions);
        case "preset-install":
          return f.invoke(metric, ["preset", "install", ...argv.slice(2)], callOptions);
        case "preset-seed":
          return f.invoke(metric, ["preset", "seed", ...argv.slice(2)], callOptions);
        case "preset-uninstall":
          return f.invoke(metric, ["preset", "uninstall", ...argv.slice(2)], callOptions);
        case "preset-upgrade":
          return f.invoke(metric, ["preset", "upgrade", ...argv.slice(2)], callOptions);
        case "doc-materialize":
          return f.invoke(metric, ["doc", "materialize", ...argv.slice(2)], callOptions);
        case "doc-retire":
          return f.invoke(metric, ["doc", "retire", ...argv.slice(2)], callOptions);
        case "backup":
          return f.invoke(metric, ["backup", ...argv.slice(1)], callOptions);
        case "restore-drill":
          return f.invoke(metric, ["restore", "--drill", ...argv.slice(2)], callOptions);
        default:
          throw new Error(`unmapped cli-entity-bench command: ${metric}`);
      }
    };
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
        const receipt = invokeBenchCommand(metric, argv, { requireSuccess: false, timeoutMs: 600_000, ...options });
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
        (op) =>
          spawn(process.execPath, [cli, "--root", f.root, "--json", "fact", "record", ...op.argv.slice(2)], {
            env: f.env,
          }),
      );
      await concurrentCli(
        f,
        "cli8:task-show",
        Array.from({ length: args.clients }, (_, client) => ({ argv: ["task", "show", taskId(client % n)] })),
        undefined,
        (op, client) =>
          spawn(process.execPath, [cli, "--root", f.root, "--json", "task", "show", taskId(client % n)], {
            env: f.env,
          }),
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
/** @param {Awaited<ReturnType<typeof fixture>>} f */
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

function concurrentCli(f, metric, ops, writes, launchChild) {
  return Promise.all(
    ops.map(
      (op, client) =>
        new Promise((resolve) => {
          const at = performance.now(),
            child = launchChild(op, client);
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
else await main();
