#!/usr/bin/env node
/**
 * Cold-rebuild export for the rename drill: runs the kernel cold-rebuild
 * source reader (the same reader the daemon projection rebuild uses) against a
 * workspace and dumps its complete/issues verdict plus the typed export that
 * the offline verifier normalizes across generations.
 *
 * Usage: node scripts/rename-drill/cold-export.mjs --workspace <ws> [--out <file>]
 */
import { writeFileSync } from "node:fs";
import { readColdRebuildSource } from "../../packages/kernel/src/projection/cold-rebuild-source.ts";

const args = parseArgs(process.argv.slice(2));
const workspace = args.workspace;
if (!workspace) { console.error("usage: cold-export.mjs --workspace <ws> [--out <file>]"); process.exit(2); }
const source = readColdRebuildSource(workspace);
const exportPayload = {
  verdict: { complete: source.complete, issues: source.issues.length },
  decisions: source.decisions,
  truth: source.truth,
  facts: source.facts,
  tasks: source.tasks,
  knownFactRefs: [...source.knownFactRefs].sort(),
};
if (args.issues) exportPayload.issueDetails = source.issues;
const body = JSON.stringify(exportPayload);
if (typeof args.out === "string") writeFileSync(args.out, body);
console.log(JSON.stringify({ complete: source.complete, issues: source.issues.length, decisions: source.decisions.length, edges: source.truth.edges.length, facts: source.facts.length, tasks: source.tasks.length, knownFactRefs: source.knownFactRefs.size, bytes: body.length }));
if (!source.complete || source.issues.length > 0) { console.error(JSON.stringify(source.issues.slice(0, 20), null, 2)); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (index + 1 < argv.length && !String(argv[index + 1]).startsWith("--")) { out[key] = argv[index + 1]; index += 1; }
    else out[key] = true;
  }
  return out;
}
