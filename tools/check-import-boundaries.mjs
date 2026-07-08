import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { entryValues, loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";

const root = process.cwd();
const sourceRoots = [path.join(root, "packages")];
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const violations = [];
const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const oldRuntimePattern = /scripts\/(?:kernel\/task|lib\/task-)|(?:^|\/)(?:states|policies)\.mts$|TaskBinding/;
const allowlist = loadGateAllowlist("check-import-boundaries", {
  requiredSections: ["guiAdapterCompositionRoots", "cliAdapterCompositionRoots", "kernelStoreCompositionRoots", "cliAdapterKnownDebt"]
});
const guiAdapterCompositionRoots = new Set(entryValues(allowlist.guiAdapterCompositionRoots));
const cliAdapterCompositionRoots = new Set(entryValues(allowlist.cliAdapterCompositionRoots));
const kernelStoreCompositionRoots = new Set(entryValues(allowlist.kernelStoreCompositionRoots));
const cliAdapterKnownDebt = new Set(entryValues(allowlist.cliAdapterKnownDebt));

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
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out" || entry.name === "build-resources") continue;
      files.push(...await walk(full));
    } else if (sourceFile.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function record(file, reason) {
  violations.push(`${relative(file)}: ${reason}`);
}

function resolveImport(file, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  const resolved = path.normalize(path.join(path.dirname(file), specifier));
  return relative(resolved);
}

function resolveImportFile(file, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return null;
  const base = path.normalize(path.join(path.dirname(file), specifier));
  const baseRel = relative(base);
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
    `${baseRel}/index.mjs`
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
      statement: match[0]
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
          importedNames: extractImportedNames(statement)
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
    const [left, right] = part.split(/\s+as\s+/u).map((value) => value.trim()).filter(Boolean);
    const name = mode === "exported" ? right ?? left : left;
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
  const declarationPattern = /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gu;
  for (const match of text.matchAll(declarationPattern)) names.add(match[1]);
  const namedExportPattern = /\bexport\s+\{([^}]*)\}(?:\s+from\b)?/gsu;
  for (const match of text.matchAll(namedExportPattern)) {
    for (const name of parseSpecifierListNames(match[1], "exported")) names.add(name);
  }
  return names;
}

function isTestOrFixturePath(rel) {
  return /(?:^|\/)(?:__fixtures__|fixtures|test|tests)\//.test(rel) || /\.test\.[cm]?[jt]s$/.test(rel);
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
    const hasRealConsumer = importEdges.some((edge) => {
      if (edge.target !== target || edge.importer === target) return false;
      if (isTestOrFixturePath(edge.importer)) return false;
      if (edge.importer === packageIndex && edge.kind === "reexport") return false;
      return edge.importer.startsWith("packages/") || edge.importer.startsWith("tools/");
    }) || importEdges.some((edge) => {
      if (edge.target !== packageIndex || isTestOrFixturePath(edge.importer)) return false;
      if (!edge.importer.startsWith("packages/") && !edge.importer.startsWith("tools/")) return false;
      if (edge.importer === target || edge.importer === packageIndex) return false;
      if (edge.importedNames === "namespace") return exportedNames.size > 0;
      if (!edge.importedNames) return false;
      return [...edge.importedNames].some((name) => exportedNames.has(name));
    });
    if (!hasRealConsumer) {
      record(path.join(root, target), "package source module is only re-exported from its package barrel; add @slice-activation with an owning slice or remove it from src");
    }
  }
}

const packageSourceFiles = (await Promise.all(sourceRoots.map((sourceRoot) => walk(sourceRoot)))).flat();
const toolSourceFiles = await walk(path.join(root, "tools"));
const knownImportFiles = new Set([...packageSourceFiles, ...toolSourceFiles].map(relative));
const importEdges = await collectImportEdges([...packageSourceFiles, ...toolSourceFiles], knownImportFiles);

