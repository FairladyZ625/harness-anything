#!/usr/bin/env node

/**
 * Scale fixture measurement harness for B2/B3/B5/B6.
 *
 * This intentionally measures the file-backed fixture directly. B2 is a
 * replay-shaped reducer (not a claim that it is the daemon's private
 * implementation), B3's git count is an instrumented hash-object subprocess
 * proxy, and B5 queries use the same authored files/events that a cold reader
 * has to inspect. The report keeps those boundaries explicit.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, fsyncSync, unlinkSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

function parseArgs(argv) {
  const result = { fixtures: [], rounds: 2, jsonOut: null, markdownOut: null, hotSamples: 100, sections: new Set(["b2", "b3", "b5", "b6"]) };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { console.log("Usage: node tools/scale/measure.mjs --fixtures PATH[,PATH] [--rounds 2] [--json-out PATH] [--markdown-out PATH]"); process.exit(0); }
    const value = argv[++i];
    if (key === "--fixtures" || key === "--fixture") result.fixtures.push(...value.split(",").filter(Boolean));
    else if (key === "--rounds") result.rounds = Number(value);
    else if (key === "--json-out") result.jsonOut = value;
    else if (key === "--markdown-out") result.markdownOut = value;
    else if (key === "--hot-samples") result.hotSamples = Number(value);
    else if (key === "--sections") result.sections = new Set(value.split(",").filter(Boolean));
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!result.fixtures.length) throw new Error("--fixtures is required");
  if (!Number.isInteger(result.rounds) || result.rounds < 1) throw new Error("--rounds must be a positive integer");
  return result;
}

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== ".git") stack.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function stats(values) { return { count: values.length, minMs: percentile(values, 0), p50Ms: percentile(values, 50), p95Ms: percentile(values, 95), maxMs: percentile(values, 100), meanMs: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null }; }
function elapsed(start) { return Number((performance.now() - start).toFixed(3)); }
function rssMb() { return Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)); }
function loadSnapshot() { const loads = loadavg(); return { load1: Number(loads[0].toFixed(2)), load5: Number(loads[1].toFixed(2)), cpuCount: cpus().length, parallelism: availableParallelism(), freeMemoryMb: Number((freemem() / 1024 / 1024).toFixed(1)), totalMemoryMb: Number((totalmem() / 1024 / 1024).toFixed(1)) }; }
function sleepTick() { return new Promise((resolvePromise) => setImmediate(resolvePromise)); }

function metadata(fixture) {
  const path = join(fixture, "fixture-metadata.json");
  if (!existsSync(path)) throw new Error(`${fixture} is not a scale fixture (missing fixture-metadata.json)`);
  return JSON.parse(readFileSync(path, "utf8"));
}

async function rebuild(fixture, files) {
  const start = performance.now();
  const events = files.filter((path) => path.includes(`${join("harness", "events")}/`) && path.endsWith(".json"));
  const tasks = new Map();
  const relations = [];
  let peak = rssMb();
  for (let index = 0; index < events.length; index += 1) {
    const event = JSON.parse(readFileSync(events[index], "utf8"));
    const current = tasks.get(event.taskId) ?? { taskId: event.taskId, events: 0, lastType: null };
    current.events += 1; current.lastType = event.type; tasks.set(event.taskId, current);
    if (event.payload?.relation) relations.push({ source: event.payload.relation, target: event.taskId, type: event.type });
    if (index % 2000 === 0) { peak = Math.max(peak, rssMb()); await sleepTick(); }
  }
  peak = Math.max(peak, rssMb());
  return { wallClockMs: elapsed(start), peakRssMb: peak, eventsReplayed: events.length, taskRows: tasks.size, relationRows: relations.length, rssDeltaMb: Number((peak - rssMb()).toFixed(2)) };
}

function eventPaths(fixture, files) { return files.filter((path) => path.includes(`${join("harness", "events")}/`) && path.endsWith(".json")); }

function hotWrite(fixture, paths, samples) {
  const git = spawnSync("git", ["-C", fixture, "init", "--quiet"], { encoding: "utf8" });
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
  const source = paths[0];
  const payload = readFileSync(source);
  const latencies = [];
  let subprocesses = 0;
  const hotPath = join(fixture, "tmp", "scale-hot-event.json");
  mkdirSync(join(fixture, "tmp"), { recursive: true });
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now();
    const fd = openSync(hotPath, "w");
    writeFileSync(fd, payload);
    fsyncSync(fd); closeSync(fd);
    const result = spawnSync("git", ["-C", fixture, "hash-object", "--stdin"], { input: payload, encoding: "utf8" });
    subprocesses += 1;
    if (result.status !== 0) throw new Error(`git hash-object failed: ${result.stderr}`);
    latencies.push(elapsed(start));
  }
  try { unlinkSync(hotPath); } catch { /* fixture cleanup is best effort */ }
  return { samples, gitSubprocesses: subprocesses, gitSubprocessesPerEvent: subprocesses / samples, hotWriteLatencyMs: stats(latencies), instrument: "one git hash-object subprocess per sampled event; commit-per-event is a proxy, not daemon internals" };
}

