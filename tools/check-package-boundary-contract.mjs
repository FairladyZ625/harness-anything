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
  resolveRelativePackage,
  sourcePathSpecifiers
} from "./package-boundary-contract.mjs";

export function checkPackageBoundaryContract(root) {
  const contract = loadPackageBoundaryContract(root);
  const findings = [];
  const realEdges = new Map(packageEntries(contract).map((pkg) => [pkg.id, new Set()]));
  const moduleEdges = new Map(packageEntries(contract).map((pkg) => [pkg.id, new Set()]));
  const violationCounts = new Map();
  const sourcePathViolationCounts = new Map();
  const deepSubpathConsumerCounts = new Map();

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
      if (source && target && source.id !== target.id) {
        realEdges.get(source.id).add(target.id);
        moduleEdges.get(source.id).add(target.id);
        if (!source.allowedDependencies.includes(target.id)) {
          const key = violationKey({ file, source: source.id, target: target.id });
          violationCounts.set(key, (violationCounts.get(key) ?? 0) + 1);
        }
      }
      const deepSubpath = target && !specifier.startsWith(".")
        ? registeredDeepSubpath(contract, target.id, specifier)
        : undefined;
      if (deepSubpath) {
        const key = deepSubpathKey(deepSubpath);
        deepSubpathConsumerCounts.set(key, (deepSubpathConsumerCounts.get(key) ?? 0) + 1);
      }
    }
    for (const specifier of sourcePathSpecifiers(file, text)) {
      const target = resolveRelativePackage(contract, file, specifier);
      if (!source || !target || source.id === target.id) continue;
      realEdges.get(source.id).add(target.id);
      if (!source.allowedDependencies.includes(target.id)) {
        const key = violationKey({ file, source: source.id, target: target.id });
        sourcePathViolationCounts.set(key, (sourcePathViolationCounts.get(key) ?? 0) + 1);
      }
    }
  }

  for (const entry of contract.deepSubpaths ?? []) {
    const key = deepSubpathKey(entry);
    const current = deepSubpathConsumerCounts.get(key) ?? 0;
    if (current > entry.maxProductionConsumers) findings.push(`deep subpath consumer count exceeds sunset ratchet: ${key} current=${current} baseline=${entry.maxProductionConsumers}`);
    if (current < entry.maxProductionConsumers) findings.push(`deep subpath sunset ratchet must decrease: ${key} current=${current} baseline=${entry.maxProductionConsumers}`);
  }

  for (const pkg of packageEntries(contract)) {
    const manifest = JSON.parse(readFileSync(path.join(root, pkg.root, "package.json"), "utf8"));
    const declared = new Set(Object.keys(manifest.dependencies ?? {}).map((name) => packageForSpecifier(contract, name)?.id).filter(Boolean));
    for (const target of moduleEdges.get(pkg.id)) {
      if (!declared.has(target)) findings.push(`${pkg.id} must declare dependency ${contract.packages[target].name}`);
    }
    for (const target of declared) {
      if (!moduleEdges.get(pkg.id).has(target)) findings.push(`${pkg.id} declares unused internal dependency ${contract.packages[target].name}`);
    }
  }

  const baseline = loadViolationBaseline(root, contract);
  const baselineCounts = new Map(baseline.violations.map((entry) => [violationKey(entry), entry.count]));
  for (const key of new Set([...baselineCounts.keys(), ...violationCounts.keys()])) {
    const expected = baselineCounts.get(key) ?? 0;
    const current = violationCounts.get(key) ?? 0;
    if (current > expected) findings.push(`package boundary violation exceeds baseline: ${displayViolation(key)} current=${current} baseline=${expected}`);
    if (current < expected) findings.push(`package boundary violation baseline must ratchet down: ${displayViolation(key)} current=${current} baseline=${expected}`);
  }

  const sourcePathBaselineCounts = new Map(baseline.sourcePathViolations.map((entry) => [violationKey(entry), entry.count]));
  for (const key of new Set([...sourcePathBaselineCounts.keys(), ...sourcePathViolationCounts.keys()])) {
    const expected = sourcePathBaselineCounts.get(key) ?? 0;
    const current = sourcePathViolationCounts.get(key) ?? 0;
    if (current > expected) findings.push(`source-path boundary violation exceeds baseline: ${displayViolation(key)} current=${current} baseline=${expected}`);
    if (current < expected) findings.push(`source-path boundary violation baseline must ratchet down: ${displayViolation(key)} current=${current} baseline=${expected}`);
  }

  return { contract, findings, realEdges, violationCounts, sourcePathViolationCounts, deepSubpathConsumerCounts };
}

function loadViolationBaseline(root, contract) {
  const relativePath = "tools/package-boundary-violations.json";
  const baseline = JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
  if (baseline.schema !== "harness-anything/package-boundary-violations/v2" || !Array.isArray(baseline.violations) || !Array.isArray(baseline.sourcePathViolations)) {
    throw new Error(`${relativePath} must use package-boundary-violations/v2 with violations and sourcePathViolations arrays`);
  }
  validateViolationSection("violations", baseline.violations, baseline.total, contract, relativePath);
  validateViolationSection("sourcePathViolations", baseline.sourcePathViolations, baseline.sourcePathTotal, contract, relativePath);
  return baseline;
}

function validateViolationSection(section, entries, declaredTotal, contract, relativePath) {
  const seen = new Set();
  let total = 0;
  for (const entry of entries) {
    const source = contract.packages[entry.source];
    const target = contract.packages[entry.target];
    if (!source || !target || typeof entry.file !== "string" || !Number.isInteger(entry.count) || entry.count <= 0) {
      throw new Error(`${relativePath} contains an invalid ${section} entry`);
    }
    if (source.allowedDependencies.includes(entry.target)) {
      throw new Error(`${relativePath} may only baseline forbidden package edges: ${entry.source} -> ${entry.target}`);
    }
    if (ownerForFile(contract, entry.file)?.id !== entry.source) {
      throw new Error(`${relativePath} file ${entry.file} is not owned by ${entry.source}`);
    }
    const key = violationKey(entry);
    if (seen.has(key)) throw new Error(`${relativePath} contains duplicate violation entry: ${displayViolation(key)}`);
    seen.add(key);
    total += entry.count;
  }
  if (declaredTotal !== total) throw new Error(`${relativePath} ${section} total must equal enumerated violation count ${total}`);
}

function registeredDeepSubpath(contract, packageId, specifier) {
  const pkg = contract.packages[packageId];
  const subpath = `.${specifier.slice(pkg.name.length)}`;
  return (contract.deepSubpaths ?? []).find((entry) => entry.package === packageId && entry.subpath === subpath);
}

function deepSubpathKey(entry) {
  return `${entry.package}:${entry.subpath}`;
}

function violationKey({ file, source, target }) {
  return JSON.stringify([file, source, target]);
}

function displayViolation(key) {
  const [file, source, target] = JSON.parse(key);
  return `${file} (${source} -> ${target})`;
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
