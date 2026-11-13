import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { bindArguments, isFunctionNode, makeEvaluator, unwrap } from "./authorization-flow-graph.mjs";
import { scanOntologyText } from "./ontology-closure-scan.mjs";

export const sourceFileOf = (source) => source.candidateId.split(":")[2].split("#")[0];
export const sourceSite = (graph, node) => `${graph.fileOf(node)}:${node.getStart(node.getSourceFile())}:${node.end}`;

/** Identity and AST come from the same scanner as closure, never a second fingerprint. */
export function sourceWitnesses(graph, sources) {
  const witnesses = new Map();
  for (const file of new Set(sources.map(sourceFileOf))) {
    const source = graph.modules.get(file)?.sourceFile;
    if (!source) continue;
    scanOntologyText(file, source, (candidate, node) => {
      if (candidate.category === "action") witnesses.set(candidate.id, node);
    });
  }
  return witnesses;
}

/** Pure support is proved against standard declarations, not an effect's spelling. */
export function intrinsicSupport(graph, node) {
  const declaration = graph.callDeclaration(node);
  const library = declaration?.getSourceFile();
  const owner = declaration?.parent?.name?.getText();
  if (library?.isDeclarationFile && /\/node_modules\/(?:typescript\/lib|@types\/node)\//u.test(library.fileName)) {
    if (["Map", "Set", "Hash", "URLSearchParams"].includes(owner)) return true;
    if (owner === "ObjectConstructor" && declaration.name?.getText() === "assign") {
      const target = unwrap(node.arguments[0]);
      return (
        ts.isObjectLiteralExpression(target) ||
        (ts.isNewExpression(target) && target.expression.getText() === "Error" && !graph.lookup("Error", target)) ||
        graph.typeName(target) === "Error"
      );
    }
  }
  return Boolean(
    isFunctionNode(declaration) &&
      declaration.body &&
      graph.fileOf(declaration).startsWith("packages/kernel/src/domain/"),
  );
}

/** The repository root's tools/ scripts belong to no package: they have no bin and no dist, so a
 * package-script action owns their caller-process effects only through typed ports or intrinsic
 * support (dec_7E44897ECDCAEF2B92EC66A260/CH1). Sources under packages/ keep the dist boundary. */
export const rootToolingSource = (graph, node) => graph.fileOf(node).startsWith("tools/");

