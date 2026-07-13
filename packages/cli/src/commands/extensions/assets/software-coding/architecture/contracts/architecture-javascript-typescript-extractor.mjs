import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildArchitectureCodeGraph,
  validateArchitectureCodeGraph
} from "./architecture-code-graph.mjs";
import { compareArchitectureText } from "./architecture-portable-path.mjs";

const toolName = "dependency-cruiser";
const toolVersion = "17.4.3";
const defaultExclude = "(^|/)(node_modules|dist|test|tests|__tests__)(/|$)|\\.(test|spec)\\.[cm]?[jt]sx?$";
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const defaultTimeoutMs = 10_000;
const maxOutputBytes = 64 * 1024 * 1024;
const moduleFields = new Set([
  "checksum", "consolidated", "coreModule", "couldNotResolve", "dependencies", "dependencyTypes",
  "dependents", "experimentalStats", "followable", "instability", "license", "matchesDoNotFollow",
  "matchesFocus", "matchesHighlight", "matchesReaches", "orphan", "reachable", "reaches", "rules",
  "source", "valid"
]);
const dependencyFields = new Set([
  "circular", "coreModule", "couldNotResolve", "cycle", "dependencyTypes", "dynamic", "exoticRequire",
  "exoticallyRequired", "followable", "instability", "license", "matchesDoNotFollow", "mimeType", "module",
  "moduleSystem", "preCompilationOnly", "protocol", "resolved", "rules", "typeOnly", "valid"
]);
const summaryFields = new Set([
  "error", "ignore", "info", "optionsUsed", "totalCruised", "totalDependenciesCruised", "violations", "warn"
]);

export async function runJavaScriptTypeScriptCodeGraph(options) {
  const scopes = selectedScopes(options.manifest, options.extractor);
  if (!scopes.ok) return scopes;
  const roots = scanRoots(scopes.value);
  const argv = [
    "--no-config",
    "--output-type", "json",
    "--progress", "none",
    "--exclude", defaultExclude,
    "--",
    ...roots
  ];
  const execute = options.execute ?? executeDependencyCruiser;
  const versionExecution = await execute({
    executable: "depcruise",
    argv: ["--version"],
    cwd: options.executionRoot,
    shell: false,
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs
  });
  if (versionExecution.status === "tool-missing") {
    return {
      status: "tool-missing",
      tool: missingTool(options.extractor, "not-installed", "Install the pinned @harness-anything/cli dependencies so depcruise is available on PATH.")
    };
  }
  if (versionExecution.status !== "ok" || versionExecution.stdout.trim() !== toolVersion) {
    return invalid("architecture_extractor_version_mismatch", "extractor.tool.version", `Expected dependency-cruiser ${toolVersion}.`);
  }
  const execution = await execute({
    executable: "depcruise",
    argv,
    cwd: options.executionRoot,
    shell: false,
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs
  });
  if (execution.status === "tool-missing") {
    return {
      status: "tool-missing",
      tool: missingTool(options.extractor, "not-installed", "Install the pinned @harness-anything/cli dependencies so depcruise is available on PATH.")
    };
  }
  if (execution.status !== "ok") {
    return invalid("architecture_extractor_process_failed", "extractor", `dependency-cruiser failed closed: ${execution.reason}.`);
  }
  let raw;
  try {
    raw = JSON.parse(execution.stdout);
  } catch {
    return invalid("architecture_extractor_output_invalid", "extractor.output", "dependency-cruiser stdout was not valid JSON.");
  }
  return decodeDependencyCruiserCodeGraph({
    raw,
    executionRoot: options.executionRoot,
    extractor: options.extractor,
    scopes: scopes.value
  });
}