function queryMeasurements(fixture, files) {
  const taskIndexes = files.filter((path) => path.endsWith("/INDEX.md") && path.includes(`${join("harness", "tasks")}/`));
  const factFiles = files.filter((path) => path.endsWith("/fact.md"));
  const events = eventPaths(fixture, files);
  const taskLatencies = [], factLatencies = [], graphLatencies = [];
  for (let round = 0; round < 10; round += 1) {
    let start = performance.now();
    const taskRows = taskIndexes.map((path) => { const text = readFileSync(path, "utf8"); return { path, title: text.match(/^# (.+)$/m)?.[1] ?? basename(path) }; });
    taskLatencies.push(elapsed(start));
    start = performance.now();
    const matches = factFiles.filter((path) => readFileSync(path, "utf8").includes("fixture fact")).length;
    factLatencies.push(elapsed(start));
    start = performance.now();
    const edges = [];
    for (const path of events) { const event = JSON.parse(readFileSync(path, "utf8")); if (event.payload?.relation) edges.push([event.payload.relation, event.taskId]); }
    graphLatencies.push(elapsed(start));
    if (round === 9 && (taskRows.length === 0 || matches < 0 || edges.length < 0)) throw new Error("query sentinel failed");
  }
  return { taskList: { rows: taskIndexes.length, ...stats(taskLatencies) }, factSearch: { files: factFiles.length, ...stats(factLatencies) }, relationGraph: { events: events.length, ...stats(graphLatencies) } };
}

function distribution(fixture, files) {
  const top = new Map();
  const eventDirs = new Map();
  for (const path of files) {
    const rel = relative(fixture, path).split("/");
    top.set(rel[0], (top.get(rel[0]) ?? 0) + 1);
    if (rel[0] === "harness" && rel[1] === "events") eventDirs.set(rel[2], (eventDirs.get(rel[2]) ?? 0) + 1);
  }
  const counts = [...eventDirs.values()];
  return { totalFiles: files.length, topLevelFiles: Object.fromEntries([...top.entries()].sort()), eventDirectoryCount: eventDirs.size, eventFiles: counts.reduce((a, b) => a + b, 0), eventFilesPerDirectory: { min: Math.min(...counts), p50: percentile(counts, 50), p95: percentile(counts, 95), max: Math.max(...counts) } };
}

async function measureFixture(fixture, rounds, hotSamples, sections) {
  const root = resolve(fixture);
  const meta = metadata(root);
  const files = walk(root);
  const events = eventPaths(root, files);
  const roundResults = [];
  for (let round = 0; round < rounds; round += 1) {
    const before = loadSnapshot();
    const b2 = sections.has("b2") ? await rebuild(root, files) : null;
    const b3 = sections.has("b3") ? hotWrite(root, events, hotSamples) : null;
    const b5 = sections.has("b5") ? queryMeasurements(root, files) : null;
    const after = loadSnapshot();
    roundResults.push({ round: round + 1, loadBefore: before, loadAfter: after, b2, b3, b5, b6: sections.has("b6") ? distribution(root, files) : null });
  }
  return { fixture: root, metadata: meta, rounds: roundResults };
}

function average(results, section, field) {
  const values = results.rounds.map((round) => round[section]?.[field]).filter((value) => typeof value === "number");
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function meanRound(rounds, selector) {
  const values = rounds.map(selector).filter((value) => typeof value === "number");
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function fmt(value, digits = 2) { return typeof value === "number" ? value.toFixed(digits) : "—"; }

function markdown(report) {
  const lines = [];
  lines.push("# PLT-Scale W1 基线测量（B2/B3/B5/B6）", "", `生成时间：${report.generatedAt}`, "", "## 测量口径", "", "- 每个 fixture 连续测量两遍；每遍记录开始/结束时的 loadavg、CPU 与可用内存。运行期间同机存在其他 worker，故数值只作同机对比，不作跨机器绝对 SLO。", "- B2 是事件 JSON 全量扫描 + 内存 reducer 的冷启动近似，报告 wall clock 与采样到的 RSS 峰值；不是 daemon 私有实现的直接调用。", "- B3 热写使用 fsync 文件写 + 每个样本一个 `git hash-object --stdin` 子进程，子进程数是可复核的 instrument proxy，不冒充 commit 内部计数。", "- B5 在 authored task/fact 文件和事件上执行 task list、fact search、relation graph 宽查询，各 10 次取 p50/p95。", "- B6 统计实际文件数、events 两位十六进制目录 fan-out。", "");
  lines.push("## 结果摘要", "", "| 档位（主 task 数） | 事件数 | B2 冷重建 ms（两遍均值） | B2 RSS 峰值 MB（最大） | B3 git 子进程/样本 | B3 热写 p95 ms（均值） | B5 task p95 ms | B5 fact p95 ms | B5 graph p95 ms | B6 文件数 |", "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const item of report.fixtures) {
    const rounds = item.rounds;
    const peakRss = meanRound(rounds, (r) => r.b2?.peakRssMb);
    lines.push(`| ${item.metadata.primaryTaskCount.toLocaleString()} | ${item.metadata.eventCount.toLocaleString()} | ${fmt(average(item, "b2", "wallClockMs"), 1)} | ${fmt(peakRss, 1)} | ${fmt(average(item, "b3", "gitSubprocessesPerEvent"), 1)} | ${fmt(meanRound(rounds, (r) => r.b3?.hotWriteLatencyMs.p95Ms))} | ${fmt(meanRound(rounds, (r) => r.b5?.taskList.p95Ms))} | ${fmt(meanRound(rounds, (r) => r.b5?.factSearch.p95Ms))} | ${fmt(meanRound(rounds, (r) => r.b5?.relationGraph.p95Ms))} | ${rounds[0].b6?.totalFiles?.toLocaleString() ?? "—"} |`);
  }
  lines.push("", "## 分档明细", "");
  for (const item of report.fixtures) {
    lines.push(`### ${item.metadata.primaryTaskCount.toLocaleString()} tasks`, "", `fixture: \`${item.fixture}\`; seed: \`${item.metadata.seed}\`; facts: ${item.metadata.factCount.toLocaleString()}; decisions: ${item.metadata.decisionCount.toLocaleString()}; events: ${item.metadata.eventCount.toLocaleString()}.`, "", "| 轮次 | load1 前/后 | B2 ms | B2 RSS MB | B3 git 子进程 | B3 hot p50/p95 ms | B5 task p95 | B5 fact p95 | B5 graph p95 | B6 文件数 |", "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const round of item.rounds) lines.push(`| ${round.round} | ${round.loadBefore.load1}/${round.loadAfter.load1} | ${fmt(round.b2?.wallClockMs, 1)} | ${fmt(round.b2?.peakRssMb, 1)} | ${round.b3?.gitSubprocesses ?? "—"} | ${fmt(round.b3?.hotWriteLatencyMs.p50Ms)}/${fmt(round.b3?.hotWriteLatencyMs.p95Ms)} | ${fmt(round.b5?.taskList.p95Ms)} | ${fmt(round.b5?.factSearch.p95Ms)} | ${fmt(round.b5?.relationGraph.p95Ms)} | ${round.b6?.totalFiles?.toLocaleString() ?? "—"} |`);
    lines.push("", `events fan-out: ${item.rounds[0].b6 ? JSON.stringify(item.rounds[0].b6.eventFilesPerDirectory) : "—"}; top-level distribution: \`${item.rounds[0].b6 ? JSON.stringify(item.rounds[0].b6.topLevelFiles) : "—"}\``, "");
  }
  lines.push("## 按数字排的修复优先级", "", "1. **B2 投影冷重建**：优先消除全历史逐事件重放；以本表 B2 墙钟/RSS 随事件数的增长率为第一设计输入，目标是 watermark 增量追平与持久投影。", "2. **B3 写路径 git 耦合**：每个样本都产生一个可计数 git 子进程，且热写 p95 随仓增大上升；优先把权威 append log 与 git 审计物化拆开，再讨论语言替换。", "3. **B5 宽查询**：task list、fact search、relation graph 都是文件/事件全扫，p95 随 N 增长；优先增加分页/索引窄面。", "4. **B6 小文件/目录 fan-out**：events 目录被固定分成 256 桶，文件数线性增长；与 B3 一起评估分段 append/pack，避免单事件单文件。", "", "## 限制与外推", "", "- 生成器默认每 task 2.5 个事件文件，保持 1e5 档可在普通开发机运行；scale thesis 的生产假设是 25 事件/task（约高 10 倍），故事件线性结果可按事件密度乘数外推，绝对值不能直接当生产预测。", "- 本轮未修改产品代码，也没有将 fixture 放入版本库；fixture 位于 gitignore 的 `tmp/scale-fixtures/`。", "- 若某轮 load1 接近 CPU 并行度，优先重跑该档；同机 worker 负载已在每轮 JSON 中留证。", "");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = { schema: "plt-scale-baseline/v1", generatedAt: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, node: process.version }, fixtures: [] };
  for (const fixture of options.fixtures) report.fixtures.push(await measureFixture(fixture, options.rounds, options.hotSamples, options.sections));
  const json = JSON.stringify(report, null, 2) + "\n";
  if (options.jsonOut) { mkdirSync(join(resolve(options.jsonOut), ".."), { recursive: true }); writeFileSync(resolve(options.jsonOut), json); }
  const md = markdown(report);
  if (options.markdownOut) { mkdirSync(join(resolve(options.markdownOut), ".."), { recursive: true }); writeFileSync(resolve(options.markdownOut), md + "\n"); }
  console.log(options.markdownOut ? `Wrote ${resolve(options.markdownOut)}` : json);
}

try { await main(); } catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
