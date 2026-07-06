#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const canonicalPath = "packages/kernel/src/projection/relation-graph-projection.ts";
const canonicalFunction = "detectRelationGraphCycles";
const sourceFilePattern = /\.(?:ts|tsx|mts|js|jsx|mjs)$/u;
const findings = [];

const canonicalText = readText(canonicalPath);
const canonicalDefinitions = countMatches(canonicalText, new RegExp(`\\bexport\\s+function\\s+${canonicalFunction}\\s*\\(`, "gu"));
if (canonicalDefinitions !== 1) {
  findings.push(`${canonicalPath}: expected exactly one exported ${canonicalFunction} definition, found ${canonicalDefinitions}`);
}

for (const file of walkRoots(["packages", "tools"])) {
  const rel = relative(file);
  if (rel === canonicalPath || isTestOrFixturePath(rel)) continue;
  const text = readFileSync(file, "utf8");
  if (!hasEntityRelationCycleResponsibility(text)) continue;
  if (!looksLikeCycleImplementation(text)) continue;
  if (text.includes(canonicalFunction)) continue;
  findings.push(`${rel}: entity relation cycle detection must delegate to ${canonicalPath}#${canonicalFunction}, not implement a second DFS substrate`);
}

if (findings.length > 0) {
  console.error("Relation cycle substrate check failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Relation cycle substrate check passed (${canonicalPath}#${canonicalFunction} is the single entity-relation cycle substrate).`);
}

function hasEntityRelationCycleResponsibility(text) {
  return /\b(?:RelationGraphEdgeRow|EntityRelationRecord|readRelationGraphProjection|relationType|sourceRef|targetRef)\b/u.test(text);
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

function walkRoots(roots) {
  return roots.flatMap((name) => walk(path.join(root, name)));
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
      files.push(...walk(full));
    } else if (sourceFilePattern.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function readText(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isTestOrFixturePath(rel) {
  return /(?:^|\/)(?:__fixtures__|fixtures|test|tests)\//u.test(rel) || /\.test\.[cm]?[jt]s$/u.test(rel);
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}
