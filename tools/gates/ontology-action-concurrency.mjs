#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { exitCodeFor, loadCatalogSnapshot, parseCommonArgs } from "./ontology-gate-lib.mjs";

export const requiredConcurrencyFields = Object.freeze([
  "expectedVersion",
  "leasePolicy",
  "occurrenceClaim",
  "idempotency",
  "artifactOwnership",
]);

export function auditActionConcurrency(catalog) {
  const rows = [];
  for (const contract of catalog) {
    for (const action of contract.actions ?? []) {
      const missing = [];
      if (typeof action.concurrency !== "object" || action.concurrency === null || Array.isArray(action.concurrency)) {
        missing.push("concurrency");
      }
      for (const field of requiredConcurrencyFields) {
        if (!Object.hasOwn(action.concurrency ?? {}, field)) missing.push(`concurrency.${field}`);
      }
      rows.push({ kind: contract.kind, action: action.id, complete: missing.length === 0, missing });
    }
  }
  return { rows, findings: rows.filter((row) => !row.complete) };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, mode, fixture } = parseCommonArgs(argv, { allowFixture: true });
    const result = auditActionConcurrency(loadCatalogSnapshot(rootDir, fixture));
    console.log(`G0-6 ontology-action-concurrency: ${mode}`);
    console.log("action | concurrency | missing");
    for (const row of result.rows) {
      console.log(
        `${row.kind}/${row.action} | ${row.complete ? "complete" : "missing"} | ${row.missing.join(",") || "-"}`,
      );
    }
    console.log(`incomplete actions: ${result.findings.length}/${result.rows.length}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(`G0-6 ontology-action-concurrency: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
