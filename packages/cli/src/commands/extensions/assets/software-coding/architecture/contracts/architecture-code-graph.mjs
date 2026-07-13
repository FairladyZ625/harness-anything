import { createHash } from "node:crypto";
import { isArchitectureStableId, isPortablePhysicalPath } from "./architecture-manifest.mjs";
import { compareArchitectureText, findPortableCollisions, portablePathKey } from "./architecture-portable-path.mjs";
import { isArchitectureDigest, isArchitectureRecord, validArchitectureProvenance } from "./architecture-report-contracts.mjs";

const graphKeys = ["schema", "extractor", "tool", "files", "packages", "dependencies", "stats"];
const extractorKeys = ["id", "adapter", "sourceScopeIds", "inputDigest", "toolRef"];
const fileKeys = ["path", "sourceScopeId", "packageId"];
const packageKeys = ["id", "manifestPath"];
const dependencyKeys = ["sourcePath", "targetPath", "mechanism", "specifier"];
const statsKeys = ["sourceFiles", "packageCount", "dependencyEdges"];
const contractDigest = `sha256:${"0".repeat(64)}`;
const jsTsBoundary = deepFreeze({
  adapter: "javascript-typescript/imports-v1",
  tool: "dependency-cruiser",
  invocation: {
    mode: "argv",
    cwd: "repository-root",
    executable: "depcruise",
    outputType: "json",
    shell: false
  },
  result: {
    successSchema: "architecture-code-graph/v1",
    missingStatus: "tool-missing",
    invalidStatus: "invalid"
  }
});

export function javascriptTypeScriptExtractorBoundary() {
  return jsTsBoundary;
}

export function buildArchitectureCodeGraph(input) {
  return {
    ...input,
    files: [...input.files].sort((left, right) => compareArchitectureText(left.path, right.path)),
    packages: [...input.packages].sort((left, right) => compareArchitectureText(left.id, right.id)),
    dependencies: [...input.dependencies].sort(compareDependencies)
  };
}

export function architectureCodeGraphJson(value) {
  return `${JSON.stringify(buildArchitectureCodeGraph(value), null, 2)}\n`;
}

export function architectureCodeGraphDigest(value) {
  return `sha256:${createHash("sha256").update(architectureCodeGraphJson(value)).digest("hex")}`;
}

