import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const root = process.cwd();
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const FILE_COMPLEXITY_POLICY = {
  source: { standard: 600, stage: 1100 },
  test: { standard: 700, stage: 1900 },
  tool: { standard: 650, stage: 700 },
};
const violations = [];
const execute = promisify(execFile);

async function git(args) {
  const { stdout } = await execute("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function countLines(body) {
  return body.length === 0 ? 0 : body.split(/\r?\n/u).length;
}

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
      if (["node_modules", "dist", "out", "build-resources", ".git", ".harness"].includes(entry.name)) continue;
      files.push(...(await walk(fullPath)));
      continue;
    }
    if (sourceFile.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(fullPath);
  }
  return files;
}

function policyFor(filePath) {
  const rel = relative(filePath);
  if (/\/test\//u.test(rel) || /\.test\./u.test(rel)) return FILE_COMPLEXITY_POLICY.test;
  if (rel.startsWith("tools/")) return FILE_COMPLEXITY_POLICY.tool;
  return FILE_COMPLEXITY_POLICY.source;
}

const base = (await git(["merge-base", "origin/main", "HEAD"])).trim();
const baseFiles = new Set(
  (await git(["ls-tree", "-r", "--name-only", "-z", base, "--", "packages", "tools"])).split("\0").filter(Boolean),
);
const files = [...(await walk(path.join(root, "packages"))), ...(await walk(path.join(root, "tools")))];

for (const filePath of files) {
  const body = readFileSync(filePath, "utf8");
  const lines = countLines(body);
  const { standard, stage } = policyFor(filePath);
  if (lines <= standard) continue;
  const rel = relative(filePath);
  const baseLines = baseFiles.has(rel) ? countLines(await git(["show", `${base}:${rel}`])) : 0;
  // Existing debt may only shrink; the stage ceiling preserves the previous rejection surface.
  const limit = Math.min(stage, Math.max(standard, baseLines));
  if (lines > limit) {
    violations.push(
      `${relative(filePath)}: ${lines} lines exceeds max ${limit}; split this file by responsibility instead of shaving lines`,
    );
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("File complexity check passed.");
