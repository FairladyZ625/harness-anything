import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const sourceCounterpartExtensions = new Map([
  [".js", ".ts"],
  [".jsx", ".tsx"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
]);

const authorizationPackage = {
  id: "authorization",
  c4Id: "authorization",
  root: "packages/authorization",
  packageName: "@harness-anything/authorization",
};

const architecturePackages = [
  { id: "kernel", c4Id: "kernel", root: "packages/kernel", packageName: "@harness-anything/kernel" },
  { id: "storage", c4Id: "storage", root: "packages/storage", packageName: "@harness-anything/storage" },
  {
    id: "application",
    c4Id: "application",
    root: "packages/application",
    packageName: "@harness-anything/application",
  },
  { id: "preset", c4Id: "preset", root: "packages/preset", packageName: "@harness-anything/preset" },
  authorizationPackage,
  { id: "dsh-plugin", c4Id: "dshPlugin", root: "packages/dsh-plugin", packageName: "@harness-anything/dsh-plugin" },
  { id: "daemon", c4Id: "daemon", root: "packages/daemon", packageName: "@harness-anything/daemon" },
  { id: "cli", c4Id: "cli", root: "packages/cli", packageName: "@harness-anything/cli" },
  { id: "gui", c4Id: "gui", root: "packages/gui", packageName: "@harness-anything/gui" },
  // dec_42EB7B8F636C12381A447E52A3/CH2: independent FDE visual domain builder & live simulator workspace.
  { id: "gui-fde", c4Id: "guiFde", root: "packages/gui-fde", packageName: "@harness-anything/gui-fde" },
];

// dec_04A9211B073F29F0FC1E1CA573 CH1/CH3/RJ2 & dec_7C93DEBCFB2D1A94C6FA07AAAD CH2:
// dec_5B243AC66763BD6D25B0DE2E86 CH1 & dec_42EB7B8F636C12381A447E52A3/CH2:
// ten-package C4 matrix (20 allowed, 70 forbidden; gui <-> gui-fde strictly forbidden).
const allowedPackageEdgeSet = new Set([
  "storage->kernel",
  "preset->kernel",
  "application->kernel",
  "authorization->kernel",
  "dsh-plugin->kernel",
  "daemon->kernel",
  "daemon->storage",
  "daemon->application",
  "daemon->preset",
  "daemon->authorization",
  "cli->daemon",
  "cli->kernel",
  "cli->preset",
  "gui->daemon",
  "gui->kernel",
  "gui->authorization",
  "gui-fde->daemon",
  "gui-fde->kernel",
  "gui-fde->preset",
  "gui-fde->authorization",
]);

const packageRelations = architecturePackages.flatMap(({ id: from }) =>
  architecturePackages
    .filter(({ id: to }) => to !== from)
    .map(({ id: to }) => [from, to, allowedPackageEdgeSet.has(`${from}->${to}`) ? "allowed" : "forbidden"]),
);

const modelNodeIdToPackageId = new Map([
  ...architecturePackages.map(({ c4Id, id }) => [c4Id, id]),
  ...architecturePackages.map(({ id }) => [id, id]),
]);

// CH2 lists the planes from the pure writer core out to the daemon composition root.
const planeOrder = ["writer-cell", "runtime-engine", "fleet-sync", "daemon-host"];
const planeRank = new Map(planeOrder.map((plane, index) => [plane, index]));
const allowedPackageTargets = new Map(
  architecturePackages.map(({ id }) => [
    id,
    packageRelations.filter(([from, , expectation]) => from === id && expectation === "allowed").map(([, to]) => to),
  ]),
);
const expectedRelations = new Map(packageRelations.map(([from, to, expectation]) => [`${from}->${to}`, expectation]));

function normalizeRelative(file) {
  return path.posix.normalize(file.split(path.sep).join("/")).replace(/^\.\//u, "");
}

function packageForPath(file, packages = architecturePackages) {
  const normalized = normalizeRelative(file);
  return (
    packages
      .filter(({ root }) => normalized === root || normalized.startsWith(`${root}/`))
      .sort((left, right) => right.root.length - left.root.length)[0] ?? null
  );
}

const packageRoot = `${authorizationPackage.root}/`;
const sourceRoot = `${packageRoot}src/`;
const sourceSlices = new Map([
  ["builtin", ["builtin"]],
  ["keycloak", ["keycloak"]],
  ["gui", ["gui"]],
  ["keycloak-gui", ["gui", "keycloak-gui"]],
]);
const hostSlices = {
  cli: [],
  daemon: ["builtin", "keycloak"],
  gui: ["gui", "keycloak-gui"],
  // dec_42EB7B8F636C12381A447E52A3/CH2: gui-fde shares desktop authorization slice boundaries.
  "gui-fde": ["gui", "keycloak-gui"],
};

// dec_5B243AC66763BD6D25B0DE2E86/CH1 & dec_42EB7B8F636C12381A447E52A3/CH2: keep package directions at their subpaths.
export function authorizationImportViolation(importer, specifier, resolved) {
  const sourceSlice = importer.startsWith(sourceRoot) ? importer.slice(sourceRoot.length).split("/")[0] : null;
  const host = /^packages\/(cli|daemon|gui-fde|gui)\/src\//u.exec(importer)?.[1];
  const allowed = sourceSlice ? (sourceSlices.get(sourceSlice) ?? []) : hostSlices[host];
  if (!allowed) return null;

  const { packageName } = authorizationPackage;
  const specifierSlice =
    specifier === packageName ? "" : specifier.startsWith(`${packageName}/`) ? specifier.split("/")[2] : null;
  const resolvedSlice = resolved?.startsWith(sourceRoot)
    ? resolved.slice(sourceRoot.length).split("/")[0]
    : resolved?.startsWith(packageRoot)
      ? ""
      : null;
  if (
    (specifierSlice !== null && !allowed.includes(specifierSlice)) ||
    (resolvedSlice !== null && !allowed.includes(resolvedSlice)) ||
    ((sourceSlice === "builtin" || sourceSlice === "keycloak") && /^react(?:\/|$)/u.test(specifier))
  )
    return `authorization boundary: ${sourceSlice ?? host} must not import ${specifier}`;

  return null;
}

function planeForPath(file) {
  const match = /^packages\/daemon\/src\/(writer-cell|runtime-engine|fleet-sync|daemon-host)(?:\/|$)/u.exec(
    normalizeRelative(file),
  );
  return match?.[1] ?? null;
}

function targetsForPackage(id, packages = architecturePackages) {
  const allowedTargets = allowedPackageTargets.get(id) ?? [];
  const forbiddenTargets = packages
    .map(({ id: target }) => target)
    .filter((target) => target !== id && !allowedTargets.includes(target));
  return { allowedTargets: [...allowedTargets].sort(), forbiddenTargets };
}

function targetsForPlane(id) {
  if (!id) return { allowedTargets: [], forbiddenTargets: [...planeOrder] };
  const rank = planeRank.get(id);
  return {
    allowedTargets: planeOrder.filter((target) => planeRank.get(target) <= rank),
    forbiddenTargets: planeOrder.filter((target) => planeRank.get(target) > rank),
  };
}

export function explainFile(file, packageEntries = architecturePackages) {
  const normalized = normalizeRelative(file);
  const sourcePackage = packageForPath(normalized, packageEntries);
  const planeId = planeForPath(normalized);
  const inDaemonSource = normalized.startsWith("packages/daemon/src/");
  const plane = {
    id: planeId,
    status: planeId ? "assigned" : inDaemonSource ? "legacy-unassigned" : "not-applicable",
    ...targetsForPlane(planeId),
  };
  return {
    file: normalized,
    package: sourcePackage
      ? {
          id: sourcePackage.modeled === false ? sourcePackage.packageName : sourcePackage.id,
          status: sourcePackage.modeled === false ? "unmodeled" : "modeled",
          ...targetsForPackage(sourcePackage.id, packageEntries),
        }
      : null,
    plane,
  };
}

function scriptKind(file) {
  if (/\.(?:jsx|tsx)$/u.test(file)) return ts.ScriptKind.TSX;
  if (/\.(?:js|mjs|cjs)$/u.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function resolutionModeFromAttributes(attributes) {
  const mode = attributes?.elements?.find(({ name }) => name.text === "resolution-mode")?.value?.text;
  return mode === "import" || mode === "require" ? mode : undefined;
}

function addSpecifier(imports, sourceFile, moduleSpecifier, kind, resolutionMode) {
  if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) return;
  const { line } = sourceFile.getLineAndCharacterOfPosition(moduleSpecifier.getStart(sourceFile));
  imports.push({ specifier: moduleSpecifier.text, line: line + 1, kind, resolutionMode });
}

function importsFromSource(source, file) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const imports = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      addSpecifier(
        imports,
        sourceFile,
        statement.moduleSpecifier,
        ts.isImportDeclaration(statement)
          ? statement.importClause?.isTypeOnly
            ? "import-type"
            : "import"
          : statement.isTypeOnly
            ? "import-type"
            : "reexport",
        resolutionModeFromAttributes(statement.attributes),
      );
    } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      addSpecifier(imports, sourceFile, statement.moduleReference.expression, "require");
    }
  }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((dynamicImport || requireCall) && node.arguments.length > 0)
        addSpecifier(imports, sourceFile, node.arguments[0], dynamicImport ? "dynamic" : "require");
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addSpecifier(
        imports,
        sourceFile,
        node.argument.literal,
        "import-type",
        resolutionModeFromAttributes(node.attributes),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { imports, parseDiagnostics: sourceFile.parseDiagnostics };
}

