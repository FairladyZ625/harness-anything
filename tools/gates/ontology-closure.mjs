#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadGateAllowlist } from "../gate-allowlists/load-gate-allowlist.mjs";
import { git, pathExistsAt, pullRequestBase } from "./git.mjs";
import { exitCodeFor, loadOntologyClosureSnapshot, parseCommonArgs } from "./ontology-gate-lib.mjs";
import { auditOntologyClosure } from "./ontology-closure-audit.mjs";
import { scanOntologySources } from "./ontology-closure-scan.mjs";

export const baselineFile = "tools/gate-allowlists/ontology-closure.json";

export function evaluateOntologyClosure({ rootDir, base = null }) {
  const started = performance.now();
  const revision = base ?? process.env.PR_BASE_SHA ?? pullRequestBase(rootDir);
  // Resolve the base first. A bad/missing ref must never silently disable the ratchet.
  git(rootDir, ["rev-parse", "--verify", `${revision}^{commit}`]);
  const baseline = loadGateAllowlist("ontology-closure", {
    allowlistRoot: path.join(rootDir, "tools/gate-allowlists"),
    requiredSections: ["candidates"],
    report: false,
  }).candidates;
  const previous = pathExistsAt(rootDir, revision, baselineFile)
    ? JSON.parse(git(rootDir, ["show", `${revision}:${baselineFile}`])).entries.candidates
    : null;
  const scan = scanOntologySources(rootDir);
  const result = auditOntologyClosure({ ...scan, baseline, previous, snapshot: loadOntologyClosureSnapshot(rootDir) });
  return {
    schema: "ontology-closure-report/v1",
    base: revision,
    filesScanned: scan.filesScanned,
    durationMs: Math.round(performance.now() - started),
    ...result,
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const json = argv.includes("--json");
    const options = parseCommonArgs(
      argv.filter((arg) => arg !== "--json"),
      { allowBase: true },
    );
    const result = evaluateOntologyClosure(options);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `Ontology closure: ${result.filesScanned} files in ${result.durationMs}ms; candidates=${JSON.stringify(result.totals)}`,
      );
      console.log(
        `Baseline before=${JSON.stringify(result.before)} after=${JSON.stringify(result.after)} added=${result.addedIds.length} removed=${result.removedIds.length} disappeared=${result.disappearedIds.length}`,
      );
      for (const finding of result.findings)
        console.error(
          `${finding.code} ${finding.file ?? baselineFile}:${finding.line ?? ""} ${finding.id ?? ""}\n  ${finding.reason}\n  ${finding.prescription}`,
        );
    }
    return exitCodeFor(options.mode, result.findings.length);
  } catch (error) {
    console.error(`Ontology closure failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
