import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { publicWorkspacePackages } from "./public-workspaces.mjs";
import { ontologyFacetShardFiles } from "./refresh-ontology-facets.mjs";

export function tarEntries(tarball) {
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

function packPackage(root, packageDir) {
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
  return [...files.keys()].some((file) => expression.test(file));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function checkTarget(violations, packageName, files, label, target) {
  if (!targetExists(files, target))
    violations.push(`${packageName} ${label} target ${target} is not in the npm pack tarball`);
}

function normalizeBinTarget(target) {
  return String(target).replace(/^\.\//u, "");
}

function normalizeBinEntries(bin, packageName) {
  const map = new Map();
  if (typeof bin === "string") {
    const unscoped = String(packageName).includes("/") ? String(packageName).split("/").at(-1) : String(packageName);
    map.set(unscoped, normalizeBinTarget(bin));
  } else if (bin && typeof bin === "object") {
    for (const [alias, target] of Object.entries(bin)) {
      map.set(alias, normalizeBinTarget(target));
    }
  }
  return map;
}

export function verifyTarballEntries(entries, sourceManifest, packageDir, root = process.cwd()) {
  const violations = [];
  const packedManifest = JSON.parse(entries.get("package.json")?.toString("utf8") ?? "null");
  if (!packedManifest) {
    violations.push(`${sourceManifest.name ?? packageDir} tarball does not contain package.json`);
    return violations;
  }
  const packageName = packedManifest.name ?? sourceManifest.name ?? packageDir;
  const publishExports = sourceManifest.publishConfig?.exports;
  if (publishExports !== undefined && JSON.stringify(packedManifest.exports) !== JSON.stringify(publishExports))
    violations.push(`${packageName} packed exports differ from publishConfig.exports`);
  const targets = [];
  collectTargets(packedManifest.exports, targets);
  for (const target of targets) checkTarget(violations, packageName, entries, "exports", target);
  const sourceBins = normalizeBinEntries(sourceManifest.bin, packageName);
  const packedBins = normalizeBinEntries(packedManifest.bin, packageName);
  const checkedBinTargets = new Set();
  for (const [alias, expectedTarget] of sourceBins) {
    if (!packedBins.has(alias)) {
      violations.push(`${packageName} packed package.json is missing declared bin "${alias}" (${expectedTarget})`);
    } else if (packedBins.get(alias) !== expectedTarget) {
      violations.push(
        `${packageName} packed bin "${alias}" target ${packedBins.get(alias)} differs from source ${expectedTarget}`,
      );
    }
    if (!checkedBinTargets.has(expectedTarget)) {
      checkedBinTargets.add(expectedTarget);
      checkTarget(violations, packageName, entries, "bin", expectedTarget);
    }
  }
  for (const packedTarget of packedBins.values()) {
    if (!checkedBinTargets.has(packedTarget)) {
      checkedBinTargets.add(packedTarget);
      checkTarget(violations, packageName, entries, "bin", packedTarget);
    }
  }
  if (packageName === "@harness-anything/kernel") {
    const domain = path.join(root, packageDir, "src/domain");
    for (const file of ontologyFacetShardFiles(domain))
      checkTarget(violations, packageName, entries, "ontology facet", `./dist/domain/${file}`);
  }
  return violations;
}

export function verifyTarballArchive(tarballPath, sourceManifest, packageDir, root = process.cwd()) {
  return verifyTarballEntries(tarEntries(tarballPath), sourceManifest, packageDir, root);
}

function main() {
  const root = process.cwd();
  const violations = [];
  const requestedPackages = new Set(process.argv.slice(2));
  for (const { directory: packageDir, manifest: sourceManifest } of publicWorkspacePackages(root)) {
    if (requestedPackages.size > 0 && !requestedPackages.has(sourceManifest.name) && !requestedPackages.has(packageDir))
      continue;

    try {
      const entries = packPackage(root, packageDir);
      violations.push(...verifyTarballEntries(entries, sourceManifest, packageDir, root));
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
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
