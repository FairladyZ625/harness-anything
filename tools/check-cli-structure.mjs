import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const violations = [];
const cliFiles = listTsFilesRecursive("packages/cli/src");
const allowedCliFiles = new Set([
  "packages/cli/src/index.ts",
  "packages/cli/src/cli/thin-command.ts",
  "packages/cli/src/daemon/client.ts",
  "packages/cli/src/daemon/control.ts"
]);
const allowedStaticGraph = new Set([
  "packages/cli/src/index.ts",
  "packages/cli/src/cli/thin-command.ts",
  "packages/cli/src/daemon/client.ts",
  "packages/daemon/src/client/local-daemon-target.ts",
  "packages/daemon/src/protocol/daemon-protocol.contract.ts",
  "packages/daemon/src/protocol/json-rpc-types.ts",
  "packages/preset/src/preset-command-contract.ts"
]);

checkFileLines(cliFiles, 250, "CLI source file");
checkFunctions(cliFiles, { maxLines: 120, maxBranches: 40 });
checkThinCliSurface();
checkDistStaticImportGraph();
checkDaemonTransportImportGraph();

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("CLI structure check passed.");

function checkThinCliSurface() {
  const packageJson = JSON.parse(readSource("packages/cli/package.json"));
  const entry = "dist/cli/src/index.js";
  if (packageJson.bin?.ha !== entry || packageJson.bin?.["harness-anything"] !== entry) {
    violations.push(`packages/cli/package.json: both bins must use the thin dist entry ${entry}`);
  }
  for (const file of cliFiles) {
    if (!allowedCliFiles.has(file)) violations.push(`${file}: CLI production surface must be entry, parser, transport, render, or explicit daemon control`);
  }
  for (const file of allowedCliFiles) {
    if (!existsSync(path.join(root, file))) violations.push(`${file}: required thin CLI surface is missing`);
  }
  const entrySource = parseTypeScript("packages/cli/src/index.ts"), imports = runtimeImports(entrySource);
  const direct = new Set(imports.static.map((candidate) => candidate.specifier));
  for (const required of ["./cli/thin-command.ts", "./daemon/client.ts"]) {
    if (!direct.has(required)) violations.push(`packages/cli/src/index.ts: thin entry must directly import ${required}`);
  }
  if (![...entrySource.statements].some((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "emit")) {
    violations.push("packages/cli/src/index.ts: thin entry must own the render function emit");
  }
  const dynamic = imports.dynamic.map((candidate) => candidate.specifier);
  if (dynamic.length !== 1 || dynamic[0] !== "./daemon/control.ts") {
    violations.push("packages/cli/src/index.ts: explicit daemon control must be the sole dynamic entry module");
  }
}

function checkDistStaticImportGraph() {
  const pending = ["packages/cli/src/index.ts"], visited = new Set();
  while (pending.length > 0) {
    const file = pending.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    if (!allowedStaticGraph.has(file)) {
      const detail = file === "packages/kernel/src/index.ts" ? "kernel public barrel" : file.startsWith("packages/kernel/src/domain/") ? "kernel domain module" : "module is outside entry/parser/transport/render whitelist";
      violations.push(`dist static import graph reached ${detail}: ${file}`);
      continue;
    }
    for (const candidate of runtimeImports(parseTypeScript(file)).static) {
      if (candidate.specifier.startsWith("node:")) continue;
      if (!candidate.specifier.startsWith(".")) {
        violations.push(`dist static import graph reached external package ${candidate.specifier} from ${file}`);
        continue;
      }
      const resolved = resolveSourceImport(file, candidate.specifier);
      if (resolved === null) violations.push(`dist static import graph cannot resolve ${candidate.specifier} from ${file}`);
      else pending.push(resolved);
    }
  }
}

// The line client is the one daemon transport module the thin entry reaches by dynamic import on
// every daemon command (runCommandThroughDaemon awaits it), so its own static module graph rides
// the critical path of every CLI→daemon invocation while sitting outside the entry's static graph
// that checkDistStaticImportGraph bounds. Unbounded, one kernel barrel import there loaded the
// whole kernel (with its effect dependency) per invocation — ~250ms of module load per daemon
// command that the paired-round latency gate read as a write-path regression (10.088x on CI, fact
// F-FB7D48A6), because lint forces kernel imports through exactly that barrel. The allowlist is
// the transitive runtime graph of the transport itself, so any kernel dependency at all — barrel
// or leaf — reds here. A type-only barrel import stays legal (it is erased), which is why this
// walks runtime imports.
function checkDaemonTransportImportGraph() {
  const allowed = new Set([
    "packages/daemon/src/client/local-json-rpc-client.ts",
    "packages/daemon/src/client/local-daemon-target.ts",
    "packages/daemon/src/protocol/version.ts",
    "packages/daemon/src/protocol/json-rpc-types.ts",
    "packages/daemon/src/protocol/daemon-protocol.contract.ts",
    "packages/preset/src/preset-command-contract.ts"
  ]);
  // Reduced fixture trees (tools/gates/test/cli-structure.test.mjs) may not carry the daemon
  // package's line client at all; absent means not under test, not a violation — a real tree
  // always has it, and renaming it breaks typecheck before this check could say anything useful.
  if (!existsSync(path.join(root, "packages/daemon/src/client/local-json-rpc-client.ts"))) return;
  const pending = ["packages/daemon/src/client/local-json-rpc-client.ts"], visited = new Set();
  while (pending.length > 0) {
    const file = pending.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    if (!allowed.has(file)) {
      const detail = file === "packages/kernel/src/index.ts" ? "kernel public barrel" : "module is outside the daemon transport allowlist";
      violations.push(`daemon transport import graph reached ${detail}: ${file}`);
      continue;
    }
    for (const candidate of runtimeImports(parseTypeScript(file)).static) {
      if (candidate.specifier.startsWith("node:")) continue;
      if (!candidate.specifier.startsWith(".")) {
        violations.push(`daemon transport import graph reached external package ${candidate.specifier} from ${file}`);
        continue;
      }
      const resolved = resolveSourceImport(file, candidate.specifier);
      if (resolved === null) violations.push(`daemon transport import graph cannot resolve ${candidate.specifier} from ${file}`);
      else pending.push(resolved);
    }
  }
}

function runtimeImports(sourceFile) {
  const result = { static: [], dynamic: [] };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && runtimeImportDeclaration(statement)) {
      result.static.push({ specifier: statement.moduleSpecifier.text });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
      result.static.push({ specifier: statement.moduleSpecifier.text });
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      result.dynamic.push({ specifier: node.arguments[0].text });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

function runtimeImportDeclaration(statement) {
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly) return clause === undefined;
  if (clause.name) return true;
  return !clause.namedBindings || !ts.isNamedImports(clause.namedBindings) || clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function resolveSourceImport(fromFile, specifier) {
  const absolute = path.resolve(root, path.dirname(fromFile), specifier);
  const candidates = [absolute, absolute.replace(/\.js$/u, ".ts"), absolute.replace(/\.mjs$/u, ".mts")];
  const match = candidates.find((candidate) => existsSync(candidate));
  return match ? relative(match) : null;
}

function listTsFilesRecursive(relativeDir) {
  const absolute = path.join(root, relativeDir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) return listTsFilesRecursive(relativePath);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [relativePath] : [];
  }).sort();
}

function checkFileLines(files, limit, label) {
  for (const file of files) {
    const count = readSource(file).split(/\r?\n/u).length;
    if (count > limit) violations.push(`${file}: ${count} lines exceeds ${label} max ${limit}`);
  }
}

function checkFunctions(files, limits) {
  for (const file of files) {
    const sourceFile = parseTypeScript(file);
    function visit(node) {
      const name = functionName(node);
      if (name) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        const lines = end - start + 1, branches = countBranches(node.getText(sourceFile));
        if (lines > limits.maxLines) violations.push(`${file}:${start}: function ${name} has ${lines} lines; max ${limits.maxLines}`);
        if (branches > limits.maxBranches) violations.push(`${file}:${start}: function ${name} has ${branches} branch markers; max ${limits.maxBranches}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
}

function functionName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}

function countBranches(body) {
  return (body.match(/\b(?:if|for|while|case|catch|switch)\b/gu)?.length ?? 0) + (body.match(/\?/gu)?.length ?? 0);
}
function parseTypeScript(file) { return ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); }
function readSource(file) { return readFileSync(path.join(root, file), "utf8"); }
function relative(file) { return path.relative(root, file).split(path.sep).join("/"); }
