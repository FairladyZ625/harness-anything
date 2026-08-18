#!/usr/bin/env node
/**
 * Whole-tree byte-explainability classifier for the rename cutover: every path
 * that differs between the old and new generation heads must fall into one of
 * the expected buckets (event JSON, events/head.json, content-blob move,
 * decision.md, facts.md, INDEX.md). Any OTHER path is a non-zero exit and a
 * cutover abort. Rename detection is disabled so a moved content blob always
 * shows as one A and one D, never a compacted R-line.
 *
 * Usage: node scripts/rename-drill/classify-tree-diff.mjs --repo <git-repo> --old <sha> --new <sha>
 */
import { git } from "./ledger-walk.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.repo || !args.old || !args.new) { console.error("usage: classify-tree-diff.mjs --repo <repo> --old <sha> --new <sha>"); process.exit(2); }

const raw = await git(args.repo, ["diff", "--name-status", "--no-renames", "-z", args.old, args.new]);
const tokens = raw.split("\0").filter((token) => token.length > 0);
const counts = new Map();
const others = [];
for (let index = 0; index + 1 < tokens.length; index += 2) {
  const status = tokens[index], path = tokens[index + 1];
  let bucket;
  if (path === "events/head.json") bucket = "head.json";
  else if (/^events\/(?:[0-9a-f]{2}\/)?[^/]+\.json$/u.test(path)) bucket = `${status} event json`;
  else if (path.startsWith("objects/sha256/")) bucket = `${status} content blob`;
  else if (/^decisions\/decision-[^/]+\/decision\.md$/u.test(path)) bucket = `${status} decision.md`;
  else if (path.endsWith("/facts.md")) bucket = `${status} facts.md`;
  else if (path.endsWith("/INDEX.md")) bucket = `${status} INDEX.md`;
  else { bucket = "OTHER"; others.push(`${status} ${path}`); }
  counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
}
for (const [bucket, count] of [...counts.entries()].sort()) console.log(`${bucket.padEnd(20)} ${count}`);
if (others.length > 0) {
  console.error(`UNEXPLAINED PATHS (${others.length}):\n${others.slice(0, 40).join("\n")}`);
  process.exit(1);
}
console.log("every changed path classifies into an expected rename bucket");

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
