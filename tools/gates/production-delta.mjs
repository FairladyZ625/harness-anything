import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { git, pathExistsAt, repoRoot } from "./git.mjs";
import { classifyModule, isProductionPath, normalizeRepoPath } from "./module-policy.mjs";
import { loadReceipts, verifyReceipt } from "./receipt-verify.mjs";
import { writeCiGateResult } from "../ci-gate-result.mjs";

const RETAINED_LINE = /^Retained-Path:[ \t]*(\S+)\s+until\s+(\d{4}-\d{2}-\d{2})\s+per\s+(dec_[0-9A-Za-z]+)\s*$/gmu;

// The delta describes the branch, so it is measured from the merge-base with the target ref.
// Advancing main under an open pull request must not add unrelated target-branch changes.
export function resolveDeltaBase(rootDir, base) {
  return git(rootDir, ["merge-base", base, "HEAD"]).trim() || base;
}

export function computeProductionDelta({ rootDir, base }) {
  const output = git(rootDir, ["diff", "--no-renames", "--numstat", "-z", resolveDeltaBase(rootDir, base), "--"]);
  const changed = [];
  const unclassified = [];
  let added = 0;
  let deleted = 0;

  for (const record of output.split("\0").filter(Boolean)) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error("git produced an invalid numstat record");
    const addedText = record.slice(0, firstTab);
    const deletedText = record.slice(firstTab + 1, secondTab);
    const filePath = record.slice(secondTab + 1);
    if (!isProductionPath(filePath)) continue;
    const moduleName = classifyModule(filePath);
    if (moduleName === null) {
      unclassified.push(filePath);
      continue;
    }
    if (addedText === "-" || deletedText === "-") throw new Error(`production source must be text: ${filePath}`);
    const fileAdded = Number.parseInt(addedText, 10);
    const fileDeleted = Number.parseInt(deletedText, 10);
    added += fileAdded;
    deleted += fileDeleted;
    changed.push({ filePath, module: moduleName, added: fileAdded, deleted: fileDeleted });
  }

  return { added, deleted, changed, unclassified };
}

export function parseRetainedPaths(prBody) {
  const declarations = [...prBody.matchAll(RETAINED_LINE)].map((match) => ({
    path: match[1],
    until: match[2],
    decisionId: match[3],
  }));
  const retainedLines = prBody.split(/\r?\n/u).filter((line) => line.startsWith("Retained-Path:"));
  const errors =
    retainedLines.length === declarations.length
      ? []
      : ["each Retained-Path line must use: Retained-Path: <path> until <YYYY-MM-DD> per <decision-id>"];
  return { declarations, errors };
}

function validateRetainedPath({ declaration, rootDir, base, receipts, now }) {
  const errors = [];
  const normalized = normalizeRepoPath(declaration.path);
  if (normalized === null || normalized !== declaration.path || !isProductionPath(normalized)) {
    errors.push(`Retained-Path must name a normalized production source path: ${declaration.path}`);
    return errors;
  }
  if (!pathExistsAt(rootDir, base, normalized) || !existsSync(path.join(rootDir, normalized))) {
    errors.push(`Retained-Path must exist at both base and HEAD: ${normalized}`);
  }

  const endOfExpiryDay = Date.parse(`${declaration.until}T23:59:59Z`);
  if (Number.isNaN(endOfExpiryDay) || endOfExpiryDay <= now.getTime())
    errors.push(`Retained-Path expiry must be in the future: ${declaration.until}`);

  const matchingReceipt = receipts.find(
    ({ receipt }) =>
      verifyReceipt(receipt, {
        scope: `retained-path:${normalized}`,
        kind: "retained-path",
        decisionId: declaration.decisionId,
        limit: declaration.until,
        now,
      }).ok && Date.parse(receipt.expiry) >= endOfExpiryDay,
  );
  if (matchingReceipt === undefined) {
    errors.push(
      `Retained-Path ${normalized} lacks a valid receipt for ${declaration.decisionId} through ${declaration.until}`,
    );
  }
  return errors;
}

export function evaluateProductionDelta({
  rootDir,
  base,
  prBody,
  receiptsDir = path.join(rootDir, "tools/gates/receipts"),
  now = new Date(),
}) {
  const computed = computeProductionDelta({ rootDir, base });
  const parsedRetained = parseRetainedPaths(prBody);
  const receipts = loadReceipts(receiptsDir);
  const errors = [...parsedRetained.errors];

  for (const filePath of computed.unclassified)
    errors.push(`production source is not classified by module-policy: ${filePath}`);
  for (const declaration of parsedRetained.declarations) {
    errors.push(...validateRetainedPath({ declaration, rootDir, base, receipts, now }));
  }

  return {
    ok: errors.length === 0,
    errors,
    computed,
    retainedPaths: parsedRetained.declarations,
  };
}

export function reportComputedDelta(computed) {
  const churn = computed.added + computed.deleted;
  const net = computed.added - computed.deleted;
  const report = `Production delta (computed): +${computed.added}/-${computed.deleted}; churn ${churn}; net ${net >= 0 ? "+" : ""}${net}; unclassified ${computed.unclassified.length}`;
  console.log(report);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, `${report}\n`, "utf8");
  return { churn, net };
}

function parseArgs(argv) {
  let base = null;
  let prBodyFile = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") base = argv[(index += 1)] ?? null;
    else if (argv[index] === "--pr-body-file") prBodyFile = argv[(index += 1)] ?? null;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (base === null)
    throw new Error("usage: node tools/gates/production-delta.mjs --base <sha> [--pr-body-file <path>]");
  return { base, prBodyFile };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { base, prBodyFile } = parseArgs(argv);
    const rootDir = repoRoot();
    const prBody = prBodyFile === null ? (process.env.PR_BODY ?? "") : readFileSync(prBodyFile, "utf8");
    const result = evaluateProductionDelta({ rootDir, base, prBody });
    const { churn, net } = reportComputedDelta(result.computed);
    writeCiGateResult("G33", result.ok ? "pass" : "fail", {
      addedLines: result.computed.added,
      deletedLines: result.computed.deleted,
      churn,
      net,
      unclassifiedPaths: result.computed.unclassified.length,
      changedFiles: result.computed.changed.length,
      retainedPaths: result.retainedPaths.length,
    });
    if (!result.ok) {
      for (const error of result.errors) console.error(`G33 production-delta: ${error}`);
      return 1;
    }
    console.log("G33 production-delta: pass");
    return 0;
  } catch (error) {
    writeCiGateResult("G33", "fail", {});
    console.error(`G33 production-delta: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