function declaredPortKey(graph, node) {
  const declaration = graph.callDeclaration(node);
  if (!declaration) return null;
  const names = [];
  for (let current = declaration; current && !ts.isSourceFile(current); current = current.parent)
    if (current.name && (ts.isIdentifier(current.name) || ts.isStringLiteralLike(current.name)))
      names.unshift(current.name.text);
  const file = graph.fileOf(declaration).replace(/^.*\/node_modules\//u, "node_modules/");
  return `${file}#${names.join(".")}`;
}

const VALUE_LEADING_FLAGS = new Set(["--root", "--actor", "--daemon-id", "--user-root", "--format"]);
const BOOLEAN_LEADING_FLAGS = new Set(["--json"]);
const NON_CLIENT_COMMANDS = new Set(["git", "npm", "npx", "gh", "taskkill", "cat"]);

function cliArgTokens(graph, expression, seen = new Set()) {
  const expr = unwrap(expression);
  if (!expr || seen.has(expr)) return null;
  seen.add(expr);
  if (ts.isIdentifier(expr)) {
    const binding = graph.lookup(expr.text, expr);
    return binding?.kind === "var" ? cliArgTokens(graph, binding.declaration.initializer, seen) : null;
  }
  if (!ts.isArrayLiteralExpression(expr)) return null;
  const elements = expr.elements;
  let index = 0;
  while (index < elements.length) {
    const head = unwrap(elements[index]);
    if (!head || !ts.isStringLiteralLike(head)) break;
    if (BOOLEAN_LEADING_FLAGS.has(head.text)) {
      index += 1;
      continue;
    }
    if (VALUE_LEADING_FLAGS.has(head.text)) {
      index += 2;
      continue;
    }
    break;
  }
  const tokens = [];
  while (index < elements.length) {
    const item = unwrap(elements[index]);
    if (!item || !ts.isStringLiteralLike(item)) break;
    tokens.push(item.text);
    index += 1;
  }
  return tokens.length > 0 ? tokens : null;
}

/** Extracts the concrete protocol/CLI descriptor invoked at a call site, or null for generic/dynamic runners. */
export function clientCommandBinding(graph, node, descriptors = []) {
  if (!ts.isCallExpression(node) || descriptors.length === 0) return null;
  const firstArg = unwrap(node.arguments[0]);
  if (firstArg && ts.isStringLiteralLike(firstArg) && NON_CLIENT_COMMANDS.has(firstArg.text)) return null;
  let bestCliMatch = null;
  for (const arg of node.arguments) {
    const tokens = cliArgTokens(graph, arg);
    if (!tokens) continue;
    for (const descriptor of descriptors) {
      const cmdPath = descriptor.path;
      if (!Array.isArray(cmdPath) || cmdPath.length === 0 || tokens.length < cmdPath.length) continue;
      if (!cmdPath.every((segment, idx) => tokens[idx] === segment)) continue;
      if (!bestCliMatch || cmdPath.length > bestCliMatch.path.length) bestCliMatch = descriptor;
    }
  }
  if (bestCliMatch) return bestCliMatch;
  for (const arg of node.arguments) {
    const obj = unwrap(arg);
    if (!obj || !ts.isObjectLiteralExpression(obj)) continue;
    const kindProp = obj.properties.find(
      (prop) =>
        ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
        prop.name.text === "kind",
    );
    const kindValue = kindProp ? unwrap(kindProp.initializer) : null;
    if (kindValue && ts.isStringLiteralLike(kindValue)) {
      const match =
        descriptors.find((descriptor) => descriptor.id === kindValue.text) ??
        descriptors.find((descriptor) => (descriptor.actionKind ?? descriptor.id) === kindValue.text);
      if (match) return match;
    }
  }
  return null;
}

function clientPortReachesTransport(graph, declaration, seen = new Set()) {
  if (!declaration || seen.has(declaration)) return false;
  seen.add(declaration);
  const file = graph.fileOf(declaration);
  if (file.startsWith("packages/daemon/") || file.startsWith("packages/cli/")) return true;
  if (/\/node_modules\/@types\/node\/child_process\.d\.ts$/u.test(declaration.getSourceFile()?.fileName ?? ""))
    return true;
  let reached = false;
  function visit(child) {
    if (reached) return;
    if (ts.isCallExpression(child)) {
      const target = graph.callDeclaration(child);
      if (clientPortReachesTransport(graph, target, seen)) {
        reached = true;
        return;
      }
      const callee = unwrap(child.expression);
      if (ts.isIdentifier(callee)) {
        const binding = graph.lookup(callee.text, callee);
        if (binding?.kind === "var" && clientPortReachesTransport(graph, binding.declaration.initializer, seen)) {
          reached = true;
          return;
        }
      }
    }
    ts.forEachChild(child, visit);
  }
  visit(declaration);
  return reached;
}

/** A root tools/ script calling an authorized CLI or daemon action must bind its typed client port and command/kind. */
export function clientEntryEvidence(graph, node, source, action, descriptors = []) {
  if (
    !source.port ||
    source.role !== "client" ||
    action.ontology?.technical ||
    action.ontology?.authority ||
    !rootToolingSource(graph, node)
  )
    return null;
  const declaration = graph.callDeclaration(node);
  if (!declaration || declaredPortKey(graph, node) !== source.port) return null;
  if (!clientPortReachesTransport(graph, declaration)) return null;
  const descriptor = clientCommandBinding(graph, node, descriptors);
  if (!descriptor || descriptor.id !== source.route) return null;
  const expectedKind =
    action.executionClass === "repo-read" ? descriptor.commandClass : (descriptor.actionKind ?? descriptor.id);
  const targetKind = action.executionClass === "repo-read" ? "repo-read" : action.kind;
  if (expectedKind !== targetKind) return null;
  return [`typed client port ${source.port} invokes ${source.route} (${action.kind})`];
}

/** A shared driver has its own reviewed declaration; it does not borrow a command's permission. */
export function technicalPortEvidence(graph, node, source, action, descriptors = []) {
  const { authority } = action.ontology;
  if (
    !source.port ||
    source.role !== "technical-port" ||
    source.route !== action.kind ||
    !action.ontology.technical ||
    !(authority === "local-process" || (authority === "package-script" && rootToolingSource(graph, node))) ||
    action.receiptSettlement !== "none"
  )
    return null;
  const declaration = graph.callDeclaration(node);
  if (!declaration || declaredPortKey(graph, node) !== source.port) return null;
  // Concrete business CLI/RPC calls in tools/ belong to their business ActionDeclaration, not package-assets-build.
  if (
    rootToolingSource(graph, node) &&
    clientPortReachesTransport(graph, declaration) &&
    clientCommandBinding(graph, node, descriptors)
  )
    return null;
  return [
    `typed technical port ${source.port}; ${action.ontology.owner} owns the implementation, not remote authorization`,
  ];
}

/** Node gives each caller its own stdout/stderr; these cannot name a repository writer. */
export function processOwnedOutput(graph, node) {
  const callee = unwrap(node.expression),
    stream = callee.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "write" &&
    ts.isPropertyAccessExpression(stream) &&
    ["stdout", "stderr"].includes(stream.name.text) &&
    stream.expression.getText() === "process" &&
    !graph.lookup("process", stream) &&
    /\/node_modules\/@types\/node\//u.test(graph.callDeclaration(node)?.getSourceFile().fileName ?? "")
  );
}

