#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./git.mjs";
import { loadReceipts, verifyReceipt } from "./receipt-verify.mjs";

const METRICS = Object.freeze(["projectionRebuildGitProcesses", "firstScreenReadRpcs"]);

function parseJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }
}

function validateMetricMap(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== [...METRICS].sort().join("\0"))
    throw new Error(`${label} keys must be ${METRICS.join(", ")}`);
  for (const metric of METRICS) {
    if (!Number.isSafeInteger(value[metric]) || value[metric] < 0)
      throw new Error(`${label}.${metric} must be a non-negative safe integer`);
  }
  return Object.fromEntries(METRICS.map((metric) => [metric, value[metric]]));
}

export function readCostFixture(filePath) {
  const fixture = parseJsonFile(filePath);
  if (fixture?.schema !== "cost-budget-fixture/v2") throw new Error(`${filePath} must use cost-budget-fixture/v2`);
  const events = fixture.projectionRebuild?.events;
  const repoId = fixture.projectionRebuild?.repoId;
  if (typeof repoId !== "string" || repoId.length === 0)
    throw new Error(`${filePath} must declare projectionRebuild.repoId`);
  if (!Array.isArray(events) || events.length === 0)
    throw new Error(`${filePath} must contain projectionRebuild.events`);
  for (const [index, event] of events.entries()) {
    if (!Number.isSafeInteger(event?.workspaceRevision) || event.workspaceRevision !== index + 1)
      throw new Error(`${filePath} event workspace revisions must be contiguous from 1`);
    if (event.schema !== "task-event/v1" || typeof event.opId !== "string" || typeof event.taskId !== "string")
      throw new Error(`${filePath} event ${event.workspaceRevision} must be a task-event/v1`);
  }
  const firstScreenReads = fixture.firstScreenReads;
  if (
    !Array.isArray(firstScreenReads) ||
    firstScreenReads.length === 0 ||
    firstScreenReads.some((method) => typeof method !== "string" || method.length === 0)
  )
    throw new Error(`${filePath} must contain non-empty firstScreenReads`);
  return { repoId, events, firstScreenReads };
}

function git(rootDir, ...args) {
  execFileSync("git", args, { cwd: rootDir, stdio: "ignore" });
}

async function measureProjectionRebuild(fixture) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-g37-cost-"));
  let projection;
  try {
    git(rootDir, "init", "-q");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/.gitattributes"), "* -text\n");
    git(rootDir, "config", "user.name", "G37 Cost Fixture");
    git(rootDir, "config", "user.email", "g37@example.invalid");
    git(rootDir, "config", "gc.auto", "0");
    git(rootDir, "config", "maintenance.auto", "false");
    git(rootDir, "add", "harness/.gitattributes");
    git(rootDir, "commit", "--allow-empty", "-qm", "fixture base");
    const [{ makeTaskEventStore }, { makeTaskProjection }, { taskLifecycleWritePlan }, { localGitObjectRefStore }] =
      await Promise.all([
        import("../../packages/kernel/src/store/task-event-store.ts"),
        import("../../packages/kernel/src/projection/task-projection.ts"),
        import("../../packages/kernel/src/domain/task-lifecycle-publication.ts"),
        import("../../packages/kernel/src/store/local-version-control-system.ts"),
      ]);
    const writer = makeTaskEventStore({ repoId: fixture.repoId, rootDir });
    for (const event of fixture.events) writer.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    const reader = makeTaskEventStore({ repoId: fixture.repoId, rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: reader });
    const before = localGitObjectRefStore.processCount();
    const rebuilt = projection.rebuild();
    const processes = localGitObjectRefStore.processCount() - before;
    if (rebuilt.watermark !== fixture.events.at(-1).workspaceRevision)
      throw new Error(`fixture rebuild stopped at ${rebuilt.watermark}`);
    return processes;
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

export async function measureCosts(fixture) {
  return {
    projectionRebuildGitProcesses: await measureProjectionRebuild(fixture),
    firstScreenReadRpcs: fixture.firstScreenReads.length,
  };
}

function readBudgetFile(filePath) {
  const budget = parseJsonFile(filePath);
  if (budget?.schema !== "cost-budget/v1") throw new Error(`${filePath} must use cost-budget/v1`);
  if (typeof budget.fixture !== "string" || budget.fixture.length === 0)
    throw new Error(`${filePath}.fixture is required`);
  return {
    fixture: budget.fixture,
    baseline: validateMetricMap(budget.baseline, `${filePath}.baseline`),
    budgets: validateMetricMap(budget.budgets, `${filePath}.budgets`),
  };
}

function hasCostReceipt(receipts, metric, limit, now) {
  return receipts.some(
    ({ receipt }) =>
      verifyReceipt(receipt, {
        scope: `cost:${metric}`,
        kind: "cost-budget",
        minimumLimit: limit,
        now,
      }).ok,
  );
}

export async function evaluateCostBudget({
  rootDir,
  budgetPath = path.join(rootDir, "tools/gates/cost-budget.json"),
  fixturePath = null,
  receiptsDir = path.join(rootDir, "tools/gates/receipts"),
  now = new Date(),
} = {}) {
  const budget = readBudgetFile(budgetPath);
  const resolvedFixture = fixturePath ?? path.resolve(rootDir, budget.fixture);
  if (!existsSync(resolvedFixture)) throw new Error(`cost fixture does not exist: ${resolvedFixture}`);
  const actual = await measureCosts(readCostFixture(resolvedFixture));
  const receipts = loadReceipts(receiptsDir);
  const errors = [];
  for (const metric of METRICS) {
    if (
      budget.budgets[metric] > budget.baseline[metric] &&
      !hasCostReceipt(receipts, metric, budget.budgets[metric], now)
    )
      errors.push(
        `${metric}: budget rose from ${budget.baseline[metric]} to ${budget.budgets[metric]} without a valid cost-budget receipt`,
      );
    if (actual[metric] > budget.budgets[metric])
      errors.push(`${metric}: measured ${actual[metric]} exceeds budget ${budget.budgets[metric]}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    actual,
    baseline: budget.baseline,
    budgets: budget.budgets,
    fixture: resolvedFixture,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.rootDir = argv[++index];
    else if (arg === "--budget") options.budgetPath = argv[++index];
    else if (arg === "--fixture") options.fixturePath = argv[++index];
    else if (arg === "--receipts") options.receiptsDir = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), defaultRoot = repoRoot()) {
  try {
    const options = parseArgs(argv);
    const result = await evaluateCostBudget({ rootDir: options.rootDir ?? defaultRoot, ...options });
    for (const metric of METRICS) console.log(`${metric}: ${result.actual[metric]}/${result.budgets[metric]}`);
    if (!result.ok) {
      for (const error of result.errors) console.error(`G37 cost-budget: ${error}`);
      return 1;
    }
    console.log("G37 cost-budget: pass");
    return 0;
  } catch (error) {
    console.error(`G37 cost-budget: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