export function validateArchitectureCodeGraph(value) {
  if (!hasExactKeys(value, graphKeys)) return invalid("$", "Code graphs must use the closed architecture-code-graph/v1 shape.");
  const issues = [];
  if (value.schema !== "architecture-code-graph/v1") issues.push(issue("schema", "Code graph schema must be architecture-code-graph/v1."));
  if (!validExtractor(value.extractor)) issues.push(issue("extractor", "Code graphs require a closed extractor identity and input digest."));
  if (!validExtractorTool(value.tool, value.extractor)) issues.push(issue("tool", "Extractor tool provenance must match the graph extractor and fixed adapter tool."));
  if (!Array.isArray(value.files) || value.files.some((entry) => !validFile(entry))) issues.push(issue("files", "Files must use closed portable path records."));
  if (!Array.isArray(value.packages) || value.packages.some((entry) => !validPackage(entry))) issues.push(issue("packages", "Packages must use closed stable identities and portable manifest paths."));
  if (!Array.isArray(value.dependencies) || value.dependencies.some((entry) => !validDependency(entry))) issues.push(issue("dependencies", "Dependencies must use closed portable file-edge records."));
  if (!validStats(value.stats)) issues.push(issue("stats", "Code graph stats must be non-negative integers."));
  if (issues.length > 0) return { ok: false, issues };

  validateReferences(value, issues);
  validateIdentityAndOrder(value, issues);
  validateStats(value, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

function validateReferences(value, issues) {
  const scopeIds = new Set(value.extractor.sourceScopeIds);
  const packageIds = new Set(value.packages.map((entry) => entry.id));
  const filePaths = new Set(value.files.map((entry) => entry.path));
  for (const [index, file] of value.files.entries()) {
    if (!scopeIds.has(file.sourceScopeId)) issues.push(issue(`files[${index}].sourceScopeId`, "File source scope must be declared by the extractor."));
    if (file.packageId !== null && !packageIds.has(file.packageId)) issues.push(issue(`files[${index}].packageId`, "File package must resolve inside this graph."));
  }
  for (const [index, dependency] of value.dependencies.entries()) {
    if (!filePaths.has(dependency.sourcePath) || !filePaths.has(dependency.targetPath)) {
      issues.push(issue(`dependencies[${index}]`, "Dependency endpoints must resolve to graph files."));
    }
  }
}

function validateIdentityAndOrder(value, issues) {
  const filePaths = value.files.map((entry) => entry.path);
  const packageIds = value.packages.map((entry) => entry.id);
  const packageManifestKeys = value.packages.map((entry) => portablePathKey(entry.manifestPath));
  const dependencies = value.dependencies.map(dependencyIdentity);
  if (!sameValues(filePaths, sortedUnique(filePaths))) issues.push(issue("files", "Files must be sorted by unique portable path."));
  if (!sameValues(packageIds, sortedUnique(packageIds))) issues.push(issue("packages", "Packages must be sorted by unique stable ID."));
  if (new Set(packageManifestKeys).size !== packageManifestKeys.length) issues.push(issue("packages", "Package manifest paths must be unique on portable filesystems."));
  if (!sameValues(dependencies, sortedUnique(dependencies))) issues.push(issue("dependencies", "Dependencies must be sorted and unique."));
  const collisions = findPortableCollisions([
    ...filePaths,
    ...value.packages.map((entry) => entry.manifestPath),
    ...value.dependencies.flatMap((entry) => [entry.sourcePath, entry.targetPath])
  ]);
  if (collisions.length > 0) issues.push(issue("$", "Code graph paths must not collide on portable filesystems."));
}

function validateStats(value, issues) {
  if (value.stats.sourceFiles !== value.files.length ||
    value.stats.packageCount !== value.packages.length ||
    value.stats.dependencyEdges !== value.dependencies.length) {
    issues.push(issue("stats", "Code graph stats must equal the graph record counts."));
  }
}

function validExtractor(value) {
  return hasExactKeys(value, extractorKeys) &&
    isArchitectureStableId(value.id) &&
    typeof value.adapter === "string" && value.adapter.length > 0 &&
    sortedStableIds(value.sourceScopeIds) &&
    isArchitectureDigest(value.inputDigest) &&
    value.toolRef === `extractor:${value.id}`;
}

function validExtractorTool(tool, extractor) {
  return extractor !== undefined && tool?.role === "extractor" &&
    tool.declarationId === extractor.id &&
    tool.adapter === extractor.adapter &&
    (extractor.adapter !== jsTsBoundary.adapter || tool.tool === jsTsBoundary.tool) &&
    validArchitectureProvenance({
      commit: { sha: null, verification: "unverified" },
      sourceDigest: contractDigest,
      modelDigest: contractDigest,
      tools: [tool]
    });
}

function validFile(value) {
  return hasExactKeys(value, fileKeys) && isPortablePhysicalPath(value.path) &&
    isArchitectureStableId(value.sourceScopeId) &&
    (value.packageId === null || isArchitectureStableId(value.packageId));
}

function validPackage(value) {
  return hasExactKeys(value, packageKeys) && isArchitectureStableId(value.id) && isPortablePhysicalPath(value.manifestPath);
}

function validDependency(value) {
  return hasExactKeys(value, dependencyKeys) &&
    isPortablePhysicalPath(value.sourcePath) && isPortablePhysicalPath(value.targetPath) &&
    isArchitectureStableId(value.mechanism) && typeof value.specifier === "string" && value.specifier.length > 0;
}

function validStats(value) {
  return hasExactKeys(value, statsKeys) && statsKeys.every((key) => Number.isInteger(value[key]) && value[key] >= 0);
}

function sortedStableIds(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isArchitectureStableId) && sameValues(value, sortedUnique(value));
}

function compareDependencies(left, right) {
  return compareArchitectureText(dependencyIdentity(left), dependencyIdentity(right));
}

function dependencyIdentity(value) {
  return [value.sourcePath, value.targetPath, value.mechanism, value.specifier].join("\0");
}

function sortedUnique(value) {
  return [...new Set(value)].sort(compareArchitectureText);
}

function sameValues(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function hasExactKeys(value, keys) {
  if (!isArchitectureRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function issue(path, message) {
  return { code: "architecture_code_graph_invalid", path, message };
}

function invalid(path, message) {
  return { ok: false, issues: [issue(path, message)] };
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === "object" && !Object.isFrozen(nested)) deepFreeze(nested);
  }
  return value;
}
