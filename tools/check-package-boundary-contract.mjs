#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadPackageBoundaryContract,
  moduleSpecifiers,
  ownerForFile,
  packageEntries,
  packageForSpecifier,
  productionSourceFiles,
  resolveRelativePackage
} from "./package-boundary-contract.mjs";

export function checkPackageBoundaryContract(root) {
  const contract = loadPackageBoundaryContract(root);
  const findings = [];
  const realEdges = new Map(packageEntries(contract).map((pkg) => [pkg.id, new Set()]));

  for (const pkg of packageEntries(contract)) {
    const manifestPath = path.join(root, pkg.root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== pkg.name) findings.push(`${pkg.root}/package.json name must be ${pkg.name}`);
    if (!hasRootExport(manifest.exports)) findings.push(`${pkg.root}/package.json must export package root "."`);
    const registeredSubpaths = new Map((contract.deepSubpaths ?? [])
      .filter((entry) => entry.package === pkg.id)
      .map((entry) => [entry.subpath, entry.target]));
    for (const [subpath, target] of registeredSubpaths) {
      if (manifest.exports?.[subpath] !== target) {
        findings.push(`${pkg.root}/package.json must export registered subpath ${subpath} as ${target}`);
      }
    }
    for (const subpath of Object.keys(manifest.exports ?? {}).filter((key) => key !== ".")) {
      if (!registeredSubpaths.has(subpath)) findings.push(`${pkg.root}/package.json exports unregistered deep subpath ${subpath}`);
    }
  }

  for (const file of productionSourceFiles(root, contract)) {
    const source = ownerForFile(contract, file);
    const text = readFileSync(path.join(root, file), "utf8");
    for (const specifier of moduleSpecifiers(file, text)) {
      const target = specifier.startsWith(".")
        ? resolveRelativePackage(contract, file, specifier)
        : packageForSpecifier(contract, specifier);
      if (source && target && source.id !== target.id) realEdges.get(source.id).add(target.id);
    }
  }

  for (const pkg of packageEntries(contract)) {
    const manifest = JSON.parse(readFileSync(path.join(root, pkg.root, "package.json"), "utf8"));
    const declared = new Set(Object.keys(manifest.dependencies ?? {}).map((name) => packageForSpecifier(contract, name)?.id).filter(Boolean));
    for (const target of realEdges.get(pkg.id)) {
      if (!declared.has(target)) findings.push(`${pkg.id} must declare dependency ${contract.packages[target].name}`);
    }
    for (const target of declared) {
      if (!realEdges.get(pkg.id).has(target)) findings.push(`${pkg.id} declares unused internal dependency ${contract.packages[target].name}`);
    }
  }

  return { contract, findings, realEdges };
}

function hasRootExport(exportsField) {
  if (typeof exportsField === "string") return true;
  return exportsField !== null && typeof exportsField === "object" && Object.hasOwn(exportsField, ".");
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = checkPackageBoundaryContract(root);
  if (result.findings.length > 0) {
    for (const finding of result.findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  const edgeCount = [...result.realEdges.values()].reduce((count, edges) => count + edges.size, 0);
  console.log(`Package boundary contract check passed (${Object.keys(result.contract.packages).length} packages, ${edgeCount} declared real edges).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
