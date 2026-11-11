import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { discoverTestFiles, parseTestTierMarker } from "./test-tier-manifest.mjs";

// Selecting the test files a change can reach is deliberately an over-approximation:
// a selection that is too wide costs one dispatch, a selection that is too narrow sends
// the regression to CI. `preProcessFile` reports static imports, export-from re-exports
// and literal dynamic imports, including `import type`. Type-only imports are counted
// because the Node test runner still resolves and type-strips the module graph; a broken
// type-only target fails the test file just like a value import would.
const sourceFilePattern = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const testFilePattern = /\.(?:test|spec)\.(?:mjs|js|ts|tsx)$|\.vitest\.tsx?$/u;
const ignoredDirectoryNames = new Set([
  ".git",
  "app-node_modules",
  "coverage",
  "dist",
  "dist-electron",
  "node_modules",
  "out",
]);
const defaultGraphRoots = Object.freeze(["packages", "tools", "scripts"]);
const packageSegmentCount = (specifier) => (specifier.startsWith("@") ? 2 : 1);

/** One quarter of the integration tier is the point where a whole-tier CI run is cheaper than a selection. */
export const WHOLE_TIER_RATIO = 0.25;

export function listImportGraphFiles(root, roots = defaultGraphRoots) {
  const files = [];
  for (const directory of roots) walk(root, directory, files);
  return files.sort();
}

function walk(root, directory, files) {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ignoredDirectoryNames.has(entry.name)) continue;
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) walk(root, relative, files);
    else if (entry.isFile() && sourceFilePattern.test(entry.name)) files.push(relative);
  }
}

export function buildImportGraph(root, options = {}) {
  const startedAt = Date.now();
  const files = options.files ?? listImportGraphFiles(root);
  const knownTargets = new Set(options.knownTargets ?? []);
  const resolver = createResolver(root, knownTargets);
  const reverse = new Map();
  // `imports` mirrors `reverse` for callers that rank tests by how closely their direct
  // imports resemble the tests that directly cover the changed files (see
  // selectAffectedTests). Keeping both directions costs one extra Set per importer.
  const imports = new Map();
  const unresolved = [];
  let edges = 0;
  for (const importer of files) {
    const source = readFileSync(path.join(root, importer), "utf8");
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      const target = resolveSpecifier(resolver, importer, fileName);
      if (target === null) {
        if (!fileName.startsWith("node:") && !fileName.startsWith("/"))
          unresolved.push({ importer, specifier: fileName });
        continue;
      }
      edges += 1;
      const importers = reverse.get(target);
      if (importers === undefined) reverse.set(target, new Set([importer]));
      else importers.add(importer);
      const imported = imports.get(importer);
      if (imported === undefined) imports.set(importer, new Set([target]));
      else imported.add(target);
    }
  }
  return {
    root,
    files: new Set(files),
    // A deleted file still has to be a graph node: its importers are exactly the callers
    // that break when it disappears.
    nodes: new Set([...files, ...knownTargets]),
    reverse,
    imports,
    edges,
    unresolved,
    durationMs: Date.now() - startedAt,
  };
}

function createResolver(root, knownTargets) {
  const packageByName = loadWorkspacePackages(root);
  return {
    exists(target) {
      if (knownTargets.has(target)) return true;
      const absolute = path.join(root, target);
      return existsSync(absolute) && statSync(absolute).isFile();
    },
    packageByName,
  };
}

function loadWorkspacePackages(root) {
  const packages = new Map();
  const packagesRoot = path.join(root, "packages");
  if (!existsSync(packagesRoot)) return packages;
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const packageFile = path.join(packagesRoot, entry.name, "package.json");
    if (!existsSync(packageFile)) continue;
    const declaration = JSON.parse(readFileSync(packageFile, "utf8"));
    if (typeof declaration.name !== "string" || declaration.name.length === 0) continue;
    packages.set(declaration.name, {
      directory: `packages/${entry.name}`,
      exports: declaration.exports,
    });
  }
  return packages;
}

function resolveSpecifier(resolver, importer, specifier) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    if (base.startsWith("..")) return null;
    return resolveCandidate(resolver, base);
  }
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return resolveWorkspaceSpecifier(resolver, specifier);
  return null;
}