function staticPath(graph, expression, seen = new Set()) {
  const node = unwrap(expression);
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (node.getText() === "import.meta.url") return pathToFileURL(path.join(graph.rootDir, graph.fileOf(node))).href;
  if (ts.isIdentifier(node)) {
    const binding = graph.lookup(node.text, node);
    return binding?.kind === "var" ? staticPath(graph, binding.declaration.initializer, seen) : null;
  }
  if (ts.isNewExpression(node) && node.expression.getText() === "URL" && !graph.lookup("URL", node)) {
    const values = node.arguments?.map((arg) => staticPath(graph, arg, new Set(seen))) ?? [];
    return values.every((value) => value !== null) ? new URL(...values) : null;
  }
  if (!ts.isCallExpression(node)) return null;
  const callee = unwrap(node.expression);
  const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
  const binding = ts.isIdentifier(receiver) ? graph.lookup(receiver.text, receiver) : null;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : binding?.exported;
  const values = node.arguments.map((arg) => staticPath(graph, arg, new Set(seen)));
  if (values.some((value) => value === null)) return null;
  if (binding?.from === "node:path" && ["resolve", "join", "dirname"].includes(name)) return path[name](...values);
  return binding?.from === "node:url" && name === "fileURLToPath" ? fileURLToPath(values[0]) : null;
}

const invokesNode = (script, file) =>
  String(script ?? "")
    .split(/\s*&&\s*/u)
    .some((command) => command.trim() === `node ${file}`);

/** An operator entry must be installed as this package's actual bin or npm script. */
export function processEntry(graph, entry, authority) {
  if (!entry?.file) return null;
  const packageDir = entry.file.split("/").slice(0, 2).join("/");
  const manifest = JSON.parse(fs.readFileSync(path.join(graph.rootDir, packageDir, "package.json"), "utf8"));
  if (authority === "package-script") {
    const script = manifest.scripts?.[entry.script];
    const relative = path.posix.relative(packageDir, entry.file);
    if (!invokesNode(script, relative)) return null;
  } else {
    const configFile = path.join(graph.rootDir, packageDir, "tsconfig.build.json");
    const config = ts.readConfigFile(configFile, ts.sys.readFile);
    if (config.error) return null;
    const options = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile)).options;
    const output = path
      .relative(
        path.join(graph.rootDir, packageDir),
        path.join(options.outDir, path.relative(options.rootDir, path.join(graph.rootDir, entry.file))),
      )
      .replace(/\.ts$/u, ".js")
      .split(path.sep)
      .join("/");
    if (manifest.bin?.[entry.bin] !== output) {
      const builder = graph.modules.get(entry.builder)?.sourceFile;
      if (!builder || !invokesNode(manifest.scripts?.build, path.posix.relative(packageDir, entry.builder)))
        return null;
      const bin = path.join(graph.rootDir, packageDir, manifest.bin?.[entry.bin] ?? "");
      let linked = false;
      (function visit(node) {
        const binding =
          ts.isCallExpression(node) && ts.isIdentifier(node.expression) && graph.lookup(node.expression.text, node);
        if (
          binding?.from === "node:fs" &&
          binding.exported === "writeFileSync" &&
          node.arguments[1] &&
          ts.isStringLiteralLike(node.arguments[1])
        ) {
          const target = staticPath(graph, node.arguments[0]);
          if (target instanceof URL && fileURLToPath(target) === bin) {
            const wrapper = ts.createSourceFile("bin.js", node.arguments[1].text, ts.ScriptTarget.Latest, true);
            linked ||= wrapper.statements.some(
              (statement) =>
                ts.isImportDeclaration(statement) &&
                path.resolve(path.dirname(bin), statement.moduleSpecifier.text) ===
                  path.join(graph.rootDir, packageDir, output),
            );
          }
        }
        ts.forEachChild(node, visit);
      })(builder);
      if (!linked) return null;
    }
  }
  return moduleEntry(graph, entry.file);
}

