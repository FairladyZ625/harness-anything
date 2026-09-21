import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const violations = [];

function record(message) {
  violations.push(message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function workspaceMemberDirs() {
  const rootPackage = readJson("package.json");
  const dirs = [];
  for (const pattern of rootPackage.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(parent, entry.name).split(path.sep).join("/"));
      }
    } else {
      dirs.push(pattern);
    }
  }
  return dirs;
}

// Every leaf string in an exports target tree must resolve to a file that npm
// actually packed. Conditional branches collapse to the same rule: each
// declared target either ships or the condition resolves to a missing file.
function collectExportsTargets(value, targets) {
  if (typeof value === "string") {
    targets.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectExportsTargets(entry, targets);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectExportsTargets(entry, targets);
  }
}

function packedFileSet(packageDir) {
  const result = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: path.join(root, packageDir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // npm ships as npm.cmd on Windows and Node refuses to execute .cmd
    // directly since CVE-2024-27980; no argument here contains a space.
    shell: process.platform === "win32",
  });
  const packs = JSON.parse(result);
  return new Set(packs.flatMap((pack) => pack.files.map((file) => file.path)));
}

function checkTarget(packageDir, packageName, files, label, target) {
  if (target.includes("*")) return; // Wildcard targets cannot be resolved statically.
  const normalized = target.startsWith("./") ? target.slice(2) : target;
  if (normalized.startsWith("../") || path.isAbsolute(normalized)) {
    record(`${packageName} ${label} target ${target} escapes the package root`);
    return;
  }
  if (!files.has(normalized)) {
    record(`${packageName} ${label} target ${target} is not in the npm pack tarball`);
  }
}

for (const packageDir of workspaceMemberDirs()) {
  const packageJsonPath = `${packageDir}/package.json`;
  let packageJson;
  try {
    packageJson = readJson(packageJsonPath);
  } catch {
    continue;
  }
  if (packageJson.private === true) continue;

  const packageName = packageJson.name ?? packageDir;
  let files;
  try {
    files = packedFileSet(packageDir);
  } catch (error) {
    record(`${packageName} npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  const exportTargets = [];
  collectExportsTargets(packageJson.exports, exportTargets);
  for (const target of exportTargets) checkTarget(packageDir, packageName, files, "exports", target);

  const bin = packageJson.bin;
  const binTargets = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
  for (const target of binTargets) checkTarget(packageDir, packageName, files, "bin", target);
}

if (violations.length > 0) {
  console.error("Package tarball exports check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Package tarball exports check passed.");
