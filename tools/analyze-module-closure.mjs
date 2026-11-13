#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { builtinModules, stripTypeScriptTypes } from "node:module";
import { initSync, parse as parseEsm } from "es-module-lexer";
import { tokenizer } from "acorn";
import ts from "typescript";

initSync();

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/u;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const FORBIDDEN_BUILTINS = new Set(["node:child_process", "node:http", "node:https", "node:net", "node:tls"]);
const AUTHORIZATION_PACKAGE = "@harness-anything/authorization-keycloak";
const WORKER_PATH = "packages/daemon/src/repo-writer-worker.ts";
const SUPERVISOR_PATH = "packages/daemon/src/writer-supervisor.ts";
const packageJsonCache = new Map();
const packageRootCache = new Map();
const existenceCache = new Map();
const realpathCache = new Map();
const importResolutionCache = new Map();
const resolutionOptions = {
  allowImportingTsExtensions: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  resolveJsonModule: true,
  target: ts.ScriptTarget.ESNext,
};
let tsResolutionCache;

function fileExists(fileName) {
  if (!existenceCache.has(fileName)) existenceCache.set(fileName, existsSync(fileName));
  return existenceCache.get(fileName);
}

function canonicalPath(fileName) {
  if (!realpathCache.has(fileName)) realpathCache.set(fileName, realpathSync.native(fileName));
  return realpathCache.get(fileName);
}

