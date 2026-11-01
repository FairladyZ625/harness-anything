import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { entryValues, loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";
import { listWorktreeFiles } from "./gates/git.mjs";
import {
  analyzeRuntimeImportCycles,
  formatCycleWitness,
  stronglyConnectedComponents,
} from "./gates/import-cycle-graph.mjs";

const root = process.cwd();
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const violations = [];
const importPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const oldRuntimePattern = /scripts\/(?:kernel\/task|lib\/task-)|(?:^|\/)(?:states|policies)\.mts$|TaskBinding/;
const allowlist = loadGateAllowlist("check-import-boundaries", {
  requiredSections: [
    "guiAdapterCompositionRoots",
    "cliAdapterCompositionRoots",
    "kernelStoreCompositionRoots",
    "cliAdapterKnownDebt",
  ],
});
const guiAdapterCompositionRoots = new Set(entryValues(allowlist.guiAdapterCompositionRoots));
const cliAdapterCompositionRoots = new Set(entryValues(allowlist.cliAdapterCompositionRoots));
const kernelStoreCompositionRoots = new Set(entryValues(allowlist.kernelStoreCompositionRoots));
const cliAdapterKnownDebt = new Set(entryValues(allowlist.cliAdapterKnownDebt));
const fleetWriteClientNames = new Set([
  "runFleetWriteClient",
  "runFleetUploadClient",
  "runFleetRuntimeEventClient",
  "runFleetRuntimeArchiveClient",
  "runFleetTaskCommandClient",
  "runFleetScheduleCommandClient",
]);
const fleetWritePort = "packages/daemon/src/fleet-edge-write.ts";
const workspacePackages = await loadWorkspacePackages("packages");
const workspacePackagesByName = new Map(
  workspacePackages.map((workspacePackage) => [workspacePackage.name, workspacePackage]),
);

async function loadWorkspacePackages(packagesRoot) {
  const packageFiles = listWorktreeFiles(root, [packagesRoot])
    .filter((file) => path.posix.basename(file) === "package.json")
    .map((file) => path.join(root, file));
  const packages = [];
  for (const packageFile of packageFiles) {
    const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
    if (typeof packageJson.name !== "string" || packageJson.name.length === 0) continue;
    const packageRoot = path.dirname(packageFile);
    packages.push({ name: packageJson.name, root: packageRoot, exports: packageJson.exports });
  }
  return packages;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function record(file, reason) {
  violations.push(`${relative(file)}: ${reason}`);
}

function resolveImport(file, specifier) {
  if (specifier.startsWith(".")) return relative(path.normalize(path.join(path.dirname(file), specifier)));
  return resolveWorkspacePackageImport(specifier) ?? specifier;
}

function resolveWorkspacePackageImport(specifier) {
  const segments = specifier.split("/"),
    packageSegmentCount = specifier.startsWith("@") ? 2 : 1;
  const workspacePackage = workspacePackagesByName.get(segments.slice(0, packageSegmentCount).join("/"));
  if (!workspacePackage) return null;
  const packageSubpath = segments.slice(packageSegmentCount).join("/"),
    exportKey = packageSubpath ? `./${packageSubpath}` : ".";
  const exports = workspacePackage.exports ?? {};
  let entry = exports[exportKey];
  if (entry === undefined) {
    const pattern = Object.keys(exports)
      .filter((key) => key.includes("*") && wildcardMatch(exportKey, key) !== null)
      .sort((left, right) => right.indexOf("*") - left.indexOf("*") || left.length - right.length)[0];
    if (pattern) {
      const captured = wildcardMatch(exportKey, pattern);
      entry = mapExportTarget(exports[pattern], (target) => target.replaceAll("*", captured));
    }
  }
  const target = exportTarget(entry ?? (exportKey === "." && typeof exports === "string" ? exports : undefined));
  return target?.startsWith("./") ? relative(path.normalize(path.join(workspacePackage.root, target))) : null;
}

function wildcardMatch(value, pattern) {
  const [prefix, suffix] = pattern.split("*");
  if (!suffix || !value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  return value.slice(prefix.length, value.length - suffix.length);
}

function mapExportTarget(entry, mapper) {
  if (typeof entry === "string") return mapper(entry);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, mapExportTarget(value, mapper)]));
}

