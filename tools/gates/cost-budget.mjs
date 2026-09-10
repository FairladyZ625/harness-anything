#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./git.mjs";
import { loadReceipts, verifyReceipt } from "./receipt-verify.mjs";
import { removeTemporaryDirectory } from "../temporary-directory-cleanup.mjs";

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
  let projection, writer, reader;
  try {
    git(rootDir, "init", "-q");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/.gitattributes"), "* -text\n");
    git(rootDir, "config", "user.name", "G38 Cost Fixture");
    git(rootDir, "config", "user.email", "g37@example.invalid");
    git(rootDir, "config", "gc.auto", "0");
    git(rootDir, "config", "maintenance.auto", "false");
    git(rootDir, "add", "harness/.gitattributes");
    git(rootDir, "commit", "--allow-empty", "-qm", "fixture base");
    const [{ makeTaskEventStore }, { makeTaskProjection }, { taskLifecycleWritePlan }, { localGitObjectRefStore }] =
      await Promise.all([
        import("../../packages/kernel/src/store/task-event-store.ts"),
        import("../../packages/kernel/src/projection/rebuildable-task-projection.ts"),
        import("../../packages/kernel/src/domain/task-lifecycle-publication.ts"),
        import("../../packages/kernel/src/store/local-version-control-system.ts"),
      ]);
    writer = makeTaskEventStore({ repoId: fixture.repoId, rootDir });
    for (const event of fixture.events) writer.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    reader = makeTaskEventStore({ repoId: fixture.repoId, rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: reader });
    const before = localGitObjectRefStore.processCount();
    const rebuilt = projection.rebuild();
    const processes = localGitObjectRefStore.processCount() - before;
    if (rebuilt.watermark !== fixture.events.at(-1).workspaceRevision)
      throw new Error(`fixture rebuild stopped at ${rebuilt.watermark}`);
    return processes;
  } finally {
    projection?.close();
    await reader?.drain();
    await writer?.drain();
    await removeTemporaryDirectory(rootDir, { retryDelayMs: 20 });
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

// --- G1 write-path scale invariant -----------------------------------------------------------
// Extends the cost-budget gate (dec_EF5F3820E81FB8A5266F1F3342 CH1, refining dec_D507BBA7174F4BF61521CAEB61):
// every durable write kind and hot read runs through the production daemon request path on a
// 200-event and a 2000-event ledger, and its steady-state call (the one after a warm-up call) is
// judged; a 10x history growth must not cost meaningfully more per call.
export const G1_SCALES = Object.freeze({ small: 200, large: 2000 });

// Fixed, per-metric absolute margins (not per operation): the measured 200-scale and 2000-scale
// counts for an unexempted (operation, metric) pair must differ by no more than this. Values come
// from the noise observed on flat operations at head (task_78327209a449760a74d1992de3 report):
export const G1_MARGINS = Object.freeze({
  // Flat operations show 0 row difference between scales. The scarcest seeded kinds (decisions and
  // their relations) still grow by 36 rows between scales, so a scan of any one kind exceeds 20.
  sqlRowsRead: 20,
  // Every operation hashes a fixed number of times regardless of scale; 2 covers incidental
  // additions (e.g. one more content-addressed blob) without hiding a growing hash count.
  sha256Calls: 2,
  // Observed drift is only digits added to longer generated ids (single- to double-digit bytes);
  // 512 comfortably covers that without masking a hashed-content-scales-with-history regression.
  sha256Bytes: 512,
  // This is the exact metric #2407/#2409 fixed (Git follower re-rendering history per write); keep
  // it tight. 1 tolerates a single incidental extra spawn (e.g. a lazily-created ref) at most.
  gitProcesses: 1,
  // Observed drift is a few bytes from longer generated ids in read file content; 128 covers that
  // without masking a file read that starts scanning history.
  fileReadBytes: 128,
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function validateG1OperationMap(value, label, metrics) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const result = {};
  for (const [operation, metricMap] of Object.entries(value)) {
    if (metricMap === null || typeof metricMap !== "object" || Array.isArray(metricMap))
      throw new Error(`${label}.${operation} must be an object`);
    const keys = Object.keys(metricMap).sort();
    if (keys.join("\0") !== [...metrics].sort().join("\0"))
      throw new Error(`${label}.${operation} keys must be ${metrics.join(", ")}`);
    result[operation] = {};
    for (const metric of metrics) {
      if (!Number.isSafeInteger(metricMap[metric]) || metricMap[metric] < 0)
        throw new Error(`${label}.${operation}.${metric} must be a non-negative safe integer`);
      result[operation][metric] = metricMap[metric];
    }
  }
  return result;
}

function readG1BudgetFile(filePath, operations, metrics) {
  const budget = parseJsonFile(filePath);
  const section = budget?.writeCostScaling;
  if (section?.schema !== "write-cost-scaling-budget/v1")
    throw new Error(`${filePath}.writeCostScaling must use write-cost-scaling-budget/v1`);
  const scales = section.scales;
  if (!Number.isSafeInteger(scales?.small) || !Number.isSafeInteger(scales?.large) || scales.small >= scales.large)
    throw new Error(`${filePath}.writeCostScaling.scales must declare small < large`);
  const baseline = validateG1OperationMap(section.baseline, `${filePath}.writeCostScaling.baseline`, metrics),
    budgets = validateG1OperationMap(section.budgets, `${filePath}.writeCostScaling.budgets`, metrics);
  for (const operation of operations) {
    if (!baseline[operation])
      throw new Error(`${filePath}.writeCostScaling.baseline is missing operation ${operation}`);
    if (!budgets[operation]) throw new Error(`${filePath}.writeCostScaling.budgets is missing operation ${operation}`);
  }
  const knownScaling = Array.isArray(section.knownScaling) ? section.knownScaling : null;
  if (!knownScaling) throw new Error(`${filePath}.writeCostScaling.knownScaling must be an array`);
  for (const [index, entry] of knownScaling.entries()) {
    const label = `${filePath}.writeCostScaling.knownScaling[${index}]`;
    if (!operations.includes(entry?.operation)) throw new Error(`${label}.operation must be a known G1 operation`);
    if (!metrics.includes(entry?.metric)) throw new Error(`${label}.metric must be a known G1 metric`);
    if (!isNonEmptyString(entry?.reason)) throw new Error(`${label}.reason is required`);
    if (!isNonEmptyString(entry?.deletionTaskId)) throw new Error(`${label}.deletionTaskId is required`);
    if (!isNonEmptyString(entry?.expiresAt) || Number.isNaN(Date.parse(entry.expiresAt)))
      throw new Error(`${label}.expiresAt must be an RFC 3339 timestamp`);
  }
  return { scales, baseline, budgets, knownScaling };
}

function g1HasReceipt(receipts, operation, metric, limit, now) {
  return receipts.some(
    ({ receipt }) =>
      verifyReceipt(receipt, {
        scope: `cost:g1:${operation}:${metric}`,
        kind: "g1-cost-budget",
        minimumLimit: limit,
        now,
      }).ok,
  );
}

export async function measureG1WriteCostScaling(rootDir, scales) {
  const moduleUrl = pathToFileURL(path.join(rootDir, "packages/daemon/test/fixtures/g1-write-cost-scaling.ts")).href;
  const { measureWriteCostScaling, G1_OPERATIONS, G1_METRICS } = await import(moduleUrl);
  // One scale after the other: host-side reads are counted by process-wide probe counters, which a
  // concurrently seeding or measuring scale would add its own work to.
  const small = await measureWriteCostScaling(scales.small),
    large = await measureWriteCostScaling(scales.large);
  return { small, large, operations: G1_OPERATIONS, metrics: G1_METRICS };
}

export async function evaluateG1WriteCostScaling({
  rootDir,
  budgetPath = path.join(rootDir, "tools/gates/cost-budget.json"),
  receiptsDir = path.join(rootDir, "tools/gates/receipts"),
  now = new Date(),
  measured = null,
} = {}) {
  const probe = measured ?? (await measureG1WriteCostScaling(rootDir, G1_SCALES));
  const { operations, metrics } = probe;
  const budget = readG1BudgetFile(budgetPath, operations, metrics);
  const receipts = loadReceipts(receiptsDir);
  const errors = [];
  const actualSmall = {};
  for (const operation of operations) {
    actualSmall[operation] = probe.small.counts[operation];
    for (const metric of metrics) {
      const measuredSmall = probe.small.counts[operation]?.[metric],
        measuredLarge = probe.large.counts[operation]?.[metric];
      if (!Number.isSafeInteger(measuredSmall) || !Number.isSafeInteger(measuredLarge))
        throw new Error(`G1 measurement is missing ${operation}.${metric}`);

      // 200-scale absolute ratchet: reused from the existing G37 baseline/budget/receipt pattern.
      if (
        budget.budgets[operation][metric] > budget.baseline[operation][metric] &&
        !g1HasReceipt(receipts, operation, metric, budget.budgets[operation][metric], now)
      )
        errors.push(
          `${operation}.${metric}: budget rose from ${budget.baseline[operation][metric]} to ` +
            `${budget.budgets[operation][metric]} without a valid g1-cost-budget receipt`,
        );
      if (measuredSmall > budget.budgets[operation][metric])
        errors.push(
          `${operation}.${metric}: measured ${measuredSmall} at ${G1_SCALES.small} events exceeds budget ` +
            `${budget.budgets[operation][metric]}`,
        );

      // Scale-invariance: 2000-scale must not exceed 200-scale plus the fixed per-metric margin,
      // unless a live (non-expired) knownScaling exemption names this exact pair.
      const exemption = budget.knownScaling.find((entry) => entry.operation === operation && entry.metric === metric),
        withinMargin = measuredLarge <= measuredSmall + G1_MARGINS[metric];
      if (exemption) {
        if (Date.parse(exemption.expiresAt) <= now.getTime())
          errors.push(
            `${operation}.${metric}: knownScaling exemption expired at ${exemption.expiresAt} ` +
              `(deletion task ${exemption.deletionTaskId}); renew or fix and remove it`,
          );
        else if (withinMargin)
          errors.push(
            `${operation}.${metric}: knownScaling exemption is stale (measured ${measuredSmall}->${measuredLarge} ` +
              `is already within the margin); remove the exemption`,
          );
      } else if (!withinMargin)
        errors.push(
          `${operation}.${metric}: measured ${measuredSmall} at ${G1_SCALES.small} events grew to ` +
            `${measuredLarge} at ${G1_SCALES.large} events, ` +
            `exceeding the +${G1_MARGINS[metric]} margin with no knownScaling exemption`,
        );
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    actualSmall,
    actualLarge: probe.large.counts,
    baseline: budget.baseline,
    budgets: budget.budgets,
    knownScaling: budget.knownScaling,
    scales: G1_SCALES,
    operations,
    metrics,
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
    const rootDir = options.rootDir ?? defaultRoot;
    const result = await evaluateCostBudget({ rootDir, ...options });
    for (const metric of METRICS) console.log(`${metric}: ${result.actual[metric]}/${result.budgets[metric]}`);
    const g1 = await evaluateG1WriteCostScaling({
      rootDir,
      budgetPath: options.budgetPath,
      receiptsDir: options.receiptsDir,
    });
    for (const operation of g1.operations)
      for (const metric of g1.metrics)
        console.log(
          `G1 ${operation}.${metric}: ${g1.actualSmall[operation][metric]}/${g1.budgets[operation][metric]} ` +
            `at ${g1.scales.small}, ${g1.actualLarge[operation][metric]} at ${g1.scales.large}`,
        );
    const errors = [...result.errors, ...g1.errors];
    if (errors.length > 0) {
      for (const error of errors) console.error(`G38 cost-budget: ${error}`);
      return 1;
    }
    console.log("G38 cost-budget: pass");
    return 0;
  } catch (error) {
    console.error(`G38 cost-budget: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