export function decodeDependencyCruiserCodeGraph({ raw, executionRoot, extractor, scopes }) {
  const rawValidation = validateRawCruiseResult(raw);
  if (!rawValidation.ok) return rawValidation;
  const matchers = scopes.map((scope) => ({
    ...scope,
    includeMatcher: (filePath) => scope.include.some((pattern) => path.matchesGlob(filePath, pattern)),
    excludeMatcher: (filePath) => scope.exclude.some((pattern) => path.matchesGlob(filePath, pattern))
  }));
  const candidates = new Map();
  for (const module of raw.modules) {
    const sourcePath = portableToolPath(module.source);
    if (sourcePath === null || !sourceExtension.test(sourcePath) || excludedByDefault(sourcePath)) continue;
    const matchingScopes = matchers.filter((scope) => scope.includeMatcher(sourcePath) && !scope.excludeMatcher(sourcePath));
    if (matchingScopes.length > 1) {
      return invalid("architecture_extractor_scope_ambiguous", sourcePath, `Source path matches multiple declared scopes: ${matchingScopes.map((scope) => scope.id).sort(compareArchitectureText).join(", ")}.`);
    }
    if (matchingScopes.length === 1) {
      if (candidates.has(sourcePath)) return invalid("architecture_extractor_output_duplicate", sourcePath, "dependency-cruiser returned the same portable source path more than once.");
      candidates.set(sourcePath, { module, sourceScopeId: matchingScopes[0].id });
    }
  }

  const packageByManifest = new Map();
  const files = [...candidates.entries()].map(([filePath, candidate]) => {
    const manifestPath = nearestPackageManifest(executionRoot, filePath);
    let packageId = null;
    if (manifestPath !== null) {
      packageId = packageIdForManifest(manifestPath);
      packageByManifest.set(manifestPath, packageId);
    }
    return { path: filePath, sourceScopeId: candidate.sourceScopeId, packageId };
  });
  const dependencies = [];
  for (const [sourcePath, candidate] of candidates) {
    for (const dependency of candidate.module.dependencies) {
      const targetPath = portableToolPath(dependency.resolved);
      if (targetPath === null || !candidates.has(targetPath) || dependency.couldNotResolve === true) continue;
      dependencies.push({
        sourcePath,
        targetPath,
        mechanism: dependencyMechanism(dependency),
        specifier: dependency.module
      });
    }
  }
  const packages = [...packageByManifest.entries()].map(([manifestPath, id]) => ({ id, manifestPath }));
  const sourceScopeIds = scopes.map((scope) => scope.id).sort(compareArchitectureText);
  const normalizedFacts = buildArchitectureCodeGraph({ files, packages, dependencies });
  const inputDigest = digestJson({
    scopes: scopes.map(({ id, include, exclude }) => ({ id, include, exclude })),
    files: normalizedFacts.files,
    packages: normalizedFacts.packages,
    dependencies: normalizedFacts.dependencies
  });
  const graph = buildArchitectureCodeGraph({
    schema: "architecture-code-graph/v1",
    extractor: {
      id: extractor.id,
      adapter: extractor.adapter,
      sourceScopeIds,
      inputDigest,
      toolRef: `extractor:${extractor.id}`
    },
    tool: {
      role: "extractor",
      declarationId: extractor.id,
      adapter: extractor.adapter,
      tool: toolName,
      version: toolVersion
    },
    files: normalizedFacts.files,
    packages: normalizedFacts.packages,
    dependencies: normalizedFacts.dependencies,
    stats: {
      sourceFiles: normalizedFacts.files.length,
      packageCount: normalizedFacts.packages.length,
      dependencyEdges: normalizedFacts.dependencies.length
    }
  });
  const validation = validateArchitectureCodeGraph(graph);
  return validation.ok
    ? { status: "ok", graph }
    : { status: "invalid", issues: validation.issues };
}

export function dependencyCruiserInvocation(scopes) {
  return {
    executable: "depcruise",
    argv: ["--no-config", "--output-type", "json", "--progress", "none", "--exclude", defaultExclude, "--", ...scanRoots(scopes)],
    shell: false
  };
}

async function executeDependencyCruiser({ executable, argv, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn(executable, argv, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: "failed", reason: "timeout" });
    }, timeoutMs);
    child.once("error", (error) => finish(error?.code === "ENOENT"
      ? { status: "tool-missing" }
      : { status: "failed", reason: "spawn-error" }));
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        child.kill("SIGKILL");
        finish({ status: "failed", reason: "output-limit" });
      }
    });
    child.stderr.resume();
    child.once("close", (code) => finish(code === 0
      ? { status: "ok", stdout }
      : { status: "failed", reason: `exit-${code}` }));
  });
}