function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  for (const condition of ["default", "import", "node"]) {
    const target = exportTarget(entry[condition]);
    if (target !== null) return target;
  }
  return null;
}

function resolveImportFile(file, specifier, knownFiles) {
  const baseRel = resolveImport(file, specifier);
  if (baseRel === specifier && !specifier.startsWith(".")) return null;
  const candidates = [
    baseRel,
    `${baseRel}.ts`,
    `${baseRel}.tsx`,
    `${baseRel}.mts`,
    `${baseRel}.js`,
    `${baseRel}.jsx`,
    `${baseRel}.mjs`,
    `${baseRel}/index.ts`,
    `${baseRel}/index.tsx`,
    `${baseRel}/index.mts`,
    `${baseRel}/index.js`,
    `${baseRel}/index.jsx`,
    `${baseRel}/index.mjs`,
  ];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

function importedPathViolates(file, specifier, isForbidden) {
  const resolved = resolveImport(file, specifier);
  return isForbidden(resolved);
}

async function collectImportEdges(files, knownFiles) {
  const edges = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const rel = relative(file);
    const imports = [...text.matchAll(importPattern)].map((match) => ({
      specifier: match[1] ?? match[2] ?? match[3],
      statement: match[0],
    }));
    for (const { specifier, statement } of imports) {
      const target = resolveImportFile(file, specifier, knownFiles);
      if (target) {
        edges.push({
          importer: rel,
          target,
          specifier,
          statement,
          kind: importStatementKind(statement),
          importedNames: extractImportedNames(statement),
        });
      }
    }
  }
  return edges;
}

