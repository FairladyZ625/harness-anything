#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { readObserveTail } from "../../packages/daemon/src/observe-tail.ts";

const DEFAULT_ROOT = process.env.HARNESS_CANONICAL_ROOT ?? process.cwd();
const DEFAULT_LOG = path.join(
  process.env.HARNESS_DAEMON_USER_ROOT ?? process.env.HARNESS_USER_ROOT ?? path.join(homedir(), ".harness"),
  "logs/daemon-default.log",
);
const FIRST_SCREEN_READS = Object.freeze([
  "getSystemStatus",
  "getTasks",
  "getWorkspaceSummary",
  "getRelationGraph",
  "getDecisions",
  "getCatalogSnapshot",
  "listRuntimeInstances",
]);

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, log: DEFAULT_LOG, samples: 20, jsonOut: null, markdownOut: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = argv[++index];
    else if (arg === "--log") options.log = argv[++index];
    else if (arg === "--samples") options.samples = Number(argv[++index]);
    else if (arg === "--json-out") options.jsonOut = argv[++index];
    else if (arg === "--markdown-out") options.markdownOut = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.samples) || options.samples < 1)
    throw new Error("--samples must be a positive integer");
  return options;
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function stats(values) {
  return {
    count: values.length,
    minMs: Number(Math.min(...values).toFixed(3)),
    p50Ms: Number(percentile(values, 50).toFixed(3)),
    p95Ms: Number(percentile(values, 95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

function command(root, args) {
  const started = performance.now();
  const result = spawnSync("ha", [...args, "--root", root], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    error: result.error?.message ?? null,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function latestCanonicalAttachRecords(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.includes('"event":"repo_attach_completed"') && line.includes('"repoId":"canonical"'))
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return Number.isFinite(value.durationMs)
          ? [
              {
                at: value.at ?? null,
                pid: value.pid ?? null,
                durationMs: Number(value.durationMs.toFixed(3)),
                raw: line,
              },
            ]
          : [];
      } catch {
        return [];
      }
    })
    .slice(-3);
}

function parseDaemonStatus(stdout, root) {
  try {
    const receipt = JSON.parse(stdout);
    const repos = Array.isArray(receipt?.repos) ? receipt.repos : [];
    const canonical = repos.find((repo) => repo?.repoId === "canonical" || repo?.rootDir === root);
    return {
      schema: receipt?.schema ?? null,
      ok: receipt?.ok === true,
      outcome: receipt?.outcome ?? null,
      daemonId: receipt?.daemonId ?? null,
      pid: receipt?.pid ?? null,
      startedAt: receipt?.startedAt ?? null,
      canonical: canonical
        ? {
            repoId: canonical.repoId ?? null,
            rootDir: canonical.rootDir ?? null,
            state: canonical.state ?? null,
            queueDepth: canonical.queueDepth ?? null,
            lastError: canonical.lastError ?? null,
          }
        : null,
      rawExcerpt: stdout.trim().slice(0, 1200),
    };
  } catch {
    return {
      schema: null,
      ok: false,
      outcome: null,
      daemonId: null,
      pid: null,
      startedAt: null,
      canonical: null,
      rawExcerpt: stdout.trim().slice(0, 1200),
    };
  }
}

async function replayRuntimeEvents(root, count) {
  const fixture = path.join(root, "packages/daemon/fixtures/runtime/dispatch-replay-ended.jsonl");
  if (!existsSync(fixture)) throw new Error(`runtime replay fixture does not exist: ${fixture}`);
  const source = readFileSync(fixture, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .slice(1)
    .map((line) => JSON.parse(line));
  const usable = source.filter((record) => record.kind === "provider_event" || record.kind === "process_exit");
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-perf-runtime-replay-"));
  const dispatchId = "dispatch_96e06fd9ca6917fc922e6d58";
  try {
    const target = path.join(rootDir, ".harness/runtime/dispatches", `${dispatchId}.jsonl`);
    mkdirSync(path.dirname(target), { recursive: true });
    const records = Array.from({ length: count }, (_, index) => usable[index % usable.length]);
    writeFileSync(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const started = performance.now();
    let cursor;
    let replayed = 0;
    let pages = 0;
    do {
      const page = await readObserveTail({
        repoId: "perf-runtime-replay",
        rootDir,
        mode: "local",
        projection: null,
        userRoot: path.join(rootDir, "user"),
        daemonId: "perf-fixture",
        payload: { kind: "dispatch", dispatchId, direction: "history", ...(cursor ? { cursor } : {}) },
      });
      if (page.status !== "ready") throw new Error(`runtime replay returned ${page.status}`);
      replayed += page.items.length;
      pages += 1;
      cursor = page.done ? null : page.historyCursor;
      if (!page.done && !cursor) throw new Error("runtime replay did not return a history cursor");
    } while (cursor);
    if (replayed !== count) throw new Error(`runtime replay returned ${replayed}/${count} records`);
    return {
      events: replayed,
      pages,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      path: "packages/daemon/src/observe-tail.ts:readObserveTail",
      fixture: "packages/daemon/fixtures/runtime/dispatch-replay-ended.jsonl",
      setupIncluded: false,
    };
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function commandExcerpt(run) {
  return {
    exitCode: run.status,
    stdout: run.stdout.trim().slice(0, 1200),
    stderr: run.stderr.trim().slice(0, 600),
  };
}

function parseProjectionReceipt(stdout) {
  try {
    const receipt = JSON.parse(stdout);
    const evidence = typeof receipt?.evidence === "string" ? JSON.parse(receipt.evidence) : null;
    return {
      status: evidence?.status ?? null,
      watermark: evidence?.watermark ?? null,
      sourceRevision: evidence?.sourceRevision ?? null,
      rows: Array.isArray(evidence?.rows) ? evidence.rows.length : null,
      receiptRevision: receipt?.revision ?? null,
    };
  } catch {
    return { status: null, watermark: null, sourceRevision: null, rows: null, receiptRevision: null };
  }
}

function projectionRebuildEvidence(root) {
  const relative =
    "harness/tasks/task_297d4d4d552d847690446eaddd-gui-2-1428-limit-limit/artifacts/real-ledger-before.json";
  const source = JSON.parse(readFileSync(path.join(root, relative), "utf8"));
  return {
    gitSubprocesses: source.coldStart.rebuildGitProcesses,
    rebuildMs: Number(source.coldStart.rebuildMs.toFixed(3)),
    watermark: source.coldStart.watermark,
    measuredAt: source.measuredAt,
    source: relative,
    rawExcerpt: JSON.stringify({ coldStart: source.coldStart }),
  };
}

export async function measureBaseline(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const samples = options.samples ?? 20;
  const list = [];
  const show = [];
  let firstList = null;
  let firstShow = null;
  let projectionStatus = null;
  for (let index = 0; index < samples; index += 1) {
    const listRun = command(root, ["task", "list", "--json"]);
    if (listRun.status !== 0) throw new Error(`ha task list failed: ${listRun.error ?? listRun.stderr}`);
    list.push(listRun.elapsedMs);
    firstList ??= commandExcerpt(listRun);
    projectionStatus ??= parseProjectionReceipt(listRun.stdout);
    const showRun = command(root, ["task", "show", "task_eb30a10f3b0e782b3f7504d8d3", "--json"]);
    if (showRun.status !== 0) throw new Error(`ha task show failed: ${showRun.error ?? showRun.stderr}`);
    show.push(showRun.elapsedMs);
    firstShow ??= commandExcerpt(showRun);
  }
  const status = command(root, ["daemon", "status", "--json"]);
  if (status.status !== 0) throw new Error(`ha daemon status failed: ${status.error ?? status.stderr}`);
  const statusJson = parseDaemonStatus(status.stdout, root);
  const attachRecords = latestCanonicalAttachRecords(options.log ?? DEFAULT_LOG);
  const attachDurations = attachRecords.map((record) => record.durationMs);
  const projectionRebuild = projectionRebuildEvidence(root);
  return {
    schema: "perf-baseline/v1",
    measuredAt: new Date().toISOString(),
    root,
    host: { node: process.version, platform: process.platform, arch: process.arch },
    daemon: {
      status: projectionStatus.status,
      watermark: projectionStatus.watermark,
      sourceRevision: projectionStatus.sourceRevision,
      taskRows: projectionStatus.rows,
      repoState: statusJson.canonical?.state ?? null,
      coldStartAttachMs: attachDurations,
      coldStartAttachMedianMs: percentile(attachDurations, 50) ?? null,
      coldStartLogRecords: attachRecords,
      statusReceipt: statusJson,
    },
    projectionRebuild,
    guiFirstScreen: { rpcMethods: FIRST_SCREEN_READS, rpcCount: FIRST_SCREEN_READS.length },
    runtimeReplay1000: await replayRuntimeEvents(root, 1000),
    cli: { samples, taskList: stats(list), taskShow: stats(show), listSamplesMs: list, showSamplesMs: show },
    commands: [
      "ha daemon status --json --root <canonical>",
      "ha task list --json --root <canonical>",
      "ha task show task_eb30a10f3b0e782b3f7504d8d3 --json --root <canonical>",
      "node tools/perf/measure-baseline.mjs --root <canonical> --samples 20",
    ],
    raw: {
      daemonStatus: status.stdout.trim().slice(0, 1200),
      daemonStatusStderr: status.stderr.trim().slice(0, 600),
      firstTaskListReceipt: firstList,
      firstTaskShowReceipt: firstShow,
    },
  };
}

function markdown(report) {
  const lines = [
    "# 性能基线采样",
    "",
    `测量时间：${report.measuredAt}；仓：\`${report.root}\`；Node：\`${report.host.node}\`。`,
    "",
    "本脚本只做采样，不把墙钟数接入 CI gate。daemon 冷启动取日志中最近三次 canonical `repo_attach_completed` 的 `durationMs`；投影 Git 数沿用同口径隔离测量；首屏 RPC 是 App 初始 query 集合的静态审计；回放计时解析固定 JSONL 事件至 1000 条；CLI p95 是独立 `ha` 子进程 20 次样本。",
    "",
    "| 指标 | 结果 |",
    "|---|---:|",
    `| daemon canonical attach（3 轮） | ${report.daemon.coldStartAttachMs.join(", ")} ms；中位数 ${report.daemon.coldStartAttachMedianMs} ms |`,
    `| projection rebuild Git 子进程 | ${report.projectionRebuild.gitSubprocesses} |`,
    `| GUI 首屏 read RPC | ${report.guiFirstScreen.rpcCount}（${report.guiFirstScreen.rpcMethods.join(", ")}） |`,
    `| runtime 事件回放（1000） | ${report.runtimeReplay1000.elapsedMs} ms（${report.runtimeReplay1000.pages} 页） |`,
    `| ha task list p95（${report.cli.samples}） | ${report.cli.taskList.p95Ms} ms |`,
    `| ha task show p95（${report.cli.samples}） | ${report.cli.taskShow.p95Ms} ms |`,
    "",
    "原始样本完整保存在同名 JSON；daemon status receipt 与日志摘录随 JSON 保存。运行期间未停止或重启 canonical daemon。",
  ];
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = await measureBaseline(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.jsonOut) {
    mkdirSync(path.dirname(path.resolve(options.jsonOut)), { recursive: true });
    writeFileSync(path.resolve(options.jsonOut), json);
  }
  if (options.markdownOut) {
    mkdirSync(path.dirname(path.resolve(options.markdownOut)), { recursive: true });
    writeFileSync(path.resolve(options.markdownOut), markdown(report));
  }
  console.log(json);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
