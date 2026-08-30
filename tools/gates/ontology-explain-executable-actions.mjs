#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { exitCodeFor, loadCatalogSnapshot, parseCommonArgs } from "./ontology-gate-lib.mjs";

export function auditExplainExecutableActions(catalog) {
  const findings = [];
  for (const contract of catalog) {
    const available = new Set(contract.available ?? []);
    for (const action of contract.actions ?? []) {
      if (action.execution === null && available.has(action.id)) {
        findings.push({ kind: contract.kind, action: action.id });
      }
    }
  }
  return { findings };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, mode, fixture } = parseCommonArgs(argv, { allowFixture: true });
    const result = auditExplainExecutableActions(loadCatalogSnapshot(rootDir, fixture));
    console.log(`G0-4 ontology-explain-executable-actions: ${mode}`);
    console.log(`available but execution:null (${result.findings.length}):`);
    for (const finding of result.findings) console.log(`- ${finding.kind}/${finding.action}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(
      `G0-4 ontology-explain-executable-actions: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