async function walk(directory, visitor) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "node_modules", "app-node_modules", "dist", "dist-electron", "coverage"].includes(entry.name))
        continue;
      await walk(absolute, visitor);
    } else if (entry.isFile()) {
      await visitor(absolute);
    }
  }
}

function internalDependencyNames(section) {
  if (!section || typeof section !== "object") return [];
  return Object.keys(section)
    .filter((dependency) => dependency.startsWith("@harness-anything/"))
    .sort();
}

async function loadWorkspace(root) {
  const packages = [];
  const files = [];
  await walk(path.join(root, "packages"), async (absolute) => {
    const relative = normalizeRelative(path.relative(root, absolute));
    files.push(relative);
    if (path.posix.basename(relative) === "package.json") {
      const packageJson = JSON.parse(await readFile(absolute, "utf8"));
      if (typeof packageJson.name === "string")
        packages.push({
          name: packageJson.name,
          root: path.dirname(relative),
          exports: packageJson.exports,
          type: packageJson.type,
          private: packageJson.private === true,
          dependencies: internalDependencyNames(packageJson.dependencies),
          peerDependencies: internalDependencyNames(packageJson.peerDependencies),
          optionalDependencies: internalDependencyNames(packageJson.optionalDependencies),
          devDependencies: internalDependencyNames(packageJson.devDependencies),
        });
    }
  });
  const sourceFiles = files.filter(
    (file) =>
      sourceExtensions.has(path.extname(file)) &&
      packages.some(({ root: packageRoot }) => file.startsWith(`${packageRoot}/src/`)),
  );
  const packageEntries = packages.map((workspacePackage) => {
    const authored = architecturePackages.find(
      (item) => item.packageName === workspacePackage.name && item.root === workspacePackage.root,
    );
    return authored
      ? { ...authored, root: workspacePackage.root, private: workspacePackage.private, modeled: true }
      : {
          id: `unmodeled:${workspacePackage.name}`,
          packageName: workspacePackage.name,
          root: workspacePackage.root,
          private: workspacePackage.private,
          modeled: false,
        };
  });
  return {
    packages,
    packageEntries,
    sourceFiles: sourceFiles.sort(),
    sourceFileSet: new Set(sourceFiles),
    packagesByName: new Map(packages.map((item) => [item.name, item])),
  };
}

