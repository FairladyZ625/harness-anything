import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const root = process.cwd();
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const FILE_COMPLEXITY_POLICY = {
  source: { standard: 1000, stage: 1100 },
  test: { standard: 1200, stage: 1900 },
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

function policyFor(filePath) {
  const rel = relative(filePath);
  if (/\/test\//u.test(rel) || /\.test\./u.test(rel)) return FILE_COMPLEXITY_POLICY.test;
  return FILE_COMPLEXITY_POLICY.source;
}

const base = (await git(["merge-base", "origin/main", "HEAD"])).trim();
const baseFiles = new Set((await git(["ls-tree", "-r", "--name-only", "-z", base])).split("\0").filter(Boolean));
const renameSources = new Map();
const renameRecords = (await git(["diff", "-M", "--name-status", "--diff-filter=R", "-z", base, "HEAD"]))
  .split("\0")
  .filter(Boolean);
for (let i = 0; i < renameRecords.length; i += 3) {
  renameSources.set(renameRecords[i + 2], renameRecords[i + 1]);
}
// Tracked plus untracked-but-not-ignored files: gitignored build output never counts.
const files = (await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "packages", "tools"]))
  .split("\0")
  .filter((file) => sourceFile.test(file) && !file.endsWith(".d.ts"))
  .map((file) => path.join(root, file))
  .filter((filePath) => existsSync(filePath));

for (const filePath of files) {
  const body = readFileSync(filePath, "utf8");
  const lines = countLines(body);
  const { standard, stage } = policyFor(filePath);
  if (lines <= standard) continue;
  const rel = relative(filePath);
  // A renamed path inherits its merge-base existence so moves keep the stage ceiling.
  const historyPath = renameSources.get(rel) ?? rel;
  // New files must already meet the standard; files present at the merge base may
  // grow up to the stage ceiling. No shrink-only ratchet.
  const limit = baseFiles.has(historyPath) ? stage : standard;
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
