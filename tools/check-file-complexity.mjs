import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;

// dec_5E251C33D5BA9BA94734C95FE2: final limits apply to new files now;
// existing files converge through the current transition tier and a Git-derived
// per-file ceiling. Advancing a tier changes this one policy object, never an
// allowlist of repository paths.
export const FILE_COMPLEXITY_POLICY = Object.freeze({
  source: Object.freeze({ standard: 600, transition: 900 }),
  test: Object.freeze({ standard: 700, transition: 1400 }),
  tool: Object.freeze({ standard: 650, transition: 700 }),
});

function git(rootDir, args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function tryGit(rootDir, args) {
  try {
    return git(rootDir, args);
  } catch {
    return null;
  }
}

function relative(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
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
  if (/\/test\//u.test(filePath) || /\.test\./u.test(filePath)) return FILE_COMPLEXITY_POLICY.test;
  if (filePath.startsWith("tools/")) return FILE_COMPLEXITY_POLICY.tool;
  return FILE_COMPLEXITY_POLICY.source;
}

export function countLines(body) {
  if (body.length === 0) return 0;
  const lines = body.split(/\r?\n/u);
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

function baselineFiles(rootDir, base) {
  return new Set(
    git(rootDir, ["ls-tree", "-r", "-z", "--name-only", base, "--", "packages", "tools"]).split("\0").filter(Boolean),
  );
}

export function resolveBaselineRef(rootDir) {
  const head = tryGit(rootDir, ["rev-parse", "HEAD"])?.trim() ?? null;
  if (head === null) throw new Error("unable to resolve HEAD for the file-complexity baseline");

  const mergeBase = tryGit(rootDir, ["merge-base", "HEAD", "origin/main"])?.trim() ?? null;
  if (mergeBase !== null && mergeBase !== head) return mergeBase;

  const changes = tryGit(rootDir, ["status", "--porcelain", "--", "packages", "tools"]);
  if (changes) return head;

  const parent = tryGit(rootDir, ["rev-parse", "HEAD^"])?.trim() ?? null;
  if (parent !== null) return parent;
  throw new Error("unable to resolve a previous Git revision for the file-complexity baseline");
}

export async function evaluateFileComplexity({ rootDir, base }) {
  git(rootDir, ["rev-parse", "--verify", `${base}^{commit}`]);
  const beforeFiles = baselineFiles(rootDir, base);
  const files = [...(await walk(path.join(rootDir, "packages"))), ...(await walk(path.join(rootDir, "tools")))];
  const violations = [];

  for (const filePath of files) {
    const rel = relative(rootDir, filePath);
    const lines = countLines(readFileSync(filePath, "utf8"));
    const policy = policyFor(rel);
    if (lines <= policy.standard) continue;
    const before = beforeFiles.has(rel) ? countLines(git(rootDir, ["show", `${base}:${rel}`])) : null;
    const limit = before === null ? policy.standard : Math.max(policy.transition, before);
    if (lines <= limit) continue;
    const basis =
      before === null
        ? `new file standard ${policy.standard}`
        : `transition ${policy.transition}, merge-base ${before}`;
    violations.push(
      `${rel}: ${lines} lines exceeds max ${limit} (${basis}); ` +
        "split this file by responsibility instead of shaving lines",
    );
  }

  return { ok: violations.length === 0, violations };
}

export async function main(rootDir = process.cwd()) {
  try {
    const base = resolveBaselineRef(rootDir);
    const result = await evaluateFileComplexity({ rootDir, base });
    if (!result.ok) {
      console.error(result.violations.join("\n"));
      return 1;
    }
    console.log(`File complexity check passed (baseline ${base}).`);
    return 0;
  } catch (error) {
    console.error(`File complexity check failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