function sourceFileForTarget(target, packageRoot, root, workspace) {
  if (typeof target !== "string" || !target.startsWith("./")) return null;
  const absolutePackageRoot = path.resolve(root, packageRoot);
  const absolute = path.resolve(absolutePackageRoot, target);
  if (absolute !== absolutePackageRoot && !absolute.startsWith(`${absolutePackageRoot}${path.sep}`)) return null;
  const candidates = [absolute];
  const extension = path.extname(absolute);
  const sourceExtension = sourceCounterpartExtensions.get(extension);
  if (sourceExtension) candidates.push(`${absolute.slice(0, -extension.length)}${sourceExtension}`);
  for (const candidate of candidates) {
    const relative = normalizeRelative(path.relative(root, candidate));
    if (workspace.sourceFileSet.has(relative)) return relative;
  }
  return null;
}

function exportTargets(entry, conditions) {
  if (typeof entry === "string") return [entry];
  if (Array.isArray(entry)) return entry.flatMap((target) => exportTargets(target, conditions));
  if (!entry || typeof entry !== "object") return [];
  for (const [condition, target] of Object.entries(entry)) {
    if (condition !== "default" && !conditions.has(condition)) continue;
    const targets = exportTargets(target, conditions);
    if (targets.length > 0) return targets;
  }
  return [];
}