for (const file of packageSourceFiles) {
    const text = await readFile(file, "utf8");
    const rel = relative(file);
    const isTestOrFixture = isTestOrFixturePath(rel);

    if (rel.startsWith("packages/kernel/src/domain/")) {
      if (/\bfrom\s+["'][^"']*(?:legacy|scripts\/kernel\/task)[^"']*["']/.test(text)) {
        record(file, "domain layer imports legacy runtime");
      }
    }

    const imports = [...text.matchAll(importPattern)].map((match) => match[1] ?? match[2] ?? match[3]);
    if (rel.startsWith("packages/kernel/src/domain/")) {
      for (const specifier of imports) {
        if (/^(?:node:)?(?:fs|process|child_process|path|os|crypto|sqlite|better-sqlite3)$/.test(specifier)) {
          record(file, `domain layer imports IO/runtime module via ${specifier}`);
        }
        if (importedPathViolates(file, specifier, (target) => /packages\/kernel\/src\/(?:ports|application|store)\//.test(target))) {
          record(file, `domain layer imports upper kernel layer via ${specifier}`);
        }
      }
    }

    if (rel.startsWith("packages/kernel/src/ports/")) {
      for (const specifier of imports) {
        if (importedPathViolates(file, specifier, (target) => /packages\/kernel\/src\/(?:application|store)\//.test(target) || /packages\/(?:cli|gui|adapters)\//.test(target) || /^@harness-anything\/(?:cli|gui|adapter-)/.test(target))) {
          record(file, `ports layer imports implementation/controller layer via ${specifier}`);
        }
      }
    }

    const isLocalAdapterCompositionRoot = rel === "packages/adapters/local/src/index.ts";
    const isKernelStoreCompositionRoot = kernelStoreCompositionRoots.has(rel);
    if (!isTestOrFixture && !isLocalAdapterCompositionRoot && !isKernelStoreCompositionRoot && !rel.startsWith("packages/kernel/src/store/")) {
      for (const specifier of imports) {
        if (importedPathViolates(file, specifier, (target) => /packages\/kernel\/src\/store\//.test(target))) {
          record(file, `store implementation is internal to WriteCoordinator and must not be imported via ${specifier}`);
        }
      }
    }

    if (rel.startsWith("packages/application/")) {
      for (const specifier of imports) {
        if (importedPathViolates(file, specifier, (target) => /packages\/kernel\/src\/store\//.test(target) || /packages\/(?:cli|gui|adapters)\//.test(target) || /^@harness-anything\/(?:cli|gui|adapter-)/.test(target))) {
          record(file, `application layer imports store/adapter/controller implementation via ${specifier}`);
        }
      }
    }

    if (rel.startsWith("packages/gui/")) {
      for (const specifier of imports) {
        if (importedPathViolates(file, specifier, (target) => {
          if (/packages\/kernel\/src\/store\//.test(target)) return true;
          if (/packages\/adapters\//.test(target) || /^@harness-anything\/adapter-/.test(target)) {
            return !guiAdapterCompositionRoots.has(rel);
          }
          return false;
        })) {
          record(file, `GUI imports store or external adapter implementation via ${specifier}`);
        }
      }
    }

    if (rel.startsWith("packages/cli/")) {
      for (const specifier of imports) {
        if (importedPathViolates(file, specifier, (target) => {
          if (/packages\/gui\//.test(target) || /packages\/kernel\/src\/store\//.test(target) || /^@harness-anything\/gui/.test(target)) return true;
          if (/packages\/adapters\//.test(target) || /^@harness-anything\/adapter-/.test(target)) {
            return !cliAdapterCompositionRoots.has(rel) && !cliAdapterKnownDebt.has(rel);
          }
          return false;
        })) {
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
}

await checkOrphanPackageModules(packageSourceFiles, importEdges);

if (violations.length > 0) {
  console.error("Import boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Import boundary check passed.");
