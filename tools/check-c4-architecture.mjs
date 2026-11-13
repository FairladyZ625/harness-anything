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

const architecturePackages = [
  { id: "kernel", root: "packages/kernel", packageName: "@harness-anything/kernel" },
  { id: "application", root: "packages/application", packageName: "@harness-anything/application" },
  { id: "preset", root: "packages/preset", packageName: "@harness-anything/preset" },
  { id: "cli", root: "packages/cli", packageName: "@harness-anything/cli" },
  { id: "daemon", root: "packages/daemon", packageName: "@harness-anything/daemon" },
  { id: "gui", root: "packages/gui", packageName: "@harness-anything/gui" },
  { id: "storage", root: "packages/storage", packageName: "@harness-anything/storage" },
  { id: "adapter-local", root: "packages/adapters/local", packageName: "@harness-anything/adapter-local" },
  {
    id: "adapter-multica",
    root: "packages/adapters/multica",
    packageName: "@harness-anything/adapter-multica",
  },
];

// dec_89D06D7360CBEC09795F7B12EC CH1/C4: keep public package intent deterministic without private harness data.
const packageRelations = [
  ["cli", "daemon", "allowed"],
  ["gui", "daemon", "allowed"],
  ["gui", "application", "allowed"],
  ["gui", "kernel", "allowed"],
  ["daemon", "kernel", "allowed"],
  ["daemon", "preset", "allowed"],
  ["daemon", "application", "allowed"],
  ["daemon", "adapter-local", "allowed"],
  ["daemon", "adapter-multica", "allowed"],
  ["application", "kernel", "allowed"],
  ["preset", "kernel", "allowed"],
  ["cli", "kernel", "forbidden"],
  ["cli", "application", "forbidden"],
  ["daemon", "gui", "forbidden"],
  ["kernel", "daemon", "forbidden"],
  ["kernel", "cli", "forbidden"],
  ["storage", "kernel", "allowed"],
  ["daemon", "storage", "allowed"],
  ["kernel", "storage", "forbidden"],
];

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

function addSpecifier(imports, sourceFile, moduleSpecifier, kind) {
  if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) return;
  const { line } = sourceFile.getLineAndCharacterOfPosition(moduleSpecifier.getStart(sourceFile));
  imports.push({ specifier: moduleSpecifier.text, line: line + 1, kind });
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
      addSpecifier(imports, sourceFile, node.argument.literal, "import-type");
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
      if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
      await walk(absolute, visitor);
    } else if (entry.isFile()) {
      await visitor(absolute);
    }
  }
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
        packages.push({ name: packageJson.name, root: path.dirname(relative), exports: packageJson.exports });
    }
  });
  const sourceFiles = files.filter(
    (file) =>
      sourceExtensions.has(path.extname(file)) &&
      packages.some(({ root: packageRoot }) => file.startsWith(`${packageRoot}/src/`)),
  );
  const packageEntries = packages.map((workspacePackage) => {
    const authored = architecturePackages.find(
      (item) => item.packageName === workspacePackage.name || item.root === workspacePackage.root,
    );
    return authored
      ? { ...authored, root: workspacePackage.root, modeled: true }
      : {
          id: `unmodeled:${workspacePackage.name}`,
          packageName: workspacePackage.name,
          root: workspacePackage.root,
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

function resolveExportTargets(workspacePackage, specifier, kind) {
  const segments = specifier.split("/");
  const packageNameLength = workspacePackage.name.startsWith("@") ? 2 : 1;
  const packagePath = segments.slice(packageNameLength).join("/");
  const exportKey = packagePath ? `./${packagePath}` : ".";
  const exports = workspacePackage.exports;
  const conditions = new Set(["node", "node-addons", kind === "require" ? "require" : "import"]);
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

function resolveTarget(importer, specifier, root, workspace, kind = "import") {
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
    for (const target of resolveExportTargets(workspacePackage, specifier, kind)) {
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
  if (node === "adapterLocal") return "adapter-local";
  if (node === "adapterMultica") return "adapter-multica";
  return architecturePackages.some(({ id }) => id === node) ? node : null;
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

async function findModels(root) {
  const paths = [
    path.join(root, "harness/context/architecture/model/model.c4"),
    path.join(root, ".harness/ledger-files/context/architecture/model/model.c4"),
  ];
  const models = [];
  for (const absolute of paths) {
    try {
      models.push({ path: normalizeRelative(path.relative(root, absolute)), text: await readFile(absolute, "utf8") });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return models;
}

export async function checkArchitecture(root = process.cwd()) {
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
    const sourcePlane = planeForPath(file);
    if (sourcePackage?.id === "daemon" && file.startsWith("packages/daemon/src/") && !sourcePlane)
      violations.push(`${file}: daemon source file must be assigned to one of ${planeOrder.join(", ")}`);
    for (const imported of imports) {
      const target = resolveTarget(file, imported.specifier, absoluteRoot, workspace, imported.kind);
      const targetPackage = resolveWorkspaceTargetPackage(file, imported.specifier, absoluteRoot, workspace);
      const targetPlane = targetPackage?.id === "daemon" && target ? planeForPath(target) : null;
      if (sourcePackage && targetPackage && sourcePackage.id !== targetPackage.id) {
        checkedImports += 1;
        const expectation = expectedRelations.get(relationKey(sourcePackage.id, targetPackage.id));
        if (expectation !== "allowed") {
          const label = expectation === "forbidden" ? "is forbidden" : "has no canonical allowed relation";
          violations.push(
            `${file}:${imported.line}: ${sourcePackage.id} -> ${targetPackage.id} ${label} (${imported.kind} ${imported.specifier})`,
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

  const models = await findModels(absoluteRoot);
  for (const model of models) violations.push(...compareModel(model.text, model.path));
  violations.sort((left, right) => left.localeCompare(right));
  return {
    ok: violations.length === 0,
    violations,
    sourceFiles: workspace.sourceFiles.length,
    checkedImports,
    model: { status: models.length ? "checked" : "not-present", paths: models.map(({ path: modelPath }) => modelPath) },
  };
}

function printHelp() {
  console.log("Usage: node tools/check-c4-architecture.mjs [--explain <file>] [--json]");
}

async function main(args) {
  const json = args.includes("--json");
  const explainIndex = args.indexOf("--explain");
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  if (explainIndex >= 0) {
    const file = args[explainIndex + 1];
    if (!file || file.startsWith("--")) throw new Error("--explain requires a file path");
    const normalized = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file;
    const workspace = await loadWorkspace(process.cwd());
    const explanation = explainFile(normalized, workspace.packageEntries);
    if (json) console.log(JSON.stringify(explanation, null, 2));
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

  const result = await checkArchitecture(process.cwd());
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) {
    console.log(
      `C4 architecture check passed: ${result.sourceFiles} source files, ${result.checkedImports} architectural imports; model ${result.model.status}.`,
    );
  } else {
    console.error("C4 architecture violations:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    console.error(
      `Checked ${result.checkedImports} architectural imports across ${result.sourceFiles} source files; model ${result.model.status}.`,
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