function importStatementKind(statement) {
  const trimmed = statement.trimStart();
  if (trimmed.startsWith("export")) return "reexport";
  if (trimmed.startsWith("require")) return "require";
  if (/^import\s*\(/u.test(trimmed)) return "dynamic";
  return "import";
}

function extractImportedNames(statement) {
  const trimmed = statement.trim();
  if (!trimmed.startsWith("import") || /^import\s*\(/u.test(trimmed)) return null;
  if (/^import\s+(?:type\s+)?\*\s+as\s+/u.test(trimmed)) return "namespace";
  const namedMatch = /\bimport\s+(?:type\s+)?(?:[^"']*?,\s*)?\{([^}]*)\}\s+from\b/su.exec(statement);
  if (!namedMatch) return null;
  return parseSpecifierListNames(namedMatch[1], "imported");
}

function parseSpecifierListNames(specifierList, mode) {
  const names = new Set();
  for (const rawPart of specifierList.split(",")) {
    const part = rawPart.trim().replace(/^type\s+/u, "");
    if (!part) continue;
    const [left, right] = part
      .split(/\s+as\s+/u)
      .map((value) => value.trim())
      .filter(Boolean);
    const name = mode === "exported" ? (right ?? left) : left;
    if (name) names.add(name);
  }
  return names;
}

function extractReexportedNames(statement, targetText) {
  const trimmed = statement.trim();
  const namespaceMatch = /^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/u.exec(trimmed);
  if (namespaceMatch) return new Set([namespaceMatch[1]]);
  if (/^export\s+(?:type\s+)?\*\s+from\b/u.test(trimmed)) return extractLocalExportNames(targetText);
  const namedMatch = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s+from\b/su.exec(statement);
  if (!namedMatch) return new Set();
  return parseSpecifierListNames(namedMatch[1], "exported");
}

function extractLocalExportNames(text) {
  const names = new Set();
  const declarationPattern =
    /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gu;
  for (const match of text.matchAll(declarationPattern)) names.add(match[1]);
  const namedExportPattern = /\bexport\s+\{([^}]*)\}(?:\s+from\b)?/gsu;
  for (const match of text.matchAll(namedExportPattern)) {
    for (const name of parseSpecifierListNames(match[1], "exported")) names.add(name);
  }
  return names;
}

function isTestOrFixturePath(rel) {
  return /(?:^|\/)(?:__fixtures__|fixtures|test|tests|test-support)\//.test(rel) || /\.test\.[cm]?[jt]s$/.test(rel);
}

// Repository setup in tests is intentionally funneled through the daemon fixture. These
// exceptions are the small set of tests that exercise the product registration/open boundary
// itself or need an unprojected/remote lifecycle that the fixture's settings bootstrap changes;
// the classification is documented in the task package and kept explicit so a new direct import
// fails closed.
const repoFixtureBoundaryExceptions = new Set([
  "packages/storage/test/store/daemon-registry.test.ts",
  "packages/daemon/test/repo-settings.fixture.ts",
  "packages/daemon/test/repo-bootstrap-configure-only.test.ts",
  "packages/daemon/test/json-rpc-task-settlement.integration.test.ts",
  "packages/daemon/test/json-rpc-repocell-lifecycle.integration.test.ts",
  "packages/daemon/test/replica-cut-store.integration.test.ts",
  "packages/daemon/test/fleet-center-lifecycle.integration.test.ts",
  "packages/daemon/test/fleet-edge-startup-read.integration.test.ts",
  "packages/daemon/test/fleet-transport-scale.integration.test.ts",
  "packages/daemon/test/fixtures/g1-write-cost-scaling.ts",
  "packages/daemon/test/daemon-host-recovery.test.ts",
  "packages/cli/test/daemon-autostart-cli.fixture.ts",
  "packages/cli/test/offline-storage.integration.test.ts",
  "packages/daemon/test/daemon-build-drain.integration.test.ts",
  "packages/daemon/test/runtime-execution-logout.integration.test.ts",
  "packages/daemon/test/schedule-fleet-agent-claim.integration.test.ts",
  "packages/daemon/test/worker-catalog-reads.integration.test.ts",
  "packages/daemon/test/worker-catalog-reads.integration.test.ts",
  "packages/daemon/test/fleet-write-wait-budget.integration.test.ts",
]);

function hasDirectRepoFixtureImport(text) {
  return [...text.matchAll(importPattern)].some((match) => {
    const statement = match[0],
      specifier = match[1] ?? match[2] ?? match[3];
    return (
      /\b(?:registerDaemonRepo|openRepoCell)\b/u.test(statement) &&
      /(?:@harness-anything\/kernel|(?:repo-cell|repo-cell-open))/u.test(specifier)
    );
  });
}

function packageSourceRootFromPath(rel) {
  const match = /^(packages\/.+?\/src)\//u.exec(rel);
  return match?.[1];
}

function isOrphanGateCandidate(rel) {
  const packageSourceRoot = packageSourceRootFromPath(rel);
  return !!packageSourceRoot && rel !== `${packageSourceRoot}/index.ts` && !isTestOrFixturePath(rel);
}

async function checkOrphanPackageModules(packageFiles, importEdges) {
  const packageFileSet = new Set(packageFiles.map(relative));
  const barrelTargets = new Map();
  for (const edge of importEdges) {
    const packageSourceRoot = packageSourceRootFromPath(edge.importer);
    if (!packageSourceRoot || edge.importer !== `${packageSourceRoot}/index.ts`) continue;
    if (edge.kind !== "reexport") continue;
    if (packageSourceRootFromPath(edge.target) !== packageSourceRoot) continue;
    if (edge.target.endsWith("/index.ts")) continue;
    if (isTestOrFixturePath(edge.target)) continue;
    if (!isOrphanGateCandidate(edge.target)) continue;
    if (!packageFileSet.has(edge.target)) continue;
    const targetText = await readFile(path.join(root, edge.target), "utf8");
    const exportedNames = barrelTargets.get(edge.target) ?? new Set();
    for (const name of extractReexportedNames(edge.statement, targetText)) exportedNames.add(name);
    barrelTargets.set(edge.target, exportedNames);
  }

  for (const [target, exportedNames] of barrelTargets) {
    const targetText = await readFile(path.join(root, target), "utf8");
    if (/@slice-activation\b/u.test(targetText)) continue;
    const packageSourceRoot = packageSourceRootFromPath(target);
    const packageIndex = `${packageSourceRoot}/index.ts`;
    const hasRealConsumer =
      importEdges.some((edge) => {
        if (edge.target !== target || edge.importer === target) return false;
        if (isTestOrFixturePath(edge.importer)) return false;
        if (edge.importer === packageIndex && edge.kind === "reexport") return false;
        return edge.importer.startsWith("packages/") || edge.importer.startsWith("tools/");
      }) ||
      importEdges.some((edge) => {
        if (edge.target !== packageIndex || isTestOrFixturePath(edge.importer)) return false;
        if (!edge.importer.startsWith("packages/") && !edge.importer.startsWith("tools/")) return false;
        if (edge.importer === target || edge.importer === packageIndex) return false;
        if (edge.importedNames === "namespace") return exportedNames.size > 0;
        if (!edge.importedNames) return false;
        return [...edge.importedNames].some((name) => exportedNames.has(name));
      });
    if (!hasRealConsumer) {
      record(
        path.join(root, target),
        "package source module is only re-exported from its package barrel; add @slice-activation with an owning slice or remove it from src",
      );
    }
  }
}

const packageSourceFiles = listWorktreeFiles(root, ["packages"])
  .filter((file) => sourceFile.test(file))
  .map((file) => path.join(root, file));
if (packageSourceFiles.length === 0)
  throw new Error("check-import-boundaries: required scan root packages has no source files");
const toolSourceFiles = listWorktreeFiles(root, ["tools"])
  .filter((file) => sourceFile.test(file))
  .map((file) => path.join(root, file));
const knownImportFiles = new Set([...packageSourceFiles, ...toolSourceFiles].map(relative));
const importEdges = await collectImportEdges([...packageSourceFiles, ...toolSourceFiles], knownImportFiles);

// dec_D90F19C8AAAF39747F8F0D6698/CH8 C4: persistence belongs to packages/storage. The
// backend discriminant, SQL text and database drivers must not appear in the ledger runtime
// packages; authorization adapters manage an external IdP and are outside that list.
const ledgerRuntimeSource = /^packages\/(?:kernel|application|cli|daemon|gui|preset)\/src\//u;
const databaseDriverPattern =
  /^(?:node:sqlite|better-sqlite3|sqlite3|pg|postgres|mysql2?|mongodb|@effect\/sql(?:\/|$)|@electric-sql\/|drizzle-orm(?:\/|$)|kysely(?:\/|$)|prisma(?:\/|$))/u;
const rawSqlPattern =
  /\b(?:SELECT\s+[\s\S]{1,240}?\s+FROM|INSERT\s+INTO|UPDATE\s+[A-Za-z_][\w.]*\s+SET|DELETE\s+FROM|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)|PRAGMA\s+[A-Za-z_])/u;
const backendBranchPattern =
  /\b(?:backend|storageBackend|storage\.backend)\s*[!=]==?\s*["'](?:sqlite|postgres)["']|["'](?:sqlite|postgres)["']\s*[!=]==?\s*[^\n;]{0,48}?(?:backend|storageBackend)\b/u;
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'])\/\/.*$/gmu, "$1");
}

for (const file of packageSourceFiles) {
  const text = await readFile(file, "utf8");
  const rel = relative(file);
  const isTestOrFixture = isTestOrFixturePath(rel);

  if (isTestOrFixture && !repoFixtureBoundaryExceptions.has(rel) && hasDirectRepoFixtureImport(text)) {
    record(
      file,
      "tests must obtain registered/open repositories through packages/daemon/test/repo-settings.fixture.ts",
    );
  }

  if (rel.startsWith("packages/kernel/src/domain/")) {
    if (/\bfrom\s+["'][^"']*(?:legacy|scripts\/kernel\/task)[^"']*["']/.test(text)) {
      record(file, "domain layer imports legacy runtime");
    }
  }

  const imports = [...text.matchAll(importPattern)].map((match) => match[1] ?? match[2] ?? match[3]);

  if (!rel.startsWith("packages/storage/src/") && !isTestOrFixture) {
    for (const specifier of imports) {
      if (databaseDriverPattern.test(specifier))
        record(file, `database driver ${specifier} belongs to packages/storage, not ${rel}`);
    }
  }
  if (ledgerRuntimeSource.test(rel) && !isTestOrFixture) {
    const code = stripComments(text);
    if (rawSqlPattern.test(code)) record(file, "raw SQL belongs to packages/storage, not ledger runtime code");
    if (backendBranchPattern.test(code))
      record(file, "storage backend branch belongs to packages/storage, not ledger runtime code");
  }

  if (rel.startsWith("packages/kernel/src/")) {
    for (const specifier of imports) {
      if (importedPathViolates(file, specifier, (target) => /packages\/storage\//.test(target))) {
        record(file, `kernel must not depend on storage via ${specifier}`);
      }
    }
  }

  if (rel.startsWith("packages/storage/")) {
    for (const specifier of imports) {
      if (
        importedPathViolates(file, specifier, (target) =>
          /packages\/(?:application|cli|daemon|gui|preset)\//.test(target),
        )
      ) {
        record(file, `storage must depend inward on kernel only, not delivery packages via ${specifier}`);
      }
    }
  }

  if (rel.startsWith("packages/kernel/src/domain/")) {
    for (const specifier of imports) {
      if (/^(?:node:)?(?:fs|process|child_process|path|os|crypto|sqlite|better-sqlite3)$/.test(specifier)) {
        record(file, `domain layer imports IO/runtime module via ${specifier}`);
      }
      if (
        importedPathViolates(file, specifier, (target) =>
          /packages\/kernel\/src\/(?:ports|application|store)\//.test(target),
        )
      ) {
        record(file, `domain layer imports upper kernel layer via ${specifier}`);
      }
    }
  }

  if (rel.startsWith("packages/kernel/src/ports/")) {
    for (const specifier of imports) {
      if (
        importedPathViolates(
          file,
          specifier,
          (target) =>
            /packages\/kernel\/src\/(?:application|store)\//.test(target) ||
            /packages\/(?:cli|gui|adapters)\//.test(target) ||
            /^@harness-anything\/(?:cli|gui|adapter-)/.test(target),
        )
      ) {
        record(file, `ports layer imports implementation/controller layer via ${specifier}`);
      }
    }
  }

  const isKernelStoreCompositionRoot = kernelStoreCompositionRoots.has(rel);
  if (!isTestOrFixture && !isKernelStoreCompositionRoot && !rel.startsWith("packages/storage/src/store/")) {
    for (const specifier of imports) {
      if (importedPathViolates(file, specifier, (target) => /packages\/kernel\/src\/store\//.test(target))) {
        record(
          file,
          `store implementation is internal to the kernel and must be obtained via the packages/kernel/src/composition/ seam, not imported via ${specifier}`,
        );
      }
    }
  }

  if (rel.startsWith("packages/application/")) {
    for (const specifier of imports) {
      if (
        importedPathViolates(
          file,
          specifier,
          (target) =>
            /packages\/kernel\/src\/store\//.test(target) ||
            /packages\/(?:cli|gui|adapters)\//.test(target) ||
            /^@harness-anything\/(?:cli|gui|adapter-)/.test(target),
        )
      ) {
        record(file, `application layer imports store/adapter/controller implementation via ${specifier}`);
      }
    }
  }

  if (rel.startsWith("packages/gui/")) {
    for (const specifier of imports) {
      if (
        importedPathViolates(file, specifier, (target) => {
          if (/packages\/kernel\/src\/store\//.test(target)) return true;
          if (/packages\/adapters\//.test(target) || /^@harness-anything\/adapter-/.test(target)) {
            return !guiAdapterCompositionRoots.has(rel);
          }
          return false;
        })
      ) {
        record(file, `GUI imports store or external adapter implementation via ${specifier}`);
      }
    }
  }

  if (rel.startsWith("packages/cli/")) {
    for (const specifier of imports) {
      if (
        importedPathViolates(file, specifier, (target) => {
          if (/packages\/kernel\/src\/store\//.test(target)) return !kernelStoreCompositionRoots.has(rel);
          if (/packages\/gui\//.test(target) || /^@harness-anything\/gui/.test(target)) return true;
          if (/packages\/adapters\//.test(target) || /^@harness-anything\/adapter-/.test(target)) {
            return !cliAdapterCompositionRoots.has(rel) && !cliAdapterKnownDebt.has(rel);
          }
          return false;
        })
      ) {
        record(file, `CLI imports GUI, adapter, or store implementation via ${specifier}`);
      }
    }
  }

  if (/packages\/(?!kernel\/src\/legacy-fixtures)/.test(rel)) {
    for (const specifier of imports) {
      if (oldRuntimePattern.test(specifier)) {
        record(file, `production package imports old runtime via ${specifier}`);
      }
    }
    if (oldRuntimePattern.test(text)) {
      record(file, "production package references old runtime symbol or path");
    }
  }

  // dec_66CE6F92D92CE3424C44B985D2/CH2: Fleet write clients have one edge
  // composition root. Tests may call the transport directly to exercise the
  // wire contract, but production code must enter through the edge port.
  if (!isTestOrFixture && rel !== fleetWritePort) {
    for (const specifier of imports) {
      const target = resolveImport(file, specifier);
      if (target !== "packages/daemon/src/fleet/peer.ts") continue;
      const edge = importEdges.find((candidate) => candidate.importer === rel && candidate.specifier === specifier);
      if (
        edge?.importedNames === "namespace" ||
        [...(edge?.importedNames ?? [])].some((name) => fleetWriteClientNames.has(name))
      )
        record(file, `Fleet write client imports must go through ${fleetWritePort}`);
    }
  }
  if (!isTestOrFixture && rel === "packages/daemon/src/fleet/center-listener.ts") {
    const centerWriteBranchRequirements = new Map([
      ["fleet.doc.submit/v1", "return runFleetCenterWrite(frame, async () => {"],
      ["fleet.task.command/v1", "return runFleetCenterWrite(frame, async () => {"],
      ["fleet.schedule.command/v1", "return runFleetCenterWrite(frame, async () => {"],
      ["fleet.runtime.event/v1", "return runFleetCenterWrite(frame, async () => {"],
      ["fleet.runtime.archive/v1", "return runFleetCenterWrite(frame, async () => {"],
      ["fleet.upload.begin/v1", "return runFleetCenterWrite(frame, async () => {"],
      ["fleet.upload.chunk/v1", "return runFleetCenterWrite(frame, async () => {"],
      ["fleet.upload.finish/v1", "return runFleetCenterWrite(frame, async () => {"],
    ]);
    for (const [frame, requiredCall] of centerWriteBranchRequirements) {
      const branchStart = text.indexOf(`if (frame.schema === "${frame}")`);
      const nextBranchMatch = text.slice(branchStart + 1).match(/\n\s*if \(frame\.schema ===/u);
      const nextBranch = nextBranchMatch ? branchStart + 1 + nextBranchMatch.index : -1;
      const branch = branchStart < 0 ? "" : text.slice(branchStart, nextBranch < 0 ? undefined : nextBranch);
      if (!branch || !branch.includes(requiredCall))
        record(file, `Fleet write frame ${frame} must use its center write entry ${requiredCall}`);
      if (branch && /runFleetCenterWrite\((?!frame,)/u.test(branch))
        record(file, `Fleet write frame ${frame} must call the center write entry with its frame`);
    }
  }
}

await checkOrphanPackageModules(packageSourceFiles, importEdges);

const cycleGraph = analyzeRuntimeImportCycles({
  files: [...packageSourceFiles, ...toolSourceFiles].map(relative),
  readSource: (file) => readFileSync(path.join(root, file), "utf8"),
  resolveImport: (importer, specifier) => resolveImportFile(path.join(root, importer), specifier, knownImportFiles),
});
for (const cycle of cycleGraph.cycles) {
  record(
    path.join(root, cycle.files[0]),
    `runtime import cycle (${cycle.files.length} files): ${formatCycleWitness(cycle.witness)}; members: ${cycle.files.join(", ")}`,
  );
}

// dec_D90F19C8AAAF39747F8F0D6698/CH8 C4: the workspace package graph is a DAG, and only the
// two frontends may depend on the daemon composition root. Declared dependencies and observed
// imports are unioned so a declaration-only reversal fails as well.
const workspacePackageByRoot = new Map(
  workspacePackages.map((workspacePackage) => [workspacePackage.root, workspacePackage]),
);
const workspacePackageByName = new Map(
  workspacePackages.map((workspacePackage) => [workspacePackage.name, workspacePackage]),
);
function workspacePackageForFile(rel) {
  const match = /^(packages\/[^/]+)\//u.exec(rel);
  return match ? workspacePackageByRoot.get(path.join(root, match[1])) : undefined;
}
const packageDirectoryName = (workspacePackage) => path.posix.basename(workspacePackage.root);
const packageGraph = new Map(workspacePackages.map((workspacePackage) => [workspacePackage.name, new Set()]));
for (const workspacePackage of workspacePackages) {
  const declared =
    JSON.parse(readFileSync(path.join(workspacePackage.root, "package.json"), "utf8")).dependencies ?? {};
  for (const dependency of Object.keys(declared))
    if (workspacePackageByName.has(dependency) && dependency !== workspacePackage.name)
      packageGraph.get(workspacePackage.name).add(dependency);
}
for (const edge of importEdges) {
  if (isTestOrFixturePath(edge.importer) || isTestOrFixturePath(edge.target)) continue;
  const importer = workspacePackageForFile(edge.importer),
    target = workspacePackageForFile(edge.target);
  if (!importer || !target || importer.name === target.name) continue;
  packageGraph.get(importer.name).add(target.name);
}
const packageNames = [...packageGraph.keys()];
const packageAdjacency = new Map(packageNames.map((name) => [name, [...packageGraph.get(name)]]));
for (const component of stronglyConnectedComponents(packageNames, packageAdjacency)) {
  if (component.length < 2) continue;
  record(
    path.join(root, workspacePackageByName.get(component[0]).root),
    `workspace package dependency cycle: ${component.sort().join(" -> ")} -> ${component.sort()[0]}`,
  );
}
const deliveryLeaves = new Set(["cli", "gui"]);
const daemonPackage = "daemon";
for (const [importer, targets] of packageGraph) {
  for (const target of targets) {
    const importerDirectory = packageDirectoryName(workspacePackageByName.get(importer)),
      targetDirectory = packageDirectoryName(workspacePackageByName.get(target));
    if (deliveryLeaves.has(targetDirectory))
      record(
        path.join(root, workspacePackageByName.get(importer).root),
        `workspace package ${importerDirectory} must not depend on delivery package ${targetDirectory}`,
      );
    if (targetDirectory === daemonPackage && !deliveryLeaves.has(importerDirectory))
      record(
        path.join(root, workspacePackageByName.get(importer).root),
        `workspace package ${importerDirectory} must not depend on the daemon composition root ${targetDirectory}`,
      );
  }
}

if (violations.length > 0) {
  console.error("Import boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Import boundary check passed.");
