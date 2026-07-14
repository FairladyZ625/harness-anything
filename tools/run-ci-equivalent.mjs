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
// 这个命令自动跟上,不需要任何人记住任何事。integration shard 的真实 fan-out 则直接
// 读取 rewrite-ci workflow；解析不到预期结构时失败，不猜默认值。
//
// 用法:
//   npm run check:ci                      跑全部可本地执行的 job
//   npm run check:ci -- --job boundaries  只跑指定 job(可重复)
//   npm run check:ci -- --json             额外吐一份机器可读回执(贴进 PR / worker 报告)
//
// 回执是产物,不是断言:每个 job 的真实 exit code 都在里面。CEO 会重跑并比对数字。

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getEnforcementConstant,
  resolveEnforcementConstant
} from "./enforcement-constants.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "tools/gate-manifest.json");
const INTEGRATION_SHARD_JOB = "integration-shard";

export const LOCAL_EQUIVALENCE_NOTICE = "本地绿 ≠ 完整 CI 等价：skipped jobs still require GitHub CI.";

// 这是本地执行能力声明，不是 CI job 清单。每项都必须带可展示、可入回执的原因；
// 后续审计门可直接消费这个结构，不必解析 console 文案。
export const LOCAL_JOB_LIMITATIONS = Object.freeze({
  "pr-body-lint": "needs a real pull request body and cannot run locally"
});

// GitHub 上的活配置(分支保护规则)不是代码,读它需要凭据。缺凭据是环境问题不是代码问题,
// 所以显式提示而不是让它红在一个看不懂的地方。
const NEEDS_GITHUB = ["GITHUB_REPOSITORY", "GITHUB_TOKEN"];

export function deriveJobs(manifest) {
  const jobs = new Map();
  for (const gate of manifest.gates ?? []) {
    for (const job of gate.executionSurfaces?.rewriteCi?.pullRequestJobs ?? []) {
      if (!jobs.has(job)) jobs.set(job, []);
      jobs.get(job).push(gate.id);
    }
  }
  return jobs;
}

export function parseIntegrationShardMatrix(manifest, workflowText) {
  return resolveEnforcementConstant(
    manifest,
    "ci-integration-shard-sequence",
    () => workflowText
  );
}

export function buildCiPlan(manifest, workflowText, wanted = []) {
  const derived = deriveJobs(manifest);
  const integrationShards = parseIntegrationShardMatrix(manifest, workflowText);
  if (!derived.has(INTEGRATION_SHARD_JOB)) {
    throw new Error(`no gate in the manifest declares workflow job "${INTEGRATION_SHARD_JOB}"`);
  }
  for (const job of Object.keys(LOCAL_JOB_LIMITATIONS)) {
    if (!derived.has(job)) throw new Error(`local job limitation references undeclared manifest job "${job}"`);
  }

  const selected = wanted.length > 0 ? wanted : [...derived.keys()];
  const plan = [];
  const skipped = [];
  for (const job of selected) {
    if (!derived.has(job)) throw new Error(`no gate in the manifest declares workflow job "${job}"`);
    const reason = LOCAL_JOB_LIMITATIONS[job];
    if (reason !== undefined) {
      skipped.push({ job, reason });
      continue;
    }
    if (job === INTEGRATION_SHARD_JOB) {
      for (const shard of integrationShards) plan.push([job, shard]);
      continue;
    }
    plan.push([job, undefined]);
  }
  return { derived, integrationShards, plan, skipped };
}

export function createReceipt(receipts, skipped) {
  const failed = receipts.filter((receipt) => receipt.exitCode !== 0);
  return {
    schema: "check-ci-receipt/v1",
    receipts,
    skipped,
    notice: skipped.length > 0 ? LOCAL_EQUIVALENCE_NOTICE : null,
    ok: failed.length === 0
  };
}

export function formatSummary(receipts, skipped) {
  const failed = receipts.filter((receipt) => receipt.exitCode !== 0);
  const lines = ["\n──── check:ci ────"];
  for (const receipt of receipts) {
    lines.push(`  ${receipt.exitCode === 0 ? "✓" : "✗"} ${receipt.job.padEnd(24)} exit=${receipt.exitCode}  ${receipt.seconds}s`);
  }
  for (const item of skipped) lines.push(`  ↷ SKIPPED ${item.job}: ${item.reason}`);
  if (failed.length === 0) {
    lines.push(skipped.length === 0 ? "  ALL GREEN" : `  ALL GREEN (locally runnable jobs only; ${skipped.length} skipped)`);
  } else {
    lines.push(`  RED: ${failed.map((receipt) => receipt.job).join(", ")}`);
  }
  if (skipped.length > 0) lines.push(`  NOTICE: ${LOCAL_EQUIVALENCE_NOTICE}`);
  return `${lines.join("\n")}\n`;
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

function parseArgs(argv) {
  const wanted = [];
  // 回执写文件,不写 stdout —— 每个 gate 都是 stdio:inherit,stdout 早被它们的输出占满了,
  // 把 JSON 混进去等于交出一份没法解析的回执(实测第一版就是这么废的)。
  let receiptPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--job") { wanted.push(argv[index + 1]); index += 1; continue; }
    if (argv[index] === "--json") { receiptPath = argv[index + 1] ?? "check-ci-receipt.json"; index += 1; continue; }
    throw new Error(`unknown option: ${argv[index]}`);
  }
  return { wanted, receiptPath };
}

function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const shardDeclaration = getEnforcementConstant(manifest, "ci-integration-shard-sequence");
  const workflowPath = path.join(root, shardDeclaration.authority.path);
  const workflowText = readFileSync(workflowPath, "utf8");
  const { wanted, receiptPath } = parseArgs(process.argv.slice(2));
  const { derived, plan, skipped } = buildCiPlan(manifest, workflowText, wanted);
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

  console.error(
    `\n[check:ci] ${plan.length} runs derived from tools/gate-manifest.json and ${path.relative(root, workflowPath)} ` +
    `(${[...derived].map(([job, gates]) => `${job}:${gates.length}`).join(" ")})\n`
  );
  const receipts = [];
  for (const [job, shard] of plan) receipts.push(runJob(job, shard));

  console.error(formatSummary(receipts, skipped));
  if (receiptPath !== null) {
    writeFileSync(receiptPath, `${JSON.stringify(createReceipt(receipts, skipped), null, 2)}\n`);
    console.error(`  receipt → ${receiptPath}\n`);
  }
  process.exit(receipts.some((receipt) => receipt.exitCode !== 0) ? 1 : 0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
