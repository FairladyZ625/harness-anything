import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const root = process.cwd();
const violations = [];
const requestedPackages = new Set(process.argv.slice(2));

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function workspaceMemberDirs() {
  const dirs = [];
  for (const pattern of readJson("package.json").workspaces ?? []) {
    if (!pattern.endsWith("/*")) {
      dirs.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true }))
      if (entry.isDirectory()) dirs.push(path.join(parent, entry.name));
  }
  return dirs;
}

function tarEntries(tarball) {
  const archive = gunzipSync(readFileSync(tarball));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    if (!name) break;
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const entryName = prefix ? `${prefix}/${name}` : name;
    entries.set(entryName.replace(/^package\//u, ""), archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function packPackage(packageDir) {
  const packDir = mkdtempSync(path.join(tmpdir(), "ha-tarball-exports-"));
  try {
    const output = execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: path.join(root, packageDir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const [{ filename } = {}] = JSON.parse(output);
    if (!filename) throw new Error("npm pack did not report a tarball filename");
    return tarEntries(path.join(packDir, filename));
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

function collectTargets(value, targets) {
  if (typeof value === "string") targets.push(value);
  else if (Array.isArray(value)) for (const entry of value) collectTargets(entry, targets);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) collectTargets(entry, targets);
}

function targetExists(files, target) {
  const normalized = target.startsWith("./") ? target.slice(2) : target;
  if (normalized.startsWith("../") || path.isAbsolute(normalized)) return false;
  if (!normalized.includes("*")) return files.has(normalized);
  const expression = new RegExp(`^${normalized.split("*").map(escapeRegExp).join(".+")}$`, "u");
  return [...files].some((file) => expression.test(file));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function checkTarget(packageName, files, label, target) {
  if (!targetExists(files, target))
    violations.push(`${packageName} ${label} target ${target} is not in the npm pack tarball`);
}

for (const packageDir of workspaceMemberDirs()) {
  let sourceManifest;
  try {
    sourceManifest = readJson(path.join(packageDir, "package.json"));
  } catch {
    continue;
  }
  if (sourceManifest.private === true) continue;
  if (requestedPackages.size > 0 && !requestedPackages.has(sourceManifest.name) && !requestedPackages.has(packageDir))
    continue;

  try {
    const entries = packPackage(packageDir);
    const packedManifest = JSON.parse(entries.get("package.json")?.toString("utf8") ?? "null");
    if (!packedManifest) throw new Error("tarball does not contain package.json");
    const packageName = packedManifest.name ?? packageDir;
    const targets = [];
    collectTargets(packedManifest.exports, targets);
    for (const target of targets) checkTarget(packageName, entries, "exports", target);
    const binTargets =
      typeof packedManifest.bin === "string" ? [packedManifest.bin] : Object.values(packedManifest.bin ?? {});
    for (const target of binTargets) checkTarget(packageName, entries, "bin", target);
  } catch (error) {
    violations.push(
      `${sourceManifest.name ?? packageDir} npm pack failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (violations.length > 0) {
  console.error("Package tarball exports check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Package tarball exports check passed.");
