import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { git, pathExistsAt, repoRoot } from "./git.mjs";
import * as modulePolicy from "./module-policy.mjs";
import { resolveDeltaBase } from "./production-delta.mjs";
import { loadReceipts, verifyReceipt } from "./receipt-verify.mjs";
import { writeCiGateResult } from "../ci-gate-result.mjs";

export function countLines(body) {
  if (body.length === 0) return 0;
  const lines = body.split(/\r?\n/u);
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

function emptyCounts() {
  return Object.fromEntries(modulePolicy.BUDGETED_MODULES.map((moduleName) => [moduleName, 0]));
}

function listCurrentFiles(rootDir) {
  return [
    ...new Set(
      git(rootDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean),
    ),
  ];
}

function listFilesAt(rootDir, revision) {
  return git(rootDir, ["ls-tree", "-r", "-z", "--name-only", revision]).split("\0").filter(Boolean);
}

export function measureProductionLines({ rootDir, revision = null }) {
  const counts = emptyCounts();
  const unclassified = [];
  const files = revision === null ? listCurrentFiles(rootDir) : listFilesAt(rootDir, revision);

  for (const filePath of files) {
    if (!modulePolicy.isProductionPath(filePath)) continue;
    const moduleName = modulePolicy.classifyModule(filePath);
    if (moduleName === null) {
      unclassified.push(filePath);
      continue;
    }
    if (!modulePolicy.isBudgetedProductionPath(filePath)) continue;
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

const RETIRED_HISTORICAL_MODULES = new Set(["decision-fact", "test-infra"]);

// These are the post-restoration measurements that produced the committed
// candidate ceilings. They are intentionally fixed inputs for this derivation:
// later production edits still have to fit under the resulting ceiling, while a
// future remeasurement can deliberately replace this table and tighten it.
export const MEASURED_MODULE_LINES = Object.freeze({
  kernel: 28825,
  "task-lifecycle": 1317,
  "write-contract": 571,
  "doc-sync": 4346,
  preset: 5489,
  cli: 5586,
  gui: 32684,
  daemon: 32090,
  fleet: 3203,
  "authority-write-path": 0,
  "identity-rbac": 616,
  "agent-runtime": 3719,
  decision: 768,
  fact: 1058,
});

export function headroomFor(measured) {
  if (measured < 500) return 400;
  if (measured < 2000) return 1000;
  if (measured < 10000) return 4000;
  return 7000;
}

export function mechanicalUpperBoundFor(moduleName) {
  const measured = MEASURED_MODULE_LINES[moduleName];
  if (measured === undefined) throw new Error(`unknown module: ${moduleName}`);
  return measured === 0 ? 0 : measured + headroomFor(measured);
}

export function parseBudgets(body, source = "line-budgets.json", historical = false) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (
    parsed?.version !== 1 ||
    parsed.ceilings === null ||
    typeof parsed.ceilings !== "object" ||
    Array.isArray(parsed.ceilings)
  ) {
    throw new Error(`${source} must contain { version: 1, ceilings: { ... } }`);
  }
  const unknown = Object.keys(parsed.ceilings).filter((name) => !modulePolicy.BUDGETED_MODULES.includes(name));
  const invalidUnknown = historical ? unknown.filter((name) => !RETIRED_HISTORICAL_MODULES.has(name)) : unknown;
  const missing = modulePolicy.BUDGETED_MODULES.filter((name) => !Object.hasOwn(parsed.ceilings, name));
  const invalidMissing = historical ? [] : missing;
  if (invalidUnknown.length > 0 || invalidMissing.length > 0) {
    throw new Error(
      `${source} module keys do not match module-policy (missing: ${invalidMissing.join(", ") || "none"}; unknown: ${invalidUnknown.join(", ") || "none"})`,
    );
  }
  for (const [moduleName, ceiling] of Object.entries(parsed.ceilings)) {
    if (!Number.isInteger(ceiling) || ceiling < 0)
      throw new Error(`${source} ceiling for ${moduleName} must be a non-negative integer`);
  }
  return Object.fromEntries(
    modulePolicy.BUDGETED_MODULES.map((moduleName) => [moduleName, parsed.ceilings[moduleName] ?? 0]),
  );
}

function readBaseBudgets(rootDir, base, relativeBudgetPath) {
  if (!pathExistsAt(rootDir, base, relativeBudgetPath)) return null;
  return parseBudgets(git(rootDir, ["show", `${base}:${relativeBudgetPath}`]), `${base}:${relativeBudgetPath}`, true);
}

function hasBudgetReceipt(receipts, moduleName, minimumLimit, now) {
  return receipts.some(
    ({ receipt }) =>
      verifyReceipt(receipt, {
        scope: `module:${moduleName}`,
        kind: "line-budget",
        minimumLimit,
        now,
      }).ok,
  );
}

export function evaluateLineBudget({
  rootDir,
  base,
  budgetPath = path.join(rootDir, "tools/gates/line-budgets.json"),
  receiptsDir = path.join(rootDir, "tools/gates/receipts"),
  now = new Date(),
}) {
  const relativeBudgetPath = path.relative(rootDir, budgetPath).replaceAll("\\", "/");
  const ceilings = parseBudgets(readFileSync(budgetPath, "utf8"), relativeBudgetPath);
  const deltaBase = resolveDeltaBase(rootDir, base);
  const baseCeilings = readBaseBudgets(rootDir, deltaBase, relativeBudgetPath);
  const current = measureProductionLines({ rootDir });
  const before = measureProductionLines({ rootDir, revision: deltaBase });
  const receipts = loadReceipts(receiptsDir);
  const errors = [];

  for (const filePath of [...before.unclassified, ...current.unclassified]) {
    errors.push(`production source is not classified by module-policy: ${filePath}`);
  }

  for (const moduleName of modulePolicy.BUDGETED_MODULES) {
    const actual = current.counts[moduleName];
    const ceiling = ceilings[moduleName];
    const mechanicalUpperBound = mechanicalUpperBoundFor(moduleName);
    if (ceiling > mechanicalUpperBound) {
      errors.push(
        `${moduleName}: ceiling ${ceiling} exceeds mechanical upper bound ${mechanicalUpperBound} derived from ${MEASURED_MODULE_LINES[moduleName]} measured lines`,
      );
    }
    if (actual > ceiling) {
      errors.push(
        `${moduleName}: actual ${actual} exceeds ceiling ${ceiling}; reduce production lines to ${ceiling} or add a verified line-budget decision receipt and update the ceiling`,
      );
    }
    if (
      baseCeilings !== null &&
      ceiling > baseCeilings[moduleName] &&
      !hasBudgetReceipt(receipts, moduleName, ceiling, now)
    ) {
      errors.push(
        `${moduleName}: ceiling rose from ${baseCeilings[moduleName]} to ${ceiling} without a valid receipt scoped to module:${moduleName} with limit >= ${ceiling}`,
      );
    }
  }

  return { ok: errors.length === 0, errors, actual: current.counts, ceilings, baseActual: before.counts };
}

function parseArgs(argv) {
  let base = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") base = argv[(index += 1)] ?? null;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (base === null) throw new Error("usage: node tools/gates/line-budget.mjs --base <sha>");
  return { base };
}

export function main(argv = process.argv.slice(2), rootDir = repoRoot()) {
  try {
    const { base } = parseArgs(argv);
    const result = evaluateLineBudget({ rootDir, base });
    const total = (values) => Object.values(values).reduce((sum, value) => sum + value, 0);
    writeCiGateResult("G32", true, {
      actualLines: total(result.actual),
      baseLines: total(result.baseActual),
      ceilingLines: total(result.ceilings),
      advisoryCount: result.errors.length,
    });
    for (const moduleName of modulePolicy.BUDGETED_MODULES) {
      console.log(`${moduleName}: ${result.actual[moduleName]}/${result.ceilings[moduleName]}`);
    }
    if (!result.ok) {
      console.log("G32 line-budget-ratchet: advisory");
      for (const error of result.errors) console.error(`G32 line-budget-ratchet: advisory: ${error}`);
      return 0;
    }
    console.log("G32 line-budget-ratchet: pass");
    return 0;
  } catch (error) {
    writeCiGateResult("G32", false, {});
    console.error(`G32 line-budget-ratchet: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
