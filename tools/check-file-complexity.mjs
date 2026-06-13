import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const sourceMaxLines = 600;
const testMaxLines = 700;
const toolMaxLines = 650;
const violations = [];

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "out", ".git", ".harness"].includes(entry.name)) continue;
      files.push(...await walk(fullPath));
      continue;
    }
    if (sourceFile.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(fullPath);
  }
  return files;
}

function defaultMaxLines(filePath) {
  const rel = relative(filePath);
  if (/\/test\//u.test(rel) || /\.test\./u.test(rel)) return testMaxLines;
  if (rel.startsWith("tools/")) return toolMaxLines;
  return sourceMaxLines;
}

const files = [
  ...await walk(path.join(root, "packages")),
  ...await walk(path.join(root, "tools"))
];

for (const filePath of files) {
  const body = readFileSync(filePath, "utf8");
  const lines = body.length === 0 ? 0 : body.split(/\r?\n/u).length;
  const limit = defaultMaxLines(filePath);
  if (lines > limit) {
    violations.push(`${relative(filePath)}: ${lines} lines exceeds max ${limit}; split this file by responsibility instead of shaving lines`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("File complexity check passed.");
