import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { git, repoRoot } from "./git.mjs";
import { productionDeltaFromNumstat } from "../../packages/kernel/src/domain/production-delta.ts";
import { writeCiGateResult } from "../ci-gate-result.mjs";

// The delta describes the branch, so it is measured from the merge-base with the target ref.
// Advancing main under an open pull request must not add unrelated target-branch changes.
export function resolveDeltaBase(rootDir, base, head) {
  return git(rootDir, ["merge-base", base, head ?? "HEAD"]).trim() || base;
}

export function computeProductionDelta({ rootDir, base, head }) {
  const deltaBase = resolveDeltaBase(rootDir, base, head),
    output = git(
      rootDir,
      head === undefined
        ? ["diff", "--no-renames", "--numstat", "-z", deltaBase, "--"]
        : ["diff", "--no-renames", "--numstat", "-z", deltaBase, head, "--"],
    );
  const records = [];
  for (const record of output.split("\0").filter(Boolean)) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error("git produced an invalid numstat record");
    records.push({
      addedText: record.slice(0, firstTab),
      deletedText: record.slice(firstTab + 1, secondTab),
      filePath: record.slice(secondTab + 1),
    });
  }

  return productionDeltaFromNumstat(records);
}

export function evaluateProductionDelta({ rootDir, base, head }) {
  const computed = computeProductionDelta({ rootDir, base, head });
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
  let head;
  let rootDir;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base" || argv[index] === "--head" || argv[index] === "--root") {
      const option = argv[index],
        value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a ref`);
      if (option === "--base") base = value;
      else if (option === "--head") head = value;
      else rootDir = value;
      index += 1;
    } else if (argv[index] === "--json") json = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (base === null)
    throw new Error("usage: node tools/gates/production-delta.mjs --base <sha> [--head <sha>] [--root <path>]");
  return { base, head, rootDir, json };
}

export function main(argv = process.argv.slice(2), rootDir = repoRoot()) {
  try {
    const { base, head, rootDir: selectedRoot, json } = parseArgs(argv);
    rootDir = selectedRoot ?? rootDir;
    const result = evaluateProductionDelta({ rootDir, base, head });
    const churn = result.computed.added + result.computed.deleted,
      net = result.computed.added - result.computed.deleted;
    if (!json) reportComputedDelta(result.computed);
    writeCiGateResult("G33", result.ok ? "pass" : "fail", {
      addedLines: result.computed.added,
      deletedLines: result.computed.deleted,
      churn,
      net,
      unclassifiedPaths: result.computed.unclassified.length,
      changedFiles: result.computed.changed.length,
    });
    if (json) {
      console.log(
        JSON.stringify({
          base: resolveDeltaBase(rootDir, base, head),
          head: head ?? null,
          ok: result.ok,
          added: result.computed.added,
          deleted: result.computed.deleted,
          churn,
          net,
          changed: result.computed.changed,
          unclassified: result.computed.unclassified,
          errors: result.errors,
        }),
      );
    }
    if (!result.ok) {
      if (!json) {
        for (const error of result.errors) console.error(`G33 production-delta: ${error}`);
      }
      return 1;
    }
    if (!json) console.log("G33 production-delta: pass");
    return 0;
  } catch (error) {
    writeCiGateResult("G33", "fail", {});
    console.error(`G33 production-delta: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
