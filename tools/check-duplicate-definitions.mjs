import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const allowlist = new Set([
  "gui/failure",
  "gui/save",
  "kernel/visit"
]);
const violations = [];

for (const pkg of await discoverPackages()) {
  const definitions = new Map();
  for (const file of await walkSourceFiles(path.join(pkg.root, "src"))) {
    const text = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    visit(sourceFile);

    function visit(node) {
      if (ts.isFunctionDeclaration(node) && node.name && !isPureDelegation(node)) {
        const name = node.name.text;
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const locations = definitions.get(name) ?? [];
        locations.push({
          file: relative(file),
          line: position.line + 1
        });
        definitions.set(name, locations);
      }
      ts.forEachChild(node, visit);
    }
  }

  for (const [name, locations] of definitions) {
    if (locations.length <= 1) continue;
    const allowlistKey = `${pkg.key}/${name}`;
    if (allowlist.has(allowlistKey)) continue;
    violations.push(formatViolation(pkg.key, name, locations));
  }
}

if (violations.length > 0) {
  console.error("Duplicate function definitions found:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Duplicate function definition check passed.");

async function discoverPackages() {
  const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages;
  if (!Array.isArray(workspaces)) return [];

  const packages = [];
  for (const workspace of workspaces) {
    for (const packageRoot of await expandWorkspace(workspace)) {
      if (!await directoryExists(path.join(packageRoot, "src"))) continue;
      packages.push({
        root: packageRoot,
        key: await packageKey(packageRoot)
      });
    }
  }
  return packages.sort((left, right) => relative(left.root).localeCompare(relative(right.root)));
}

async function expandWorkspace(workspace) {
  const segments = workspace.split("/");
  const roots = await expandWorkspaceSegments(root, segments);
  const packageRoots = [];
  for (const candidate of roots) {
    if (await fileExists(path.join(candidate, "package.json"))) packageRoots.push(candidate);
  }
  return packageRoots;
}

async function expandWorkspaceSegments(base, segments) {
  if (segments.length === 0) return [base];
  const [segment, ...rest] = segments;
  if (segment === "*") {
    const entries = await readDirectory(base);
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(base, entry.name));
    const expanded = await Promise.all(directories.map((directory) => expandWorkspaceSegments(directory, rest)));
    return expanded.flat();
  }
  return expandWorkspaceSegments(path.join(base, segment), rest);
}

async function walkSourceFiles(dir) {
  const entries = await readDirectory(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["dist", "node_modules", "out", "test", "tests", "__tests__"].includes(entry.name)) continue;
      files.push(...await walkSourceFiles(fullPath));
      continue;
    }
    if (isSourceFile(entry.name)) files.push(fullPath);
  }
  return files.sort();
}

function isSourceFile(fileName) {
  return fileName.endsWith(".ts")
    && !fileName.endsWith(".d.ts")
    && !fileName.endsWith(".test.ts")
    && !fileName.endsWith(".spec.ts");
}

function isPureDelegation(node) {
  if (!node.body || node.parameters.some(hasParameterDefault)) return false;
  if (node.body.statements.length !== 1) return false;

  const [statement] = node.body.statements;
  if (ts.isReturnStatement(statement) && statement.expression) {
    return isCallOrAwaitedCall(statement.expression);
  }
  return ts.isExpressionStatement(statement)
    && isAwaitedCall(statement.expression);
}

function hasParameterDefault(parameter) {
  return parameter.initializer !== undefined || bindingNameHasDefault(parameter.name);
}

function bindingNameHasDefault(name) {
  if (ts.isIdentifier(name)) return false;
  return name.elements.some((element) => {
    if (ts.isOmittedExpression(element)) return false;
    return element.initializer !== undefined || bindingNameHasDefault(element.name);
  });
}

function isCallOrAwaitedCall(expression) {
  const unwrapped = unwrapParentheses(expression);
  if (ts.isCallExpression(unwrapped)) return true;
  return isAwaitedCall(unwrapped);
}

function isAwaitedCall(expression) {
  const unwrapped = unwrapParentheses(expression);
  return ts.isAwaitExpression(unwrapped)
    && ts.isCallExpression(unwrapParentheses(unwrapped.expression));
}

function unwrapParentheses(expression) {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

async function packageKey(packageRoot) {
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const name = typeof manifest.name === "string" ? manifest.name : path.basename(packageRoot);
  return name.startsWith("@harness-anything/") ? name.slice("@harness-anything/".length) : name;
}

async function readDirectory(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function directoryExists(dir) {
  return (await readDirectory(dir)).length > 0;
}

async function fileExists(file) {
  try {
    await readFile(file, "utf8");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return false;
    throw error;
  }
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function formatViolation(packageKeyValue, name, locations) {
  const joinedLocations = locations.map((location) => `${location.file}:${location.line}`).join(", ");
  return `${packageKeyValue}/${name}: duplicate function definitions at ${joinedLocations}`;
}
