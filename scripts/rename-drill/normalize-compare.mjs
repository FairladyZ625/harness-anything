#!/usr/bin/env node
/**
 * Offline cross-generation verifier for the CH3 rename drill (never product
 * code): normalizes the OLD generation's cold-rebuild export through the
 * approved word map and requires deep equality with the NEW generation's
 * export. Any difference beyond the typed renames is a failure.
 *
 * Usage: node normalize-compare.mjs --old <old-export.json> --new <new-export.json>
 */
import { readFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((token, index, all) => token.startsWith("--") ? [token.slice(2), all[index + 1]] : []).filter((pair) => pair.length));
const oldExport = JSON.parse(readFileSync(args.old, "utf8"));
const newExport = JSON.parse(readFileSync(args.new, "utf8"));

const DECISION = { active: "in_effect", retired: "outcome_retired" };
const RELATION = { retired: "edge_retired" };
const FACT = { live: "standing", retired: "superseded_fact" };

const map = (table) => (value) => Object.hasOwn(table, value) ? table[value] : value;

function normalize(root) {
  const clone = structuredClone(root);
  for (const decision of clone.decisions) decision.state = map(DECISION)(decision.state);
  const visitRelationStates = (value) => {
    if (Array.isArray(value)) { for (const item of value) visitRelationStates(item); return; }
    if (value === null || typeof value !== "object") return;
    if (typeof value.state === "string" && typeof value.relation_id === "string") value.state = map(RELATION)(value.state);
    if (typeof value.state === "string" && typeof value.relationId === "string") value.state = map(RELATION)(value.state);
    for (const child of Object.values(value)) visitRelationStates(child);
  };
  visitRelationStates(clone.truth);
  for (const fact of clone.facts) {
    if (typeof fact.state === "string") fact.state = map(FACT)(fact.state);
    if (typeof fact.liveness === "string") fact.liveness = map(FACT)(fact.liveness);
  }
  return clone;
}

const diffs = [];
function compare(a, b, path) {
  if (diffs.length > 40) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { diffs.push(`${path}: array length ${a.length} != ${b.length}`); return; }
    for (const [index, item] of a.entries()) compare(item, b[index], `${path}[${index}]`);
    return;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a)) { diffs.push(`${path}.${key}: only in new`); continue; }
      if (!(key in b)) { diffs.push(`${path}.${key}: only in old`); continue; }
      compare(a[key], b[key], `${path}.${key}`);
    }
    return;
  }
  if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)?.slice(0, 120)} != ${JSON.stringify(b)?.slice(0, 120)}`);
}

compare(normalize(oldExport), newExport, "$");
if (diffs.length > 0) { console.error(`NOT EQUIVALENT (${diffs.length}${diffs.length > 40 ? "+" : ""} diffs):\n${diffs.join("\n")}`); process.exit(1); }
console.log("EQUIVALENT: old export normalized through the approved word map equals the new-generation export byte-for-byte (deep).");