function wildcardCapture(value, pattern) {
  const marker = pattern.indexOf("*");
  if (marker < 0) return value === pattern ? "" : null;
  const prefix = pattern.slice(0, marker);
  const suffix = pattern.slice(marker + 1);
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  return value.slice(prefix.length, value.length - suffix.length);
}

function resolveExportTargets(workspacePackage, specifier, kind, resolutionMode) {
  const segments = specifier.split("/");
  const packageNameLength = workspacePackage.name.startsWith("@") ? 2 : 1;
  const packagePath = segments.slice(packageNameLength).join("/");
  const exportKey = packagePath ? `./${packagePath}` : ".";
  const exports = workspacePackage.exports;
  const conditions = new Set(["node", "node-addons", resolutionMode ?? (kind === "require" ? "require" : "import")]);
  if (kind === "import-type") conditions.add("types");
  if (typeof exports === "string" || Array.isArray(exports))
    return exportKey === "." ? exportTargets(exports, conditions) : [];
  if (!exports || typeof exports !== "object") return [];

  const hasSubpathKeys = Object.keys(exports).some((key) => key.startsWith("."));
  let entry = hasSubpathKeys ? exports[exportKey] : exportKey === "." ? exports : undefined;
  let capture = "";
  if (entry === undefined && hasSubpathKeys) {
    const match = Object.keys(exports)
      .map((key) => ({ key, capture: wildcardCapture(exportKey, key) }))
      .filter(({ key, capture: value }) => key.includes("*") && value !== null)
      .sort((left, right) => right.key.indexOf("*") - left.key.indexOf("*") || right.key.length - left.key.length)[0];
    if (match) {
      entry = exports[match.key];
      capture = match.capture;
    }
  }
  return exportTargets(entry, conditions).map((target) => target.replaceAll("*", capture));
}

function defaultNodeResolutionMode(importer, workspace) {
  const extension = path.extname(importer);
  if ([".mts", ".mjs"].includes(extension)) return "import";
  if ([".cts", ".cjs"].includes(extension)) return "require";
  const importerPackage = packageForPath(importer, workspace.packages);
  return importerPackage?.type === "module" ? "import" : "require";
}

function resolveTarget(importer, specifier, root, workspace, kind = "import", resolutionMode) {
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(root, path.dirname(importer), specifier);
    for (const candidate of [resolved, ...[...sourceExtensions].map((extension) => `${resolved}${extension}`)]) {
      if (workspace.sourceFileSet.has(normalizeRelative(path.relative(root, candidate))))
        return normalizeRelative(path.relative(root, candidate));
    }
    for (const extension of sourceExtensions) {
      const indexFile = normalizeRelative(path.relative(root, path.join(resolved, `index${extension}`)));
      if (workspace.sourceFileSet.has(indexFile)) return indexFile;
    }
    return normalizeRelative(path.relative(root, resolved));
  }
  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  const workspacePackage = workspace.packagesByName.get(packageName);
  if (workspacePackage) {
    const mode = ["import", "reexport", "import-type"].includes(kind)
      ? (resolutionMode ?? defaultNodeResolutionMode(importer, workspace))
      : undefined;
    for (const target of resolveExportTargets(workspacePackage, specifier, kind, mode)) {
      const sourceFile = sourceFileForTarget(target, workspacePackage.root, root, workspace);
      if (sourceFile) return sourceFile;
    }
  }
  return null;
}

function resolveWorkspaceTargetPackage(importer, specifier, root, workspace) {
  if (specifier.startsWith(".")) {
    const target = resolveTarget(importer, specifier, root, workspace);
    return packageForPath(target, workspace.packageEntries);
  }
  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  const workspacePackage = workspace.packagesByName.get(packageName);
  if (!workspacePackage) return null;
  return packageForPath(workspacePackage.root, workspace.packageEntries);
}

