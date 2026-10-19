import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { git, repoRoot } from "./git.mjs";
import { classifyModule, isProductionPath } from "./module-policy.mjs";
import { writeCiGateResult } from "../ci-gate-result.mjs";

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

export function evaluateProductionDelta({ rootDir, base }) {
  const computed = computeProductionDelta({ rootDir, base });
  const errors = computed.unclassified.map(
    (filePath) => `production source is not classified by module-policy: ${filePath}`,
  );

  return { ok: errors.length === 0, errors, computed };
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
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") base = argv[(index += 1)] ?? null;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (base === null) throw new Error("usage: node tools/gates/production-delta.mjs --base <sha>");
  return { base };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { base } = parseArgs(argv);
    const result = evaluateProductionDelta({ rootDir: repoRoot(), base });
    const { churn, net } = reportComputedDelta(result.computed);
    writeCiGateResult("G33", result.ok ? "pass" : "fail", {
      addedLines: result.computed.added,
      deletedLines: result.computed.deleted,
      churn,
      net,
      unclassifiedPaths: result.computed.unclassified.length,
      changedFiles: result.computed.changed.length,
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