function resolveWorkspaceSpecifier(resolver, specifier) {
  const segments = specifier.split("/");
  const workspacePackage = resolver.packageByName.get(segments.slice(0, packageSegmentCount(specifier)).join("/"));
  if (workspacePackage === undefined) return null;
  const subpath = segments.slice(packageSegmentCount(specifier)).join("/");
  const exportKey = subpath.length > 0 ? `./${subpath}` : ".";
  const exports = workspacePackage.exports ?? {};
  let entry = typeof exports === "string" ? (exportKey === "." ? exports : undefined) : exports[exportKey];
  if (entry === undefined && exports !== null && typeof exports === "object" && !Array.isArray(exports)) {
    const pattern = Object.keys(exports)
      .filter((key) => key.includes("*") && wildcardCapture(exportKey, key) !== null)
      .sort((left, right) => right.indexOf("*") - left.indexOf("*") || left.length - right.length)[0];
    if (pattern !== undefined) entry = substituteWildcard(exports[pattern], wildcardCapture(exportKey, pattern));
  }
  const target = exportTarget(entry) ?? (subpath.length > 0 ? `./src/${subpath}` : "./src/index.ts");
  if (!target.startsWith("./")) return null;
  const relative = path.posix.normalize(path.posix.join(workspacePackage.directory, target));
  return resolveCandidate(resolver, relative, "/dist/");
}

function wildcardCapture(value, pattern) {
  const [prefix, suffix] = pattern.split("*");
  if (!suffix || !value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  return value.slice(prefix.length, value.length - suffix.length);
}

function substituteWildcard(entry, capture) {
  if (typeof entry === "string") return entry.replaceAll("*", capture);
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, substituteWildcard(value, capture)]));
}

function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  for (const condition of ["default", "import", "node", "types"]) {
    const target = exportTarget(entry[condition]);
    if (target !== null) return target;
  }
  return null;
}

function resolveCandidate(resolver, relative, distMarker) {
  const candidates = [relative];
  const extension = path.posix.extname(relative);
  if (extension === ".js") candidates.push(relative.slice(0, -3) + ".ts", relative.slice(0, -3) + ".tsx");
  else if (extension === ".mjs") candidates.push(relative.slice(0, -4) + ".mts");
  else if (extension === ".cjs") candidates.push(relative.slice(0, -4) + ".cts");
  else if (extension === ".jsx") candidates.push(relative.slice(0, -4) + ".tsx");
  else if (extension.length === 0)
    candidates.push(
      `${relative}.ts`,
      `${relative}.tsx`,
      `${relative}.mts`,
      `${relative}.cts`,
      `${relative}.mjs`,
      `${relative}.js`,
      `${relative}.jsx`,
    );
  for (const suffix of ["ts", "tsx", "mts", "cts", "mjs", "js", "jsx"]) candidates.push(`${relative}/index.${suffix}`);
  if (distMarker !== undefined) {
    const sourceRelative = relative.replace(distMarker, "/src/");
    if (sourceRelative !== relative) {
      const sourceCandidates = sourceRelative.replace(/\.d\.ts$/u, ".ts");
      candidates.push(...candidateForms(sourceCandidates));
    }
  }
  return candidates.find((candidate) => resolver.exists(candidate)) ?? null;
}

function candidateForms(relative) {
  const forms = [relative];
  if (relative.endsWith(".js")) forms.push(relative.slice(0, -3) + ".ts");
  if (relative.endsWith(".jsx")) forms.push(relative.slice(0, -4) + ".tsx");
  return forms;
}

export function affectedChangedFiles(root, base) {
  let mergeBase;
  try {
    mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  } catch (error) {
    throw new Error(
      `affected selection cannot resolve merge-base(${base}, HEAD): ${error.message.trim()}; ` +
        `fetch the base ref (git fetch origin main) or pass --base <ref>`,
    );
  }
  const changedFiles = git(root, ["diff", "--name-only", "-z", mergeBase, "HEAD", "--"]).split("\0").filter(Boolean);
  return { mergeBase, changedFiles };
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function normalizeChangedPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized)) return null;
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return normalized;
}

/**
 * Selects every discovered test file that transitively imports one of the changed files.
 *
 * The import graph is built once, then one multi-source reverse breadth-first walk attributes
 * each reachable test file to the changed file that reached it first. The walk visits every
 * node at most once, so the cost does not grow with (changed files × repository files).
 *
 * A daemon core module is imported by the runtime spawner, which nearly every daemon test
 * reaches, so distance alone cannot separate a settlement regression from an unrelated
 * daemon test. When the raw selection exceeds the whole-tier threshold the selector ranks by
 * import distance first, then by how closely a test's resolved direct imports resemble the
 * direct imports of the tests that directly cover the changed files. Those direct-cover tests
 * are the anchors for the changed module's feature cluster; a test that imports the same
 * runtime fixtures and dispatch helpers is more likely to exercise the same behavior.
 * The cap is never silent: `deferred` names every unselected affected test file, and
 * `deferredReason` carries the count and the ranking rule.
 */