function relationKey(from, to) {
  return `${from}->${to}`;
}

function nodePackageId(node) {
  return modelNodeIdToPackageId.get(node) ?? null;
}

function readModelRelations(modelText) {
  const lines = modelText.split(/\r?\n/u);
  const relations = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^ {2}([A-Za-z_$][\w$]*)\s*->\s*([A-Za-z_$][\w$]*)\s+/u.exec(lines[index]);
    if (!header) continue;
    const block = [];
    while (index < lines.length) {
      block.push(lines[index]);
      if (index > 0 && lines[index] === "  }") break;
      index += 1;
    }
    const body = block.join("\n");
    const from = nodePackageId(header[1]);
    const to = nodePackageId(header[2]);
    const archId = /\barchId\s+'(relation\.code\.[^']+)'/u.exec(body)?.[1];
    if (!archId && (!from || !to)) continue;
    const expectation = /\bexpectation\s+'(allowed|forbidden)'/u.exec(body)?.[1] ?? null;
    const importsExtractor = /\bextractorIds\s+\[[^\]]*'js-ts-imports'/u.test(body);
    relations.push({ archId: archId ?? "<missing archId>", from, to, expectation, importsExtractor });
  }
  return relations;
}

function stripModelComments(modelText) {
  let result = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < modelText.length; index += 1) {
    const current = modelText[index];
    const next = modelText[index + 1];
    if (quote) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      result += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < modelText.length && modelText[index] !== "\n") index += 1;
      if (index < modelText.length) result += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      const end = modelText.indexOf("*/", index + 2);
      if (end < 0) throw new Error("unterminated block comment");
      result += modelText.slice(index, end + 2).replace(/[^\n]/gu, " ");
      index = end + 1;
      continue;
    }
    result += current;
  }
  return result;
}

function compareModel(modelText, modelPath) {
  let activeModelText;
  try {
    activeModelText = stripModelComments(modelText);
  } catch (error) {
    return [`${modelPath}: ${error.message}`];
  }
  const relations = readModelRelations(activeModelText);
  const violations = [];
  const actual = new Map();
  const parsedRelationIds = new Set(relations.map(({ archId }) => archId));
  for (const [, archId] of activeModelText.matchAll(/\barchId\s+'(relation\.code\.[^']+)'/gu))
    if (!parsedRelationIds.has(archId))
      violations.push(`${modelPath}: ${archId} could not be parsed as a package import relation`);
  for (const relation of relations) {
    if (!relation.from || !relation.to) {
      violations.push(`${modelPath}: ${relation.archId} references an unmapped package node`);
      continue;
    }
    const key = relationKey(relation.from, relation.to);
    if (actual.has(key)) violations.push(`${modelPath}: duplicate package import relation ${key}`);
    actual.set(key, relation);
  }
  for (const [key, expectation] of expectedRelations) {
    const relation = actual.get(key);
    if (!relation) {
      violations.push(`${modelPath}: model.c4 import relations differ: missing ${key} (${expectation})`);
      continue;
    }
    const forbiddenSuffix = expectation === "forbidden" ? "-forbidden" : "";
    const expectedArchId = `relation.code.${key.replace("->", "-")}${forbiddenSuffix}`;
    if (relation.archId !== expectedArchId) violations.push(`${modelPath}: ${key} must use archId '${expectedArchId}'`);
    if (relation.expectation !== expectation)
      violations.push(
        `${modelPath}: ${relation.archId} expects ${relation.expectation ?? "no expectation"}; canonical rule is ${expectation}`,
      );
    if (!relation.importsExtractor)
      violations.push(`${modelPath}: ${relation.archId} must declare extractorIds ['js-ts-imports']`);
  }
  for (const [key, relation] of actual)
    if (!expectedRelations.has(key))
      violations.push(
        `${modelPath}: model.c4 import relations differ: unexpected ${key} (${relation.expectation ?? "no expectation"})`,
      );
  return violations;
}

