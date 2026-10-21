import { readFileSync } from "node:fs";
import path from "node:path";
import { listWorktreeFiles } from "./gates/git.mjs";

const root = process.cwd();
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
// The single execution source for the file size ceiling. Source and test files share it;
// there is no historical or per-directory allowance.
const FILE_COMPLEXITY_POLICY = { maxLines: 2000 };
const violations = [];

function countLines(body) {
  return body.length === 0 ? 0 : body.split(/\r?\n/u).length;
}

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

// Tracked plus untracked-but-not-ignored files: gitignored build output never counts.
const files = listWorktreeFiles(root, ["packages", "tools"])
  .filter((file) => sourceFile.test(file) && !file.endsWith(".d.ts"))
  .map((file) => path.join(root, file));

for (const filePath of files) {
  const lines = countLines(readFileSync(filePath, "utf8"));
  if (lines <= FILE_COMPLEXITY_POLICY.maxLines) continue;
  violations.push(
    `${relative(filePath)}: ${lines} lines exceeds max ${FILE_COMPLEXITY_POLICY.maxLines}; split this file by responsibility instead of shaving lines`,
  );
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("File complexity check passed.");