export function selectAffectedTests(options) {
  const startedAt = Date.now();
  const { root } = options;
  const ratio = options.ratio ?? WHOLE_TIER_RATIO;
  const resolvedChanges =
    options.changedFiles === undefined
      ? affectedChangedFiles(root, options.base ?? "origin/main")
      : { mergeBase: undefined, changedFiles: options.changedFiles };
  const invalid = [];
  const changedFiles = [];
  for (const value of resolvedChanges.changedFiles) {
    const normalized = normalizeChangedPath(value);
    if (normalized === null) invalid.push(value);
    else changedFiles.push(normalized);
  }
  const testFiles = options.testFiles ?? discoverTestFiles(root);
  const testSet = new Set(testFiles);
  const sourceChanges = changedFiles.filter((file) => !testSet.has(file) && sourceFilePattern.test(file));
  const graph =
    options.graph ??
    (options.buildGraph ?? ((input) => buildImportGraph(input.root, { knownTargets: input.knownTargets })))({
      root,
      knownTargets: sourceChanges,
    });
  const seeds = [];
  const direct = new Set();
  const ignored = [];
  const unmapped = [];
  for (const file of changedFiles) {
    if (testSet.has(file)) {
      direct.add(file);
      seeds.push(file);
      continue;
    }
    if (testFilePattern.test(file) && existsSync(path.join(root, file))) {
      // A test-shaped file the node manifest does not discover (for example a GUI Vitest
      // file) cannot run through this selector. Naming it is better than reporting a
      // smaller green selection.
      unmapped.push(file);
      continue;
    }
    if (graph.nodes.has(file)) {
      seeds.push(file);
      continue;
    }
    if (sourceFilePattern.test(file)) unmapped.push(file);
    else ignored.push(file);
  }
  if (unmapped.length > 0 || invalid.length > 0) {
    return {
      base: options.base ?? "origin/main",
      changedFiles,
      changedTests: [...direct].sort(),
      selected: [],
      deferred: [],
      rawSelected: 0,
      deferredCount: 0,
      deferredReason: "",
      truncated: false,
      ignored,
      unmapped,
      invalid,
      graph: { files: graph.files.size, edges: graph.edges, durationMs: graph.durationMs },
      mergeBase: resolvedChanges.mergeBase,
      durationMs: Date.now() - startedAt,
    };
  }
  const origin = new Map();
  const distance = new Map();
  const queue = [];
  for (const seed of [...seeds].sort()) {
    if (origin.has(seed)) continue;
    origin.set(seed, seed);
    distance.set(seed, 0);
    queue.push(seed);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    for (const importer of [...(graph.reverse.get(file) ?? [])].sort()) {
      if (origin.has(importer)) continue;
      origin.set(importer, origin.get(file));
      distance.set(importer, distance.get(file) + 1);
      queue.push(importer);
    }
  }
  const testTiers = new Map();
  for (const file of testFiles) {
    const firstLine = readFileSync(path.join(root, file), "utf8").split("\n", 1)[0];
    testTiers.set(file, parseTestTierMarker(firstLine, file));
  }
  const reachable = [...origin.keys()]
    .filter((file) => testSet.has(file))
    .map((file) => ({
      file,
      via: origin.get(file),
      changed: direct.has(file),
      distance: distance.get(file),
      tier: testTiers.get(file),
    }));
  const integrationTotal = [...testTiers.values()].filter((tier) => tier === "integration").length;
  const maxSelected = Math.max(1, Math.ceil(integrationTotal * ratio));
  const ranked = reachable.length > maxSelected ? capAffectedTests(reachable, graph) : sortByPath(reachable);
  const selected = ranked.slice(0, maxSelected).map(({ file, via, changed }) => ({ file, via, changed }));
  const deferred = ranked.slice(maxSelected).map(({ file, via, distance: deferredDistance }) => ({
    file,
    via,
    distance: deferredDistance,
  }));
  return {
    base: options.base ?? "origin/main",
    changedFiles,
    changedTests: [...direct].sort(),
    selected,
    deferred,
    rawSelected: reachable.length,
    deferredCount: deferred.length,
    deferredReason:
      deferred.length === 0
        ? ""
        : buildDeferredReason({
            deferredCount: deferred.length,
            rawSelected: reachable.length,
            maxSelected,
            integrationTotal,
            ratio,
            anchorCount: countAnchors(reachable),
          }),
    truncated: deferred.length > 0,
    ignored,
    unmapped: [],
    invalid: [],
    graph: { files: graph.files.size, edges: graph.edges, durationMs: graph.durationMs },
    mergeBase: resolvedChanges.mergeBase,
    integrationTotal,
    maxSelected,
    // A capped selection is runnable; `truncated` names the remainder that is not run.
    tooMany: false,
    durationMs: Date.now() - startedAt,
  };
}

