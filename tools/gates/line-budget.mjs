import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { git, pathExistsAt, repoRoot } from "./git.mjs";
import { classifyModule, isProductionPath, MODULES } from "./module-policy.mjs";
import { loadReceipts, verifyReceipt } from "./receipt-verify.mjs";

export function countLines(body) {
  if (body.length === 0) return 0;
  const lines = body.split(/\r?\n/u);
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

function emptyCounts() {
  return Object.fromEntries(MODULES.map((moduleName) => [moduleName, 0]));
}

function listCurrentFiles(rootDir) {
  return [...new Set(git(rootDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean))];
}

function listFilesAt(rootDir, revision) {
  return git(rootDir, ["ls-tree", "-r", "-z", "--name-only", revision])
    .split("\0")
    .filter(Boolean);
}

export function measureProductionLines({ rootDir, revision = null }) {
  const counts = emptyCounts();
  const unclassified = [];
  const files = revision === null ? listCurrentFiles(rootDir) : listFilesAt(rootDir, revision);

  for (const filePath of files) {
    if (!isProductionPath(filePath)) continue;
    const moduleName = classifyModule(filePath);
    if (moduleName === null) {
      unclassified.push(filePath);
      continue;
    }
    if (revision === null) {
      const absolutePath = path.join(rootDir, filePath);
      if (!existsSync(absolutePath)) continue;
      counts[moduleName] += countLines(readFileSync(absolutePath, "utf8"));
    } else {
      counts[moduleName] += countLines(git(rootDir, ["show", `${revision}:${filePath}`]));
    }
  }

  return { counts, unclassified };
}

const INITIAL_MODULE_CEILINGS = Object.freeze({
  "write-contract": 700,
  "agent-runtime": 1040,
  decision: 572,
  fact: 614,
  fleet: 700
});
const RETIRED_HISTORICAL_MODULES = new Set(["decision-fact"]);

export function parseBudgets(body, source = "line-budgets.json", historical = false) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (parsed?.version !== 1 || parsed.ceilings === null || typeof parsed.ceilings !== "object" || Array.isArray(parsed.ceilings)) {
    throw new Error(`${source} must contain { version: 1, ceilings: { ... } }`);
  }
  const unknown = Object.keys(parsed.ceilings).filter((name) => !MODULES.includes(name));
  const invalidUnknown = historical ? unknown.filter((name) => !RETIRED_HISTORICAL_MODULES.has(name)) : unknown;
  const missing = MODULES.filter((name) => !Object.hasOwn(parsed.ceilings, name));
  const invalidMissing = historical ? missing.filter((name) => !Object.hasOwn(INITIAL_MODULE_CEILINGS, name)) : missing;
  if (invalidUnknown.length > 0 || invalidMissing.length > 0) {
    throw new Error(`${source} module keys do not match module-policy (missing: ${invalidMissing.join(", ") || "none"}; unknown: ${invalidUnknown.join(", ") || "none"})`);
  }
  for (const [moduleName, ceiling] of Object.entries(parsed.ceilings)) {
    if (!Number.isInteger(ceiling) || ceiling < 0) throw new Error(`${source} ceiling for ${moduleName} must be a non-negative integer`);
  }
  const ceilings = Object.fromEntries(MODULES.map((moduleName) => [
    moduleName,
    parsed.ceilings[moduleName] ?? INITIAL_MODULE_CEILINGS[moduleName]
  ]));
  for (const [designModule, designLimit] of Object.entries(INITIAL_MODULE_CEILINGS)) {
    if (ceilings[designModule] > designLimit) throw new Error(`${source} ceiling for ${designModule} exceeds its design limit ${designLimit}`);
  }
  return ceilings;
}

function readBaseBudgets(rootDir, base, relativeBudgetPath) {
  if (!pathExistsAt(rootDir, base, relativeBudgetPath)) return null;
  return parseBudgets(git(rootDir, ["show", `${base}:${relativeBudgetPath}`]), `${base}:${relativeBudgetPath}`, true);
}

function hasBudgetReceipt(receipts, moduleName, minimumLimit, now) {
  return receipts.some(({ receipt }) => verifyReceipt(receipt, {
    scope: `module:${moduleName}`,
    kind: "line-budget",
    minimumLimit,
    now
  }).ok);
}

export function evaluateLineBudget({
  rootDir,
  base,
  budgetPath = path.join(rootDir, "tools/gates/line-budgets.json"),
  receiptsDir = path.join(rootDir, "tools/gates/receipts"),
  now = new Date()
}) {
  const relativeBudgetPath = path.relative(rootDir, budgetPath).replaceAll("\\", "/");
  const ceilings = parseBudgets(readFileSync(budgetPath, "utf8"), relativeBudgetPath);
  const baseCeilings = readBaseBudgets(rootDir, base, relativeBudgetPath);
  const current = measureProductionLines({ rootDir });
  const before = measureProductionLines({ rootDir, revision: base });
  const receipts = loadReceipts(receiptsDir);
  const errors = [];

  for (const filePath of [...before.unclassified, ...current.unclassified]) {
    errors.push(`production source is not classified by module-policy: ${filePath}`);
  }

  for (const moduleName of MODULES) {
    const actual = current.counts[moduleName];
    const ceiling = ceilings[moduleName];
    if (actual > ceiling) {
      errors.push(`${moduleName}: actual ${actual} exceeds ceiling ${ceiling}; reduce production lines to ${ceiling} or add a verified line-budget decision receipt and update the ceiling`);
    }
    if (baseCeilings !== null && ceiling > baseCeilings[moduleName] && !hasBudgetReceipt(receipts, moduleName, ceiling, now)) {
      errors.push(`${moduleName}: ceiling rose from ${baseCeilings[moduleName]} to ${ceiling} without a valid receipt scoped to module:${moduleName} with limit >= ${ceiling}`);
    }
  }

  return { ok: errors.length === 0, errors, actual: current.counts, ceilings, baseActual: before.counts };
}

function parseArgs(argv) {
  let base = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") base = argv[index += 1] ?? null;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (base === null) throw new Error("usage: node tools/gates/line-budget.mjs --base <sha>");
  return { base };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { base } = parseArgs(argv);
    const rootDir = repoRoot();
    const result = evaluateLineBudget({ rootDir, base });
    for (const moduleName of MODULES) {
      console.log(`${moduleName}: ${result.actual[moduleName]}/${result.ceilings[moduleName]}`);
    }
    if (!result.ok) {
      for (const error of result.errors) console.error(`G32 line-budget-ratchet: ${error}`);
      return 1;
    }
    console.log("G32 line-budget-ratchet: pass");
    return 0;
  } catch (error) {
    console.error(`G32 line-budget-ratchet: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
