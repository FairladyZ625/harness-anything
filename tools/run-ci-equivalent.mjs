#!/usr/bin/env node
// 本地跑一遍 CI 在 pull_request 上跑的全部 job。
//
// 存在的理由:本仓的门集不是四道、也不是五道 —— 它是 gate-manifest.json 里
// executionSurfaces.rewriteCi.pullRequestJobs 声明的 9 个 workflow job(光 boundaries
// 一个就 35 道门),而 `check:local` 只是 fast tier 的一个子集,不等于任何一个 CI job。
// 靠人(或 agent)记住一张会增长的清单,已经连续失败了五次 —— 每次都是"本地全绿、CI 红",
// 每次的修法都是"下次记得再多跑一道",而清单还在长。
//
// 所以这里不枚举 job,而是【从 manifest 派生】。新增一个 job、给某个 job 挂一道新门,
// 这个命令自动跟上,不需要任何人记住任何事。
//
// 用法:
//   npm run check:ci                     跑全部可本地执行的 job
//   npm run check:ci -- --job boundaries  只跑指定 job(可重复)
//   npm run check:ci -- --json           额外吐一份机器可读回执(贴进 PR / worker 报告)
//
// 回执是产物,不是断言:每个 job 的真实 exit code 都在里面。CEO 会重跑并比对数字。

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "tools/gate-manifest.json"), "utf8"));

// pr-body-lint 需要一个真实 PR body,本地没有;integration-shard 需要分片参数,单独展开。
const INTEGRATION_SHARDS = 6;
const NOT_LOCALLY_RUNNABLE = new Set(["pr-body-lint"]);

// GitHub 上的活配置(分支保护规则)不是代码,读它需要凭据。缺凭据是环境问题不是代码问题,
// 所以显式提示而不是让它红在一个看不懂的地方。
const NEEDS_GITHUB = ["GITHUB_REPOSITORY", "GITHUB_TOKEN"];

function deriveJobs() {
  const jobs = new Map();
  for (const gate of manifest.gates ?? []) {
    for (const job of gate.executionSurfaces?.rewriteCi?.pullRequestJobs ?? []) {
      if (!jobs.has(job)) jobs.set(job, []);
      jobs.get(job).push(gate.id);
    }
  }
  return jobs;
}

// gui-build 内含 `vite build`,它写出 packages/gui/dist;之后任何 `tsc -b` 都会被
// TS6305「陈旧产物」毒化 —— 那是假红,会让人去查一个根本不存在的类型错误。
// CI 里每个 job 是干净 checkout,所以碰不到;本地必须每个 job 之前自己清一次。
function clearIncrementalArtifacts() {
  rmSync(path.join(root, "packages/gui/dist"), { recursive: true, force: true });
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".tsbuildinfo")) rmSync(full, { force: true });
    }
  }
}

function runJob(job, shard) {
  clearIncrementalArtifacts();
  const args = ["tools/run-manifest-gates.mjs", "--workflow-job", job, "--exclude", "mergify-queue-metadata-edit-noop"];
  if (shard !== undefined) args.push("--shard", String(shard));
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  return {
    job: shard === undefined ? job : `${job} (${shard})`,
    exitCode: result.status ?? 1,
    seconds: Math.round((Date.now() - started) / 1000)
  };
}

const argv = process.argv.slice(2);
const wanted = [];
// 回执写文件,不写 stdout —— 每个 gate 都是 stdio:inherit,stdout 早被它们的输出占满了,
// 把 JSON 混进去等于交出一份没法解析的回执(实测第一版就是这么废的)。
let receiptPath = null;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--job") { wanted.push(argv[index + 1]); index += 1; continue; }
  if (argv[index] === "--json") { receiptPath = argv[index + 1] ?? "check-ci-receipt.json"; index += 1; continue; }
  throw new Error(`unknown option: ${argv[index]}`);
}

const derived = deriveJobs();
const missingCredentials = NEEDS_GITHUB.filter((name) => !process.env[name]);
if (missingCredentials.length > 0) {
  console.error(
    `\n[check:ci] ${missingCredentials.join(" and ")} not set. The boundaries job reads GitHub's live\n` +
    `           branch rules (check-github-required-contexts) and will fail for environmental\n` +
    `           reasons, not code reasons. Set them first:\n\n` +
    `             export GITHUB_REPOSITORY=<owner>/<name>\n` +
    `             export GITHUB_TOKEN=$(gh auth token)\n`
  );
}

const selected = wanted.length > 0 ? wanted : [...derived.keys()];
const plan = [];
for (const job of selected) {
  if (!derived.has(job)) throw new Error(`no gate in the manifest declares workflow job "${job}"`);
  if (NOT_LOCALLY_RUNNABLE.has(job)) {
    console.error(`[check:ci] skipping ${job}: needs a real pull request, cannot run locally.`);
    continue;
  }
  if (job === "integration-shard") {
    for (let shard = 1; shard <= INTEGRATION_SHARDS; shard += 1) plan.push([job, shard]);
    continue;
  }
  plan.push([job, undefined]);
}

console.error(
  `\n[check:ci] ${plan.length} runs derived from tools/gate-manifest.json ` +
  `(${[...derived].map(([job, gates]) => `${job}:${gates.length}`).join(" ")})\n`
);

const receipts = [];
for (const [job, shard] of plan) {
  receipts.push(runJob(job, shard));
}

const failed = receipts.filter((receipt) => receipt.exitCode !== 0);
console.error("\n──── check:ci ────");
for (const receipt of receipts) {
  console.error(`  ${receipt.exitCode === 0 ? "✓" : "✗"} ${receipt.job.padEnd(24)} exit=${receipt.exitCode}  ${receipt.seconds}s`);
}
console.error(failed.length === 0 ? "  ALL GREEN\n" : `  RED: ${failed.map((receipt) => receipt.job).join(", ")}\n`);

if (receiptPath !== null) {
  writeFileSync(receiptPath, `${JSON.stringify({ schema: "check-ci-receipt/v1", receipts, ok: failed.length === 0 }, null, 2)}\n`);
  console.error(`  receipt → ${receiptPath}\n`);
}

process.exit(failed.length === 0 ? 0 : 1);
