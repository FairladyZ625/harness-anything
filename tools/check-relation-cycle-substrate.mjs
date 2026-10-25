#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { listWorktreeFiles } from "./gates/git.mjs";

const root = process.cwd();
const canonicalPath = "packages/kernel/src/domain/relation-cycle.ts";
const canonicalFunction = "findRelationCycleWitnesses";
const sourceFilePattern = /\.(?:ts|tsx|mts|js|jsx|mjs)$/u;
const findings = [];

const canonicalText = readText(canonicalPath);
const canonicalDefinitions = countMatches(
  canonicalText,
  new RegExp(`\\bexport\\s+function\\s+${canonicalFunction}\\s*\\([^)]*\\)[^{]*\\{`, "gu"),
);
if (canonicalDefinitions !== 1) {
  findings.push(
    `${canonicalPath}: expected exactly one exported ${canonicalFunction} definition, found ${canonicalDefinitions}`,
  );
}

for (const rel of listWorktreeFiles(root, ["packages", "tools"]).filter((file) => sourceFilePattern.test(file))) {
  if (rel === canonicalPath || isTestOrFixturePath(rel)) continue;
  const text = readFileSync(path.join(root, rel), "utf8");
  if (!hasEntityRelationCycleResponsibility(text)) continue;
  if (!looksLikeCycleImplementation(text)) continue;
  if (text.includes(canonicalFunction)) continue;
  findings.push(
    `${rel}: entity relation cycle detection must delegate to ${canonicalPath}#${canonicalFunction}, not implement a second DFS substrate`,
  );
}

if (findings.length > 0) {
  console.error("Relation cycle substrate check failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(
    `Relation cycle substrate check passed (${canonicalPath}#${canonicalFunction} is the single entity-relation cycle substrate).`,
  );
}

function hasEntityRelationCycleResponsibility(text) {
  return /\b(?:RelationGraphEdgeRow|EntityRelationRecord|relationType|sourceRef|targetRef)\b/u.test(text);
}

function looksLikeCycleImplementation(text) {
  return (
    /\b(?:detect|find|assert)[A-Za-z0-9_]*Cycle[A-Za-z0-9_]*\s*\(/u.test(text) &&
    /\bvisiting\s*=\s*new\s+Set\b/u.test(text) &&
    /\bvisited\s*=\s*new\s+Set\b/u.test(text) &&
    /\b(?:stack|pathStack)\s*=\s*\[\]/u.test(text) &&
    /\bfunction\s+visit\s*\(/u.test(text)
  );
}

function readText(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

function isTestOrFixturePath(rel) {
  return /(?:^|\/)(?:__fixtures__|fixtures|test|tests)\//u.test(rel) || /\.test\.[cm]?[jt]s$/u.test(rel);
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}