export function analyzeModuleClosure({ root = process.cwd(), entry = WORKER_PATH } = {}) {
  const startedAt = performance.now();
  existenceCache.clear();
  realpathCache.clear();
  importResolutionCache.clear();
  root = realpathSync(path.resolve(root));
  tsResolutionCache = ts.createModuleResolutionCache(root, (fileName) => fileName, resolutionOptions);
  packageJsonCache.clear();
  packageRootCache.clear();
  const workspacePackages = loadWorkspacePackages(root);
  const entryPath = realpathSync(path.resolve(root, entry));
  if (!isWithin(root, entryPath)) throw new Error(`entry must be inside root: ${entry}`);
  if (!isSourceFile(entryPath)) throw new Error(`entry is not an ESM/TS source file: ${entry}`);

  const entryId = entryPath;
  const nodes = new Map([[entryId, makeFileNode(entryPath, root)]]);
  const edges = [];
  const unresolvedImports = [];
  const pending = [entryId];

  while (pending.length > 0) {
    const from = pending.pop();
    const node = nodes.get(from);
    const source = readFileSync(node.filePath, "utf8");
    const imports = sourceImports(source, node.filePath);
    for (const imported of imports) {
      const resolved = resolveImport(imported.specifier, node.filePath, workspacePackages, imported.kind);
      const target = resolved.filePath ? makeFileNode(resolved.filePath, root) : makeExternalNode(resolved.id);
      if (!nodes.has(target.id)) {
        nodes.set(target.id, target);
        if (target.sourceBearing) pending.push(target.id);
      }
      const edge = {
        from,
        to: target.id,
        specifier: imported.specifier,
        line: imported.line,
        kind: imported.kind,
        resolution: resolved.resolution,
      };
      edges.push(edge);
      if (resolved.resolution === "unresolved") {
        unresolvedImports.push({
          path: node.path,
          line: imported.line,
          specifier: imported.specifier,
        });
      }
    }
  }

  const dominators = computeDominators(nodes, edges, entryId);
  const forbiddenTargets = findForbiddenTargets(nodes, edges, entryId);
  const modules = [...nodes.values()]
    .filter((node) => node.sourceBearing)
    .map((node) => ({
      path: node.path,
      immediateDominator:
        dominators.idom.get(node.id) && dominators.idom.get(node.id) !== node.id
          ? nodes.get(dominators.idom.get(node.id)).path
          : null,
      retainedModules: dominators.retained.get(node.id) ?? 0,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const directImportPairs = new Set(edges.map((edge) => `${edge.from}\0${edge.to}`));
  const dominatorEdges = modules
    .filter((node) => node.immediateDominator !== null)
    .map((node) => ({
      from: node.immediateDominator,
      to: node.path,
      retainedModules: node.retainedModules,
      directImport: directImportPairs.has(
        `${path.resolve(root, node.immediateDominator)}\0${path.resolve(root, node.path)}`,
      ),
    }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  const displayEdges = edges
    .map((edge) => ({
      from: nodes.get(edge.from).path,
      to: nodes.get(edge.to).path,
      specifier: edge.specifier,
      line: edge.line,
      kind: edge.kind,
      resolution: edge.resolution,
    }))
    .sort(
      (left, right) => left.from.localeCompare(right.from) || left.line - right.line || left.to.localeCompare(right.to),
    );

  return {
    schema: "module-closure-analysis/v1",
    scope: "syntactic runtime imports, re-exports, literal dynamic imports and require calls; no module execution",
    root,
    entry: nodes.get(entryId).path,
    moduleCount: modules.length,
    edgeCount: edges.length,
    durationMs: Number((performance.now() - startedAt).toFixed(1)),
    modules,
    edges: displayEdges,
    dominatorEdges,
    forbiddenTargets,
    unresolvedImports: unresolvedImports.sort(
      (left, right) => left.path.localeCompare(right.path) || left.line - right.line,
    ),
  };
}

export function analyzeCapabilityBridge({
  root = process.cwd(),
  workerPath = WORKER_PATH,
  supervisorPath = SUPERVISOR_PATH,
} = {}) {
  root = realpathSync(path.resolve(root));
  const workerFile = realpathSync(path.resolve(root, workerPath));
  const supervisorFile = realpathSync(path.resolve(root, supervisorPath));
  const worker = parseSource(workerFile);
  const supervisor = parseSource(supervisorFile);
  const calls = [];
  const hostHandlers = new Map();
  let hasAsyncReplyMap = false;
  let asyncMapHasLookup = false;
  let asyncMapHasDelete = false;

  const visitWorker = (node) => {
    if (ts.isCallExpression(node)) {
      const method = callName(node.expression);
      if (method === "syncCapability" || method === "asyncCapability" || method === "notify") {
        const point = worker.getLineAndCharacterOfPosition(node.getStart(worker));
        const argument = node.arguments[0];
        calls.push({
          capability: argument && isStringLiteral(argument) ? argument.text : null,
          mode: method === "syncCapability" ? "sync" : method === "asyncCapability" ? "async" : "notify",
          line: point.line + 1,
        });
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(worker) === "asyncCapabilities"
      ) {
        asyncMapHasLookup ||= node.expression.name.text === "get";
        asyncMapHasDelete ||= node.expression.name.text === "delete";
      }
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(worker) === "asyncCapabilities") {
      hasAsyncReplyMap = ts.isNewExpression(node.initializer) && node.initializer.expression.getText(worker) === "Map";
    }
    ts.forEachChild(node, visitWorker);
  };
  visitWorker(worker);

  const visitHandler = (node, insideCapabilityValue = false) => {
    const inCapabilityValue =
      insideCapabilityValue || (ts.isFunctionDeclaration(node) && node.name?.text === "capabilityValue");
    if (
      inCapabilityValue &&
      ts.isSwitchStatement(node) &&
      /^(?:call|message)\.capability$/u.test(node.expression.getText(supervisor))
    ) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && isStringLiteral(clause.expression))
          addHostHandler(clause.expression.text, clause);
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      const left = node.left.getText(supervisor);
      if (/(?:message|call)\.capability$/u.test(left) && isStringLiteral(node.right)) {
        addHostHandler(node.right.text, node);
      }
    }
    ts.forEachChild(node, (child) => visitHandler(child, inCapabilityValue));
  };
  visitHandler(supervisor);

  function addHostHandler(capability, node) {
    const point = supervisor.getLineAndCharacterOfPosition(node.getStart(supervisor));
    hostHandlers.set(capability, { path: displayPath(supervisorFile, root), line: point.line + 1 });
  }

  const grouped = new Map();
  for (const call of calls) {
    if (!call.capability) continue;
    const item = grouped.get(call.capability) ?? { capability: call.capability, workerModes: [], workerCalls: [] };
    item.workerModes.push(call.mode);
    item.workerCalls.push({ mode: call.mode, line: call.line });
    grouped.set(call.capability, item);
  }
  const methods = [...grouped.values()]
    .map((item) => ({
      ...item,
      workerModes: [...new Set(item.workerModes)].sort(),
      workerCalls: item.workerCalls.sort((left, right) => left.line - right.line),
      supervisorHandler: hostHandlers.get(item.capability) ?? null,
    }))
    .sort((left, right) => left.capability.localeCompare(right.capability));
  const usedMethods = new Set(grouped.keys());
  return {
    schema: "repo-writer-capability-bridge/v1",
    scope: "worker callsites and supervisor dispatch handlers; injected host implementations require separate review",
    worker: displayPath(workerFile, root),
    supervisor: displayPath(supervisorFile, root),
    methods,
    dynamicWorkerCalls: calls.filter((call) => call.capability === null),
    unhandledWorkerMethods: methods
      .filter((method) => method.supervisorHandler === null)
      .map((method) => method.capability),
    supervisorOnlyMethods: [...hostHandlers.keys()].filter((name) => !usedMethods.has(name)).sort(),
    asyncReplyMap: {
      declared: hasAsyncReplyMap,
      hasLookup: asyncMapHasLookup,
      hasDelete: asyncMapHasDelete,
    },
  };
}

function computeDominators(nodes, edges, root) {
  // Lengauer & Tarjan, TOPLAS 1(1), 1979: semidominators, link/eval and
  // immediate-dominator correction. Retention belongs to dominator-tree edges,
  // not arbitrary import edges: either arm of a diamond retains only itself.
  const successors = new Map([...nodes.keys()].map((id) => [id, new Set()]));
  const predecessors = new Map([...nodes.keys()].map((id) => [id, new Set()]));
  for (const { from, to } of edges) {
    successors.get(from).add(to);
    predecessors.get(to).add(from);
  }

  const vertex = [null];
  const number = new Map();
  const parent = [0];
  const dfs = (id) => {
    const index = vertex.length;
    vertex.push(id);
    number.set(id, index);
    parent[index] = 0;
    for (const next of successors.get(id)) {
      if (number.has(next)) continue;
      dfs(next);
      parent[number.get(next)] = index;
    }
  };
  dfs(root);

  const size = vertex.length;
  const semi = Array.from({ length: size }, (_, index) => index);
  const idomNumber = Array(size).fill(0);
  const ancestor = Array(size).fill(0);
  const label = Array.from({ length: size }, (_, index) => index);
  const bucket = Array.from({ length: size }, () => []);
  const compress = (value) => {
    if (ancestor[ancestor[value]] !== 0) {
      compress(ancestor[value]);
      if (semi[label[ancestor[value]]] < semi[label[value]]) label[value] = label[ancestor[value]];
      ancestor[value] = ancestor[ancestor[value]];
    }
  };
  const evaluate = (value) => {
    if (ancestor[value] === 0) return label[value];
    compress(value);
    return label[value];
  };

  for (let w = size - 1; w >= 2; w -= 1) {
    for (const predecessor of predecessors.get(vertex[w])) {
      const v = number.get(predecessor);
      const candidate = evaluate(v);
      semi[w] = Math.min(semi[w], semi[candidate]);
    }
    bucket[semi[w]].push(w);
    ancestor[w] = parent[w];
    for (const value of bucket[parent[w]]) {
      const candidate = evaluate(value);
      idomNumber[value] = semi[candidate] < semi[value] ? candidate : parent[w];
    }
    bucket[parent[w]] = [];
  }
  for (let w = 2; w < size; w += 1) {
    if (idomNumber[w] !== semi[w]) idomNumber[w] = idomNumber[idomNumber[w]];
  }

  const idom = new Map([[root, root]]);
  const children = new Map([...nodes.keys()].map((id) => [id, []]));
  for (let index = 2; index < size; index += 1) {
    const node = vertex[index];
    const immediate = vertex[idomNumber[index]];
    idom.set(node, immediate);
    children.get(immediate).push(node);
  }
  const retained = new Map();
  const countRetained = (id) => {
    let count = nodes.get(id).sourceBearing ? 1 : 0;
    for (const child of children.get(id)) count += countRetained(child);
    retained.set(id, count);
    return count;
  };
  countRetained(root);
  return { idom, retained };
}

function findForbiddenTargets(nodes, edges, entryId) {
  const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
  const incomingByTarget = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const edge of edges) {
    adjacency.get(edge.from).push(edge);
    incomingByTarget.get(edge.to).push(edge);
  }
  const predecessor = new Map([[entryId, null]]);
  const queue = [entryId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const from = queue[cursor];
    for (const edge of adjacency.get(from)) {
      if (predecessor.has(edge.to)) continue;
      predecessor.set(edge.to, edge);
      queue.push(edge.to);
    }
  }

  const findings = [];
  for (const node of nodes.values()) {
    const incoming = incomingByTarget.get(node.id);
    const rules = new Set();
    if (FORBIDDEN_BUILTINS.has(node.id)) rules.add("forbidden-node-module");
    if (isAuthorizationSpecifier(node.path) || incoming.some((edge) => isAuthorizationSpecifier(edge.specifier))) {
      rules.add("authorization-provider");
    }
    if (isRuntimeSpawnPath(node.path) || incoming.some((edge) => isRuntimeSpawnPath(edge.specifier))) {
      rules.add("runtime-spawn");
    }
    if (isFleetPath(node.path) || incoming.some((edge) => isFleetPath(edge.specifier))) rules.add("fleet");
    for (const rule of rules) {
      findings.push({
        rule,
        target: node.path,
        witness: buildWitness(node.id, predecessor, nodes),
      });
    }
  }
  return findings.sort(
    (left, right) => left.witness.length - right.witness.length || left.target.localeCompare(right.target),
  );
}

function buildWitness(targetId, predecessor, nodes) {
  const reversed = [];
  let current = targetId;
  while (current !== null) {
    const edge = predecessor.get(current);
    if (edge === undefined) return [];
    const node = nodes.get(current);
    reversed.push({
      path: node.path,
      ...(edge ? { importedBy: nodes.get(edge.from).path, specifier: edge.specifier, line: edge.line } : {}),
    });
    current = edge?.from ?? null;
  }
  return reversed.reverse();
}

// Native stripping matches Node's runtime semantics; notably inline-only type
// bindings leave an empty import/export which still evaluates the target module.
// es-module-lexer 2.3 (already locked in the toolchain) handles templates, regexes,
// export namespaces and import attributes without building unrelated function ASTs.
function sourceImports(source, fileName) {
  if (/\.[jt]sx$/u.test(fileName)) return astImports(source, fileName);
  const typescript = /\.(?:mts|cts|ts)$/u.test(fileName);
  const runtimeSource = typescript ? stripTypeScriptTypes(source) : source;
  let linePosition = 0;
  let line = 1;
  let nextNewline = source.indexOf("\n");
  const lineAt = (position) => {
    if (position < linePosition) {
      line = 1;
      nextNewline = source.indexOf("\n");
    }
    while (nextNewline >= 0 && nextNewline < position) {
      line += 1;
      nextNewline = source.indexOf("\n", nextNewline + 1);
    }
    linePosition = position;
    return line;
  };
  const found = [];
  for (const entry of parseEsm(runtimeSource, fileName)[0]) {
    let specifier = entry.n;
    // The ESM lexer leaves backtick dynamic imports undecoded, even when they
    // contain no substitution. Parse only that tiny expression with TypeScript.
    if (specifier === undefined && entry.d >= 0 && runtimeSource[entry.s] === "`") {
      const expression = ts.createSourceFile(
        "literal.js",
        runtimeSource.slice(entry.s, entry.e),
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.JS,
      ).statements[0];
      if (
        expression &&
        ts.isExpressionStatement(expression) &&
        ts.isNoSubstitutionTemplateLiteral(expression.expression)
      )
        specifier = expression.expression.text;
    }
    if (typeof specifier !== "string" || entry.d === -2) continue;
    found.push({
      specifier,
      line: lineAt(entry.ss),
      kind: entry.d >= 0 ? "dynamic-import" : runtimeSource.startsWith("export", entry.ss) ? "export" : "import",
    });
  }

  if (/\brequire\s*(?:\(|\/)/u.test(runtimeSource)) {
    // Acorn supplies JavaScript lexical context (regexes, template substitutions,
    // comments); a full AST for multi-megabyte CommonJS dependencies is wasteful.
    const recent = [];
    for (const token of tokenizer(runtimeSource, { ecmaVersion: "latest", sourceType: "module" })) {
      recent.push(token);
      if (recent.length > 7) recent.shift();
      if (token.type.label !== ")" && token.type.label !== ",") continue;
      let callee = recent.at(-4);
      let opening = recent.at(-3);
      let preceding = recent.at(-5);
      const literal = recent.at(-2);
      let value = literal?.type.label === "string" ? literal.value : undefined;
      if (literal?.type.label === "`") {
        callee = recent.at(-6);
        opening = recent.at(-5);
        preceding = recent.at(-7);
        if (recent.at(-4)?.type.label === "`" && recent.at(-3)?.type.label === "template") value = recent.at(-3).value;
      }
      if (
        callee?.type.label === "name" &&
        callee.value === "require" &&
        opening?.type.label === "(" &&
        typeof value === "string" &&
        preceding?.type.label !== "." &&
        preceding?.type.label !== "?."
      ) {
        found.push({
          specifier: value,
          line: lineAt(callee.start),
          kind: "require",
        });
      }
    }
  }
  return found;
}

function astImports(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, scriptKind(fileName));
  const found = [];
  const visit = (node) => {
    let specifier;
    let kind;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (!(node.isTypeOnly || node.importClause?.isTypeOnly)) {
        specifier = node.moduleSpecifier;
        kind = ts.isExportDeclaration(node) ? "export" : "import";
      }
    } else if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        specifier = node.arguments[0];
        kind = "require";
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        specifier = node.arguments[0];
        kind = "dynamic-import";
      }
    }
    if (isStringLiteral(specifier)) {
      found.push({
        specifier: specifier.text,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        kind,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function resolveImport(specifier, containingFile, workspacePackages, kind) {
  const mode = kind === "require" ? "require" : "import";
  const key = `${path.dirname(containingFile)}\0${mode}\0${specifier}`;
  if (!importResolutionCache.has(key)) {
    importResolutionCache.set(key, resolveImportUncached(specifier, containingFile, workspacePackages, mode));
  }
  return importResolutionCache.get(key);
}

function resolveImportUncached(specifier, containingFile, workspacePackages, mode) {
  const builtinName = normalizeBuiltin(specifier);
  if (builtinName) return { id: builtinName, filePath: null, resolution: "builtin" };

  if (specifier.startsWith(".")) {
    const relativePath = path.resolve(path.dirname(containingFile), specifier);
    if (fileExists(relativePath)) {
      const classified = classifyResolvedPath(relativePath);
      if (classified) return classified;
    }
  }

  const packagePath = resolvePackageImport(specifier, containingFile, workspacePackages, mode);
  if (packagePath?.alias) {
    return resolveImport(
      packagePath.alias,
      path.join(packagePath.packageRoot, "package.json"),
      workspacePackages,
      mode,
    );
  }
  if (packagePath !== undefined) {
    const resolved = packagePath ? classifyResolvedPath(packagePath) : null;
    return resolved ?? { id: `unresolved:${specifier}`, filePath: null, resolution: "unresolved" };
  }

  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    resolutionOptions,
    { ...ts.sys, fileExists, realpath: canonicalPath },
    tsResolutionCache,
  ).resolvedModule?.resolvedFileName;
  const classified = resolved ? classifyResolvedPath(resolved) : null;
  if (classified) return classified;
  return { id: `unresolved:${specifier}`, filePath: null, resolution: "unresolved" };
}

function classifyResolvedPath(fileName) {
  const candidate = runtimeCounterpart(fileName) ?? (fileExists(fileName) ? canonicalPath(fileName) : null);
  if (!candidate || DECLARATION_FILE.test(candidate)) return null;
  const sourceBearing = isSourceFile(candidate);
  if (!sourceBearing && ts.sys.directoryExists(candidate)) return null;
  return {
    id: candidate,
    filePath: candidate,
    resolution: sourceBearing ? "source" : "asset",
  };
}

function resolvePackageImport(specifier, containingFile, workspacePackages, mode) {
  if (specifier.startsWith("node:") || specifier.startsWith(".")) return undefined;
  const isPackageImport = specifier.startsWith("#");
  const packageName = isPackageImport ? null : packageNameOf(specifier);
  const packageRoot = workspacePackages.get(packageName) ?? locatePackageRoot(packageName, containingFile);
  if (!packageRoot) return undefined;
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = readPackageJson(packageJsonPath);
  if (!packageJson) return null;

  const exportKey = isPackageImport ? specifier : packageSubpath(specifier, packageName);
  let target;
  if (isPackageImport) {
    target = resolveSubpathMap(packageJson.imports, exportKey, mode);
  } else if (packageJson.exports !== undefined) {
    target = resolveSubpathMap(packageJson.exports, exportKey, mode);
  } else if (exportKey !== ".") {
    target = `./${exportKey.slice(2)}`;
  } else {
    target = packageJson.main ?? "./index.js";
  }
  if (typeof target !== "string") return null;
  if (isPackageImport && !target.startsWith("./")) {
    return target.startsWith("#") ? null : { alias: target, packageRoot };
  }
  const targetPath = !path.isAbsolute(target) ? path.resolve(packageRoot, target) : null;
  if (targetPath && fileExists(targetPath)) return canonicalPath(targetPath);
  // Legacy main/subpath lookup may need extension or directory resolution.
  // Explicit exports/imports remain authoritative even when blocked or missing.
  return packageJson.exports === undefined && !isPackageImport ? undefined : null;
}

function loadWorkspacePackages(root) {
  const packagesRoot = path.join(root, "packages");
  const packages = new Map();
  if (!fileExists(packagesRoot)) return packages;
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(packagesRoot, entry.name);
    const packageJson = readPackageJson(path.join(packageRoot, "package.json"));
    if (typeof packageJson?.name === "string") packages.set(packageJson.name, packageRoot);
  }
  return packages;
}

function locatePackageRoot(packageName, containingFile) {
  if (packageName === null) {
    let directory = path.dirname(containingFile);
    for (;;) {
      const packageJson = path.join(directory, "package.json");
      if (fileExists(packageJson)) return canonicalPath(directory);
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }
  if (!packageName) return null;
  const cacheKey = `${path.dirname(containingFile)}\0${packageName}`;
  if (packageRootCache.has(cacheKey)) return packageRootCache.get(cacheKey);
  let directory = path.dirname(containingFile);
  for (;;) {
    const candidate = path.join(directory, "node_modules", packageName);
    if (fileExists(path.join(candidate, "package.json"))) {
      const packageRoot = canonicalPath(candidate);
      packageRootCache.set(cacheKey, packageRoot);
      return packageRoot;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      packageRootCache.set(cacheKey, null);
      return null;
    }
    directory = parent;
  }
}

function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function packageSubpath(specifier, packageName) {
  const remainder = specifier.slice(packageName.length);
  return remainder.length > 0 ? `.${remainder}` : ".";
}

function resolveSubpathMap(exportsField, key, mode) {
  if (typeof exportsField === "string" || Array.isArray(exportsField))
    return key === "." ? resolveConditionalTarget(exportsField, mode) : null;
  if (!exportsField || typeof exportsField !== "object") return null;
  const isSubpathMap = Object.keys(exportsField).some((entry) => entry.startsWith(".") || entry.startsWith("#"));
  if (!isSubpathMap) return key === "." ? resolveConditionalTarget(exportsField, mode) : null;
  if (Object.hasOwn(exportsField, key)) return resolveConditionalTarget(exportsField[key], mode);

  const patterns = Object.keys(exportsField)
    .filter((entry) => entry.includes("*") && matchExportPattern(key, entry) !== null)
    .sort((left, right) => right.split("*")[0].length - left.split("*")[0].length || right.length - left.length);
  if (patterns.length === 0) return null;
  const pattern = patterns[0];
  const capture = matchExportPattern(key, pattern);
  return resolveConditionalTarget(exportsField[pattern], mode, capture);
}

function resolveConditionalTarget(target, mode, capture = "") {
  if (typeof target === "string") return target.replaceAll("*", capture);
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveConditionalTarget(item, mode, capture);
      if (resolved) return resolved;
    }
    return null;
  }
  if (!target || typeof target !== "object") return null;
  for (const [condition, value] of Object.entries(target)) {
    if (!["node", "node-addons", mode, "module-sync", "default"].includes(condition)) continue;
    const resolved = resolveConditionalTarget(value, mode, capture);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function matchExportPattern(value, pattern) {
  const marker = pattern.indexOf("*");
  if (marker < 0) return null;
  const prefix = pattern.slice(0, marker);
  const suffix = pattern.slice(marker + 1);
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  return value.slice(prefix.length, value.length - suffix.length);
}

function readPackageJson(fileName) {
  if (!packageJsonCache.has(fileName)) {
    packageJsonCache.set(fileName, fileExists(fileName) ? JSON.parse(readFileSync(fileName, "utf8")) : null);
  }
  return packageJsonCache.get(fileName);
}

function runtimeCounterpart(fileName) {
  if (!fileName) return null;
  const candidate = path.resolve(fileName);
  if (!DECLARATION_FILE.test(candidate) && fileExists(candidate) && isSourceFile(candidate))
    return canonicalPath(candidate);
  const replacements = candidate.endsWith(".d.mts")
    ? [candidate.slice(0, -6) + ".mjs", candidate.slice(0, -6) + ".mts"]
    : candidate.endsWith(".d.cts")
      ? [candidate.slice(0, -6) + ".cjs", candidate.slice(0, -6) + ".cts"]
      : candidate.endsWith(".d.ts")
        ? [candidate.slice(0, -5) + ".js", candidate.slice(0, -5) + ".mjs", candidate.slice(0, -5) + ".ts"]
        : [];
  const found = replacements.find((replacement) => fileExists(replacement) && isSourceFile(replacement));
  return found ? canonicalPath(found) : null;
}

function normalizeBuiltin(specifier) {
  if (specifier.startsWith("node:") && BUILTINS.has(specifier)) return specifier;
  return BUILTINS.has(specifier) ? `node:${specifier}` : null;
}

function makeFileNode(filePath, root) {
  return {
    id: filePath,
    filePath,
    path: displayPath(filePath, root),
    sourceBearing: isSourceFile(filePath) && !DECLARATION_FILE.test(filePath),
  };
}

function makeExternalNode(id) {
  return { id, filePath: null, path: id, sourceBearing: false };
}

function parseSource(filePath) {
  const source = readFileSync(filePath, "utf8");
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, false, scriptKind(filePath));
}

function scriptKind(filePath) {
  if (/\.tsx$/u.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/u.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.(?:mjs|cjs|mts|cts|js)$/u.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isSourceFile(filePath) {
  return SOURCE_FILE.test(filePath) && !DECLARATION_FILE.test(filePath);
}

function isStringLiteral(node) {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

function displayPath(filePath, root) {
  if (!filePath) return null;
  if (filePath.startsWith("node:") || filePath.startsWith("unresolved:")) return filePath;
  const relative = path.relative(root, filePath);
  return (relative || ".").split(path.sep).join("/");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isAuthorizationSpecifier(specifier) {
  return (
    specifier === AUTHORIZATION_PACKAGE ||
    specifier.startsWith(`${AUTHORIZATION_PACKAGE}/`) ||
    /(?:^|[/\\])authorization-keycloak(?:[/\\]|$)/u.test(specifier)
  );
}

function isRuntimeSpawnPath(value) {
  return /(?:^|[/\\])runtime-spawn[^/\\]*$/u.test(value);
}

function isFleetPath(value) {
  return /(?:^|[/\\])fleet[/\\]/u.test(value) || /^fleet\//u.test(value);
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function parseArgs(argv) {
  const options = { root: process.cwd(), entry: WORKER_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { ...options, help: true };
    if (argument === "--root" || argument === "--entry") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument === "--root" ? "root" : "entry"] = value;
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option: ${argument}`);
    } else if (options.entry === WORKER_PATH) {
      options.entry = argument;
    } else {
      throw new Error(`unexpected argument: ${argument}`);
    }
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Usage: node tools/analyze-module-closure.mjs [--root <repository>] [--entry <source-file>]");
    return;
  }
  const result = analyzeModuleClosure(options);
  if (path.resolve(options.root, options.entry) === path.resolve(options.root, WORKER_PATH)) {
    result.capabilityBridge = analyzeCapabilityBridge({ root: options.root });
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