function selectedScopes(manifest, extractor) {
  const byId = new Map(manifest.sourceScopes.map((scope) => [scope.id, scope]));
  const scopes = [];
  for (const id of [...extractor.sourceScopeIds].sort(compareArchitectureText)) {
    const scope = byId.get(id);
    if (!scope) return invalid("architecture_extractor_scope_missing", `extractor.sourceScopeIds.${id}`, `Extractor references unknown source scope ${id}.`);
    scopes.push({ id, include: [...scope.include].sort(compareArchitectureText), exclude: [...scope.exclude].sort(compareArchitectureText) });
  }
  return { ok: true, value: scopes };
}

function validateRawCruiseResult(raw) {
  if (!isRecord(raw) || !hasExactKeys(raw, ["modules", "summary"]) || !Array.isArray(raw.modules) ||
    !isRecord(raw.summary) || !hasOnlyKeys(raw.summary, summaryFields)) {
    return invalid("architecture_extractor_output_invalid", "extractor.output", "dependency-cruiser output must contain only modules and summary at the top level.");
  }
  for (const [index, module] of raw.modules.entries()) {
    if (!isRecord(module) || !hasOnlyKeys(module, moduleFields) || typeof module.source !== "string" || !Array.isArray(module.dependencies)) {
      return invalid("architecture_extractor_output_invalid", `extractor.output.modules[${index}]`, "Each dependency-cruiser module requires source and dependencies.");
    }
    for (const [dependencyIndex, dependency] of module.dependencies.entries()) {
      if (!isRecord(dependency) || !hasOnlyKeys(dependency, dependencyFields) || typeof dependency.module !== "string" || dependency.module.length === 0 ||
        typeof dependency.resolved !== "string" || typeof dependency.moduleSystem !== "string" ||
        typeof dependency.dynamic !== "boolean" || typeof dependency.couldNotResolve !== "boolean") {
        return invalid("architecture_extractor_output_invalid", `extractor.output.modules[${index}].dependencies[${dependencyIndex}]`, "Dependency records require fixed resolution and mechanism fields.");
      }
    }
  }
  return { ok: true };
}

function scanRoots(scopes) {
  const roots = scopes.flatMap((scope) => scope.include.map(staticRoot));
  return [...new Set(roots)].sort(compareArchitectureText);
}

function staticRoot(glob) {
  const segments = glob.split("/");
  const fixed = [];
  for (const segment of segments) {
    if (/[*?{}()[\]!+@]/u.test(segment)) break;
    fixed.push(segment);
  }
  if (fixed.length === 0) return ".";
  if (sourceExtension.test(fixed.at(-1))) fixed.pop();
  return fixed.length === 0 ? "." : fixed.join("/");
}

function portableToolPath(value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) return null;
  const normalized = value.split(path.sep).join("/").replace(/^\.\//u, "");
  return normalized === "" || normalized === ".." || normalized.startsWith("../") || normalized.includes("\\") ? null : normalized;
}

function excludedByDefault(filePath) {
  return /(^|\/)(?:node_modules|dist|test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filePath);
}

function nearestPackageManifest(root, filePath) {
  let directory = path.dirname(path.resolve(root, filePath));
  const repositoryRoot = path.resolve(root);
  while (directory === repositoryRoot || directory.startsWith(`${repositoryRoot}${path.sep}`)) {
    const candidate = path.join(directory, "package.json");
    if (existsSync(candidate)) return path.relative(repositoryRoot, candidate).split(path.sep).join("/");
    if (directory === repositoryRoot) break;
    directory = path.dirname(directory);
  }
  return null;
}

function packageIdForManifest(manifestPath) {
  return `package.${createHash("sha256").update(manifestPath).digest("hex").slice(0, 16)}`;
}

function dependencyMechanism(dependency) {
  if (dependency.dynamic) return "dynamic-import";
  if (dependency.moduleSystem === "cjs") return "require";
  if (dependency.moduleSystem === "es6") return "import";
  return dependency.moduleSystem.toLowerCase().replace(/[^a-z0-9.-]+/gu, "-");
}

function digestJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function missingTool(extractor, reason, hint) {
  return {
    role: "extractor",
    declarationId: extractor.id,
    adapter: extractor.adapter,
    tool: toolName,
    version: null,
    reason,
    hint
  };
}

function invalid(code, pathName, message) {
  return { status: "invalid", issues: [{ code, path: pathName, message }] };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}