export function moduleEntry(graph, file) {
  const source = graph.modules.get(file)?.sourceFile;
  if (!source) return null;
  const fn = ts.factory.createArrowFunction(
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    ts.factory.createBlock(source.statements),
  );
  fn.parent = source;
  ts.setTextRange(fn, source);
  return fn;
}

export function buildOutputWithinPackage(graph, node) {
  const resolved = staticPath(graph, node.arguments[0]);
  const destination = resolved instanceof URL ? fileURLToPath(resolved) : resolved;
  const prefix = path.join(graph.rootDir, graph.fileOf(node).split("/").slice(0, 2).join("/"), "dist") + path.sep;
  const callee = unwrap(node.expression);
  const binding = ts.isIdentifier(callee) ? graph.lookup(callee.text, callee) : null;
  return (
    binding?.from === "node:fs" &&
    ["rmSync", "writeFileSync"].includes(binding.exported) &&
    typeof destination === "string" &&
    (destination + path.sep).startsWith(prefix)
  );
}

/** Process ownership needs real call reachability, without interpreting RPC branch predicates. */
export function processSourceSites(
  graph,
  entry,
  { evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true }), env = new Map() } = {},
) {
  const seen = new Map(),
    active = [],
    sites = new Set();
  const bindingShape = (env) =>
    [...env.values()].map((bound) => (bound.expression ? sourceSite(graph, bound.expression) : "")).join("|");
  function walk(fn, env) {
    const key = bindingShape(env),
      frames = seen.get(fn) ?? new Set();
    if (!fn.body || active.includes(fn) || frames.has(key)) return;
    active.push(fn);
    frames.add(key);
    seen.set(fn, frames);
    function visit(node) {
      if (isFunctionNode(node)) return;
      if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
        const condition = ts.isIfStatement(node) ? node.expression : node.condition;
        visit(condition);
        const folded = evaluator.fold(condition, env);
        const left = ts.isIfStatement(node) ? node.thenStatement : node.whenTrue;
        const right = ts.isIfStatement(node) ? node.elseStatement : node.whenFalse;
        if (folded) {
          if (folded.value ? left : right) visit(folded.value ? left : right);
        } else {
          visit(left);
          if (right) visit(right);
        }
        return;
      }
      if (ts.isNewExpression(node) && node.expression.getText() === "Promise" && !graph.lookup("Promise", node))
        for (const argument of node.arguments ?? [])
          for (const value of evaluator.evaluate(argument, env).filter((value) => value.fn))
            walk(value.node, value.env);
      if (ts.isCallExpression(node)) {
        sites.add(sourceSite(graph, node));
        const values = evaluator.evaluate(node.expression, env);
        const declared = graph.callDeclaration(node);
        for (const value of values.filter((value) => value.fn))
          walk(value.node, bindArguments(value, node.arguments, env));
        if (isFunctionNode(declared) && declared.body && !values.some((value) => value.node === declared))
          walk(declared, bindArguments({ node: declared, env: new Map() }, node.arguments, env));
        if (values.some((value) => value.external !== undefined))
          for (const arg of node.arguments)
            for (const value of evaluator.evaluate(arg, env).filter((value) => value.fn)) walk(value.node, value.env);
      }
      ts.forEachChild(node, visit);
    }
    visit(fn.body);
    active.pop();
  }
  walk(entry, env);
  return sites;
}