async function readOptionalModel(root, absolute) {
  try {
    return { path: normalizeRelative(path.relative(root, absolute)), text: await readFile(absolute, "utf8") };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
}

async function findModels(root, explicitModelPath) {
  if (explicitModelPath) {
    const absolute = path.isAbsolute(explicitModelPath) ? explicitModelPath : path.resolve(root, explicitModelPath);
    const loaded = await readOptionalModel(root, absolute);
    return loaded
      ? { models: [loaded], missingExplicitPath: null }
      : { models: [], missingExplicitPath: explicitModelPath };
  }

  const localModel = path.join(root, "harness/context/architecture/model/model.c4");
  const ledgerModel = path.join(root, ".harness/ledger-files/context/architecture/model/model.c4");
  const isWorktree = path.basename(path.dirname(root)) === ".worktrees";
  const worktreeMainModel = isWorktree ? path.resolve(root, "../../harness/context/architecture/model/model.c4") : null;

  const candidates = isWorktree ? [localModel, worktreeMainModel] : [localModel, ledgerModel];
  const models = [];
  for (const absolute of candidates) {
    if (!absolute) continue;
    const loaded = await readOptionalModel(root, absolute);
    if (loaded) models.push(loaded);
  }
  if (isWorktree && models.length === 0) {
    const fallback = await readOptionalModel(root, ledgerModel);
    if (fallback) models.push(fallback);
  }
  return { models, missingExplicitPath: null };
}

function internalPackageName(specifier) {
  if (!specifier.startsWith("@harness-anything/")) return null;
  const segments = specifier.split("/");
  return segments.slice(0, 2).join("/");
}

function manifestSatisfiesImport(sourceManifest, targetPackage) {
  if (!sourceManifest) return false;
  if (
    sourceManifest.dependencies.includes(targetPackage.packageName) ||
    sourceManifest.peerDependencies.includes(targetPackage.packageName) ||
    sourceManifest.optionalDependencies.includes(targetPackage.packageName)
  ) {
    return true;
  }
  // Public workspaces bundle private workspaces via devDependencies because public-workspaces
  // forbids private packages in runtime dependencies/peerDependencies.
  return (
    !sourceManifest.private &&
    targetPackage.private === true &&
    sourceManifest.devDependencies.includes(targetPackage.packageName)
  );
}

function checkManifestDependencies(workspace, importedBySource) {
  const violations = [];
  const entriesByPackageName = new Map(workspace.packageEntries.map((entry) => [entry.packageName, entry]));
  for (const sourceEntry of workspace.packageEntries) {
    const manifest = workspace.packagesByName.get(sourceEntry.packageName);
    if (!manifest) continue;
    const importedTargets = importedBySource.get(sourceEntry.id) ?? new Set();
    for (const [section, names] of [
      ["dependencies", manifest.dependencies],
      ["peerDependencies", manifest.peerDependencies],
      ["optionalDependencies", manifest.optionalDependencies],
    ]) {
      for (const depName of names) {
        if (depName === sourceEntry.packageName) {
          violations.push(`${sourceEntry.root}/package.json: ${section}.${depName} cannot reference itself`);
          continue;
        }
        const targetEntry = entriesByPackageName.get(depName);
        if (!targetEntry) {
          violations.push(
            `${sourceEntry.root}/package.json: ${section}.${depName} references missing workspace package`,
          );
          continue;
        }
        if (sourceEntry.modeled === false || targetEntry.modeled === false) continue;
        const expectation = expectedRelations.get(relationKey(sourceEntry.id, targetEntry.id));
        if (expectation !== "allowed") {
          violations.push(
            `${sourceEntry.root}/package.json: ${section}.${depName} (${sourceEntry.id} -> ${targetEntry.id}) is forbidden by C4 rules`,
          );
          continue;
        }
        if (!sourceEntry.private && targetEntry.private) {
          violations.push(
            `${sourceEntry.root}/package.json: public package must not declare private ${depName} in ${section}`,
          );
          continue;
        }
        if (!importedTargets.has(targetEntry.id)) {
          violations.push(
            `${sourceEntry.root}/package.json: ${section}.${depName} is a ghost internal dependency (0 imports in ${sourceEntry.root}/src)`,
          );
        }
      }
    }
    for (const depName of manifest.devDependencies) {
      if (depName === sourceEntry.packageName) {
        violations.push(`${sourceEntry.root}/package.json: devDependencies.${depName} cannot reference itself`);
        continue;
      }
      const targetEntry = entriesByPackageName.get(depName);
      if (!targetEntry) {
        violations.push(
          `${sourceEntry.root}/package.json: devDependencies.${depName} references missing workspace package`,
        );
        continue;
      }
      if (sourceEntry.modeled === false || targetEntry.modeled === false) continue;
      if (!sourceEntry.private && targetEntry.private) {
        const expectation = expectedRelations.get(relationKey(sourceEntry.id, targetEntry.id));
        if (expectation !== "allowed") {
          violations.push(
            `${sourceEntry.root}/package.json: devDependencies.${depName} (${sourceEntry.id} -> ${targetEntry.id}) is forbidden by C4 rules`,
          );
        } else if (!importedTargets.has(targetEntry.id)) {
          violations.push(
            `${sourceEntry.root}/package.json: devDependencies.${depName} is a ghost internal dependency (0 imports in ${sourceEntry.root}/src)`,
          );
        }
      }
    }
  }
  return violations;
}

/** dec_04A9211B073F29F0FC1E1CA573 CH3: package and plane checks are inseparable. */
export async function checkArchitecture(root = process.cwd(), options = {}) {
  if ("scope" in options) throw new Error("--scope was retired; all package and daemon plane boundaries are mandatory");
  const absoluteRoot = path.resolve(root);
  const workspace = await loadWorkspace(absoluteRoot);
  const violations = [];
  let checkedImports = 0;
  if (workspace.sourceFiles.length === 0) violations.push("packages/: no workspace source files found");
  for (const workspacePackage of workspace.packageEntries) {
    if (workspacePackage.modeled === false)
      violations.push(
        `${workspacePackage.root}: workspace package ${workspacePackage.packageName} has no canonical architecture endpoint`,
      );
  }
  if (workspace.packages.length > 0) {
    const discoveredKeys = new Set(workspace.packages.map((item) => `${item.name}@${item.root}`));
    for (const expected of architecturePackages) {
      if (!discoveredKeys.has(`${expected.packageName}@${expected.root}`)) {
        violations.push(
          `${expected.root}/package.json: modeled workspace package ${expected.packageName} is missing from packages/`,
        );
      }
    }
  }

  const importedBySource = new Map();
  for (const file of workspace.sourceFiles) {
    const { imports, parseDiagnostics } = importsFromSource(
      await readFile(path.join(absoluteRoot, file), "utf8"),
      file,
    );
    for (const diagnostic of parseDiagnostics) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      violations.push(`${file}:${line + 1}:${character + 1}: TypeScript AST parse error: ${message}`);
    }
    const sourcePackage = packageForPath(file, workspace.packageEntries);
    const sourceManifest = sourcePackage ? workspace.packagesByName.get(sourcePackage.packageName) : null;
    const sourcePlane = planeForPath(file);
    if (sourcePackage?.id === "daemon" && file.startsWith("packages/daemon/src/") && !sourcePlane)
      violations.push(`${file}: daemon source file must be assigned to one of ${planeOrder.join(", ")}`);
    for (const imported of imports) {
      const internalName = internalPackageName(imported.specifier);
      if (internalName && !workspace.packagesByName.has(internalName)) {
        violations.push(
          `${file}:${imported.line}: ${sourcePackage?.packageName ?? file} imports unknown workspace package ${internalName}`,
        );
        continue;
      }
      const target = resolveTarget(
        file,
        imported.specifier,
        absoluteRoot,
        workspace,
        imported.kind,
        imported.resolutionMode,
      );
      const targetPackage = resolveWorkspaceTargetPackage(file, imported.specifier, absoluteRoot, workspace);
      const authorizationViolation = authorizationImportViolation(file, imported.specifier, target);
      if (authorizationViolation) violations.push(`${file}:${imported.line}: ${authorizationViolation}`);
      const targetPlane = targetPackage?.id === "daemon" && target ? planeForPath(target) : null;
      if (sourcePackage && targetPackage && sourcePackage.id !== targetPackage.id) {
        checkedImports += 1;
        let targets = importedBySource.get(sourcePackage.id);
        if (!targets) {
          targets = new Set();
          importedBySource.set(sourcePackage.id, targets);
        }
        targets.add(targetPackage.id);
        const expectation = expectedRelations.get(relationKey(sourcePackage.id, targetPackage.id));
        if (expectation !== "allowed") {
          const label = expectation === "forbidden" ? "is forbidden" : "has no canonical allowed relation";
          violations.push(
            `${file}:${imported.line}: ${sourcePackage.id} -> ${targetPackage.id} ${label} (${imported.kind} ${imported.specifier})`,
          );
        } else if (
          sourcePackage.modeled !== false &&
          targetPackage.modeled !== false &&
          !manifestSatisfiesImport(sourceManifest, targetPackage)
        ) {
          const expectedField =
            !sourceManifest?.private && targetPackage.private ? "devDependencies" : "dependencies/peerDependencies";
          violations.push(
            `${file}:${imported.line}: ${sourcePackage.packageName} imports ${targetPackage.packageName} (${imported.specifier}) without declaring it in ${sourcePackage.root}/package.json ${expectedField}`,
          );
        }
      }
      if (sourcePlane && targetPlane) {
        checkedImports += 1;
        if (planeRank.get(targetPlane) > planeRank.get(sourcePlane))
          violations.push(
            `${file}:${imported.line}: ${sourcePlane} -> ${targetPlane} is forbidden (${imported.kind} ${imported.specifier})`,
          );
      } else if (sourcePlane && targetPackage?.id === "daemon") {
        checkedImports += 1;
        const reason = target
          ? "imports an unassigned daemon source file"
          : "cannot resolve daemon workspace export to an assigned source file";
        violations.push(`${file}:${imported.line}: ${sourcePlane} ${reason} (${imported.kind} ${imported.specifier})`);
      }
    }
  }

  violations.push(...checkManifestDependencies(workspace, importedBySource));

  const { models, missingExplicitPath } = await findModels(absoluteRoot, options.modelPath);
  if (missingExplicitPath) violations.push(`${missingExplicitPath}: model.c4 not found`);
  for (const model of models) violations.push(...compareModel(model.text, model.path));
  violations.sort((left, right) => left.localeCompare(right));
  return {
    ok: violations.length === 0,
    scope: "all",
    violations,
    sourceFiles: workspace.sourceFiles.length,
    checkedImports,
    model: { status: models.length ? "checked" : "not-present", paths: models.map(({ path: modelPath }) => modelPath) },
  };
}