function sortByPath(tests) {
  return [...tests].sort((left, right) => left.file.localeCompare(right.file));
}

function countAnchors(tests) {
  if (tests.length === 0) return 0;
  const nearest = Math.min(...tests.map(({ distance }) => distance));
  return tests.filter(({ distance }) => distance === nearest).length;
}

/**
 * Caps the reachable tests at the whole-tier threshold.
 *
 * Changed test files always run: they are the PR's own coverage and their distance is 0.
 * The rest of the cap belongs to the integration tier, because the threshold is a quarter
 * of that tier; within it, distance comes first and Jaccard similarity to the nearest tests
 * (the direct-cover anchors) breaks ties. A changed file with no changed test and no
 * integration test in its nearest layer (for example a single new source module) keeps that
 * nearest layer, so its direct-cover fast tests are not displaced by distant integration
 * tests. Fast/contract tests fill only unused slots.
 */
function capAffectedTests(tests, graph) {
  const imports = directImports(graph);
  const nearest = Math.min(...tests.map(({ distance }) => distance));
  const anchors = tests.filter(({ distance }) => distance === nearest);
  const centroid = new Map();
  for (const { file } of anchors) {
    for (const target of imports.get(file) ?? []) centroid.set(target, (centroid.get(target) ?? 0) + 1);
  }
  const empty = new Set();
  const similarityByFile = new Map();
  const similarity = (file) => {
    const cached = similarityByFile.get(file);
    if (cached !== undefined) return cached;
    if (centroid.size === 0) return 0;
    const candidates = imports.get(file) ?? empty;
    let intersection = 0;
    for (const target of candidates) if (centroid.has(target)) intersection += 1;
    const union = candidates.size + centroid.size - intersection;
    const score = union === 0 ? 0 : intersection / union;
    similarityByFile.set(file, score);
    return score;
  };
  const compare = (left, right) =>
    left.distance - right.distance ||
    similarity(right.file) - similarity(left.file) ||
    left.file.localeCompare(right.file);
  const changed = tests.filter(({ changed }) => changed).sort((left, right) => left.file.localeCompare(right.file));
  const keepNearestLayer = changed.length === 0 && anchors.every(({ tier }) => tier !== "integration");
  const forced = keepNearestLayer ? [...anchors].sort(compare) : [];
  const forcedFiles = new Set([...changed, ...forced].map(({ file }) => file));
  const integration = tests.filter(({ file, tier }) => !forcedFiles.has(file) && tier === "integration").sort(compare);
  const others = tests.filter(({ file, tier }) => !forcedFiles.has(file) && tier !== "integration").sort(compare);
  return [...changed, ...forced, ...integration, ...others];
}

function directImports(graph) {
  if (graph.imports instanceof Map) return graph.imports;
  const imports = new Map();
  for (const [target, importers] of graph.reverse) {
    for (const importer of importers) {
      const imported = imports.get(importer);
      if (imported === undefined) imports.set(importer, new Set([target]));
      else imported.add(target);
    }
  }
  return imports;
}

function buildDeferredReason({ deferredCount, rawSelected, maxSelected, integrationTotal, ratio, anchorCount }) {
  const percentage = Math.round(ratio * 100);
  return (
    `${deferredCount} of ${rawSelected} affected test files are not run: the selection is capped at ` +
    `${maxSelected} (${percentage}% of the ${integrationTotal} integration tests). Changed test files ` +
    `always run; the rest of the cap goes to integration tests ranked by import distance and then by ` +
    `import-set similarity to the ${anchorCount} direct-cover test file(s), and fast/contract tests fill ` +
    `only unused slots. Run the deferred files in CI.`
  );
}