function printHelp() {
  console.log("Usage: node tools/check-c4-architecture.mjs [--model <path>] [--explain <file>] [--json]");
}

function parseCliOptions(args) {
  const options = { json: false, help: false, modelPath: null, explainFile: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--explain") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--explain requires a file path");
      options.explainFile = value;
    } else if (arg === "--model") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--model requires a path");
      options.modelPath = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(args) {
  const cli = parseCliOptions(args);
  if (cli.help) {
    printHelp();
    return 0;
  }
  if (cli.explainFile) {
    const normalized = path.isAbsolute(cli.explainFile)
      ? path.relative(process.cwd(), cli.explainFile)
      : cli.explainFile;
    const workspace = await loadWorkspace(process.cwd());
    const explanation = explainFile(normalized, workspace.packageEntries);
    if (cli.json) console.log(JSON.stringify(explanation, null, 2));
    else {
      console.log(`${explanation.file}`);
      console.log(
        `package: ${explanation.package ? `${explanation.package.id} (${explanation.package.status})` : "unassigned"}`,
      );
      if (explanation.package) {
        console.log(`allowed package targets: ${explanation.package.allowedTargets.join(", ") || "none"}`);
        console.log(`forbidden package targets: ${explanation.package.forbiddenTargets.join(", ") || "none"}`);
      }
      console.log(`daemon plane: ${explanation.plane.id ?? explanation.plane.status}`);
      console.log(`allowed plane targets: ${explanation.plane.allowedTargets.join(", ") || "none"}`);
      console.log(`forbidden plane targets: ${explanation.plane.forbiddenTargets.join(", ") || "none"}`);
    }
    return 0;
  }

  const result = await checkArchitecture(process.cwd(), { modelPath: cli.modelPath });
  if (cli.json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) {
    console.log(
      `C4 architecture check passed (${result.scope}): ${result.sourceFiles} source files, ${result.checkedImports} architectural imports; model ${result.model.status}.`,
    );
  } else {
    console.error("C4 architecture violations:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    console.error(
      `Checked ${result.checkedImports} architectural imports across ${result.sourceFiles} source files (scope=${result.scope}); model ${result.model.status}.`,
    );
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
