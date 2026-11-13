import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { stripGlobals } from "../../packages/cli/src/cli/thin-command-flags.ts";
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

const NON_CLIENT_COMMANDS = new Set(["git", "npm", "npx", "gh", "taskkill", "cat"]);
const HELP_OR_VERSION_FLAGS = new Set(["--help", "-h", "--version", "-V", "-v"]);
const fleetSchemaKindsCache = new WeakMap();
const wrapperSignalsCache = new WeakMap();

function leadingFlagAdvance(token, descriptors) {
  const globalStripped = stripGlobals([token, "__value__"]);
  if (globalStripped.length === 0) return 2;
  if (globalStripped.length === 1) return 1;
  for (const descriptor of descriptors) {
    const match = descriptor.inputs?.find((input) => input.name === token);
    if (match) return match.kind === "boolean" ? 1 : 2;
  }
  return 0;
}

function matchCliDescriptor(tokens, descriptors) {
  let best = null;
  for (const descriptor of descriptors) {
    const cmdPath = descriptor.path;
    if (!Array.isArray(cmdPath) || cmdPath.length === 0 || tokens.length < cmdPath.length) continue;
    if (!cmdPath.every((segment, idx) => tokens[idx] === segment)) continue;
    if (!best || cmdPath.length > best.path.length) best = descriptor;
  }
  return best;
}

function findDescriptorForKind(kind, descriptors) {
  return (
    descriptors.find((descriptor) => descriptor.id === kind) ??
    descriptors.find((descriptor) => (descriptor.actionKind ?? descriptor.id) === kind) ??
    null
  );
}

/** Resolve fixed fleet wire schemas (such as `fleet.doc.submit/v1`) to the center operation kind. */
function fleetSchemaKinds(graph) {
  let cached = fleetSchemaKindsCache.get(graph);
  if (cached) return cached;
  cached = new Map();
  fleetSchemaKindsCache.set(graph, cached);

  function extractSchemaEquality(cond) {
    const expr = unwrap(cond);
    if (!expr || !ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
      return null;
    const left = unwrap(expr.left),
      right = unwrap(expr.right);
    const isSchemaProp = (node) => node && ts.isPropertyAccessExpression(node) && node.name.text === "schema";
    if (isSchemaProp(left) && right && ts.isStringLiteralLike(right)) return right.text;
    if (isSchemaProp(right) && left && ts.isStringLiteralLike(left)) return left.text;
    return null;
  }

  function directHandlerKinds(statement) {
    const kinds = new Set();
    function walk(node, insideConditional) {
      if (!node || insideConditional) return;
      if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) return;
      if (ts.isObjectLiteralExpression(node)) {
        for (const prop of node.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
            prop.name.text === "kind"
          ) {
            const val = unwrap(prop.initializer);
            if (val && ts.isStringLiteralLike(val)) kinds.add(val.text);
          }
        }
      }
      if (isFunctionNode(node)) {
        if (ts.isCallExpression(node.parent) && node.body) walk(node.body, false);
        return;
      }
      ts.forEachChild(node, (child) => walk(child, false));
    }
    walk(statement, false);
    return [...kinds];
  }

  for (const [file, mod] of graph.modules) {
    if (!file.startsWith("packages/daemon/src/fleet/")) continue;
    ts.forEachChild(mod.sourceFile, function visit(node) {
      if (ts.isIfStatement(node)) {
        const schema = extractSchemaEquality(node.expression);
        if (schema) {
          const kinds = directHandlerKinds(node.thenStatement);
          if (kinds.length === 1) cached.set(schema, kinds[0]);
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  return cached;
}

function expressionTextFragments(node) {
  const parts = [];
  ts.forEachChild(node, function walk(child) {
    if (ts.isStringLiteralLike(child) || ts.isNoSubstitutionTemplateLiteral(child)) parts.push(child.text);
    else ts.forEachChild(child, walk);
  });
  return parts;
}

function cliPathMatch(text) {
  const normalized = text.replace(/\\/gu, "/");
  return (
    normalized.includes("packages/cli/src/index.ts") ||
    normalized.includes("dist/cli/src/index.js") ||
    normalized.includes("packages/cli/dist/index.js") ||
    normalized.includes("packages/cli/test/")
  );
}

function cliEntryFromCall(graph, expr, seen) {
  const callee = unwrap(expr.expression);
  if (ts.isIdentifier(callee) && callee.text === "cliInvocation") return expr.getText();
  if (ts.isIdentifier(callee) && callee.text === "resolveBinCommand" && expr.arguments[1]) {
    const bin = unwrap(expr.arguments[1]);
    if (bin && ts.isStringLiteralLike(bin) && ["ha", "harness-anything"].includes(bin.text)) return bin.text;
  }
  const text = expressionTextFragments(expr).join("/");
  if (cliPathMatch(text)) return text;
  const decl = graph.callDeclaration(expr);
  if (!decl?.body) return null;
  let found = null;
  ts.forEachChild(decl.body, function findReturn(node) {
    if (found || isFunctionNode(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found = cliEntryTarget(graph, node.expression, seen);
    else ts.forEachChild(node, findReturn);
  });
  return found;
}

function cliEntryTarget(graph, expression, seen = new Set()) {
  const expr = unwrap(expression);
  if (!expr || seen.has(expr)) return null;
  seen.add(expr);
  if (ts.isStringLiteralLike(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
    return cliPathMatch(expr.text) ? expr.text : null;
  if (ts.isCallExpression(expr)) return cliEntryFromCall(graph, expr, seen);
  if (ts.isPropertyAccessExpression(expr))
    return expr.name.text === "cli" ? "cli" : cliEntryTarget(graph, expr.expression, seen);
  if (ts.isIdentifier(expr)) {
    const binding = graph.lookup(expr.text, expr);
    if (binding?.from && cliPathMatch(binding.from)) return binding.from;
    if (binding?.kind === "var" && binding.declaration.initializer)
      return cliEntryTarget(graph, binding.declaration.initializer, seen);
  }
  return null;
}

function returnExpressions(declaration) {
  const returns = [];
  if (!declaration?.body) return returns;
  if (!ts.isBlock(declaration.body)) return [declaration.body];
  ts.forEachChild(declaration.body, function walk(node) {
    if (isFunctionNode(node)) return;
    if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
    ts.forEachChild(node, walk);
  });
  return returns;
}

function arrayElementsFromExpression(graph, expression, seen = new Set()) {
  const expr = unwrap(expression);
  if (!expr || seen.has(expr)) return null;
  seen.add(expr);
  if (ts.isArrayLiteralExpression(expr)) {
    const out = [];
    for (const elem of expr.elements) {
      const item = unwrap(elem);
      if (ts.isSpreadElement(item)) {
        const inner = arrayElementsFromExpression(graph, item.expression, seen);
        if (inner) out.push(...inner);
      } else out.push(item);
    }
    return out;
  }
  if (ts.isCallExpression(expr)) {
    const decl = graph.callDeclaration(expr);
    const out = [];
    for (const ret of returnExpressions(decl)) {
      const inner = arrayElementsFromExpression(graph, ret, seen);
      if (inner) out.push(...inner);
    }
    return out.length > 0 ? out : null;
  }
  if (ts.isIdentifier(expr)) {
    let binding = graph.lookup(expr.text, expr);
    const importSeen = new Set();
    while (binding?.kind === "import" && graph.importTarget && graph.exportedBinding) {
      const target = graph.importTarget(binding);
      if (!target?.file || importSeen.has(`${target.file}#${binding.exported}`)) {
        binding = null;
        break;
      }
      importSeen.add(`${target.file}#${binding.exported}`);
      binding = graph.exportedBinding(target.file, binding.exported);
    }
    if (binding?.kind === "var" && binding.declaration.initializer)
      return arrayElementsFromExpression(graph, binding.declaration.initializer, seen);
  }
  return null;
}

function callbackParamTokenBranches(graph, paramIdentifier, descriptors, seen) {
  const paramDecl = graph.lookup(paramIdentifier.text, paramIdentifier);
  if (!paramDecl || paramDecl.kind !== "param" || !paramDecl.parameter || (paramDecl.trail?.length ?? 0) > 0)
    return null;
  const parameter = paramDecl.parameter;
  const fn = parameter.parent;
  const outerParamIdx = fn?.parameters?.indexOf(parameter) ?? -1;
  if (!fn || outerParamIdx < 0) return null;
  const tokensList = [];
  let found = false;

  if (ts.isCallExpression(fn.parent)) {
    const fnIndex = fn.parent.arguments.indexOf(fn);
    const calleeDecl = fnIndex >= 0 ? graph.callDeclaration(fn.parent) : null;
    const callbackParamName = calleeDecl?.parameters?.[fnIndex]?.name;
    if (calleeDecl?.body && callbackParamName && ts.isIdentifier(callbackParamName)) {
      ts.forEachChild(calleeDecl.body, function visit(node) {
        if (ts.isCallExpression(node)) {
          const target = unwrap(node.expression);
          if (ts.isIdentifier(target) && target.text === callbackParamName.text && node.arguments[outerParamIdx]) {
            const sub = cliArgTokenBranches(graph, node.arguments[outerParamIdx], descriptors, seen);
            for (const seq of sub.tokensList) tokensList.push(seq);
            found = true;
          }
        }
        ts.forEachChild(node, visit);
      });
    }
  } else if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    const fnVarName = fn.parent.name.text;
    const scope = fn.parent.parent?.parent?.parent ?? fn.getSourceFile();
    if (scope) {
      ts.forEachChild(scope, function visit(node) {
        if (ts.isCallExpression(node)) {
          const target = unwrap(node.expression);
          if (
            ts.isIdentifier(target) &&
            target.text === fnVarName &&
            graph.lookup(fnVarName, target)?.declaration === fn.parent &&
            node.arguments[outerParamIdx]
          ) {
            const sub = cliArgTokenBranches(graph, node.arguments[outerParamIdx], descriptors, seen);
            for (const seq of sub.tokensList) tokensList.push(seq);
            found = true;
          }
        }
        ts.forEachChild(node, visit);
      });
    }
  }
  return found ? tokensList : null;
}

function forOfElementBranches(graph, identifier, descriptors, seen) {
  for (let current = identifier.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (!ts.isForOfStatement(current)) continue;
    const decl = current.initializer;
    if (!ts.isVariableDeclarationList(decl) || decl.declarations.length !== 1) continue;
    const pattern = decl.declarations[0].name;
    let elementIndex = -1;
    if (ts.isArrayBindingPattern(pattern)) {
      elementIndex = pattern.elements.findIndex(
        (el) => ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === identifier.text,
      );
    }
    if (elementIndex < 0) continue;
    const rows = arrayElementsFromExpression(graph, current.expression, seen);
    if (!rows) continue;
    const tokensList = [];
    for (const row of rows) {
      const unwrappedRow = unwrap(row);
      if (ts.isArrayLiteralExpression(unwrappedRow) && unwrappedRow.elements[elementIndex]) {
        const branch = cliArgTokenBranches(graph, unwrappedRow.elements[elementIndex], descriptors, seen);
        for (const seq of branch.tokensList) tokensList.push(seq);
      }
    }
    if (tokensList.length > 0) return tokensList;
  }
  return null;
}

function extractArrayTokenSequences(graph, arrayExpr, descriptors, seen) {
  const elements = arrayExpr.elements;
  let index = 0,
    targetsCliEntry = false,
    helpOnly = false;
  if (elements.length > 0 && cliEntryTarget(graph, elements[0])) {
    targetsCliEntry = true;
    index = 1;
  }
  const remaining = elements.slice(index).map(unwrap);
  if (
    remaining.length > 0 &&
    remaining.length <= 2 &&
    ts.isStringLiteralLike(remaining[remaining.length - 1]) &&
    HELP_OR_VERSION_FLAGS.has(remaining[remaining.length - 1].text)
  ) {
    helpOnly = true;
    return { tokensList: [[remaining[remaining.length - 1].text]], targetsCliEntry, helpOnly, unresolved: false };
  }

  let sequences = [[]];
  let inCommandBody = false;
  let unresolved = false;
  while (index < elements.length) {
    const item = unwrap(elements[index]);
    if (item && ts.isSpreadElement(item)) {
      const sub = cliArgTokenBranches(graph, item.expression, descriptors, seen);
      if (sub.targetsCliEntry) targetsCliEntry = true;
      if (sub.tokensList.length > 0 && !inCommandBody) {
        const next = [];
        for (const base of sequences) for (const ext of sub.tokensList) next.push([...base, ...ext]);
        sequences = next;
        inCommandBody = true;
        index += 1;
        continue;
      }
      if (!inCommandBody) unresolved = true;
      break;
    }
    if (!item || !ts.isStringLiteralLike(item)) {
      if (!inCommandBody) unresolved = true;
      break;
    }
    if (HELP_OR_VERSION_FLAGS.has(item.text) && !inCommandBody) {
      helpOnly = true;
      return { tokensList: [[item.text]], targetsCliEntry, helpOnly, unresolved: false };
    }
    if (!inCommandBody) {
      const step = leadingFlagAdvance(item.text, descriptors);
      if (step > 0) {
        index += step;
        continue;
      }
    }
    inCommandBody = true;
    sequences = sequences.map((seq) => [...seq, item.text]);
    index += 1;
  }
  return {
    tokensList: sequences.filter((seq) => seq.length > 0),
    targetsCliEntry,
    helpOnly,
    unresolved,
  };
}

function cliArgTokenBranches(graph, expression, descriptors = [], seen = new Set()) {
  const empty = { tokensList: [], targetsCliEntry: false, helpOnly: false, unresolved: false };
  const expr = unwrap(expression);
  if (!expr || seen.has(expr)) return empty;
  seen.add(expr);
  if (ts.isIdentifier(expr)) {
    const binding = graph.lookup(expr.text, expr);
    if (binding?.kind === "var" && binding.declaration.initializer)
      return cliArgTokenBranches(graph, binding.declaration.initializer, descriptors, seen);
    if (!seen.has(`param:${expr.text}`)) {
      const cbTokens = callbackParamTokenBranches(graph, expr, descriptors, seen);
      if (cbTokens) return { tokensList: cbTokens, targetsCliEntry: false, helpOnly: false, unresolved: false };
    }
    const forOfTokens = forOfElementBranches(graph, expr, descriptors, seen);
    if (forOfTokens) return { tokensList: forOfTokens, targetsCliEntry: false, helpOnly: false, unresolved: false };
    return empty;
  }
  if (ts.isConditionalExpression(expr)) {
    const a = cliArgTokenBranches(graph, expr.whenTrue, descriptors, seen);
    const b = cliArgTokenBranches(graph, expr.whenFalse, descriptors, seen);
    return {
      tokensList: [...a.tokensList, ...b.tokensList],
      targetsCliEntry: a.targetsCliEntry || b.targetsCliEntry,
      helpOnly: a.helpOnly && b.helpOnly && (a.tokensList.length > 0 || b.tokensList.length > 0),
      unresolved: a.unresolved || b.unresolved,
    };
  }
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const a = cliArgTokenBranches(graph, expr.left, descriptors, seen);
    const b = cliArgTokenBranches(graph, expr.right, descriptors, seen);
    return {
      tokensList: [...a.tokensList, ...b.tokensList],
      targetsCliEntry: a.targetsCliEntry || b.targetsCliEntry,
      helpOnly: a.helpOnly && b.helpOnly && (a.tokensList.length > 0 || b.tokensList.length > 0),
      unresolved: a.unresolved || b.unresolved,
    };
  }
  if (ts.isCallExpression(expr)) {
    const callee = unwrap(expr.expression);
    if (ts.isIdentifier(callee) && callee.text === "cliInvocation" && expr.arguments[1]) {
      const sub = cliArgTokenBranches(graph, expr.arguments[1], descriptors, seen);
      return { ...sub, targetsCliEntry: true };
    }
    const decl = graph.callDeclaration(expr);
    const results = returnExpressions(decl);
    if (results.length > 0) {
      const merged = { tokensList: [], targetsCliEntry: false, helpOnly: false, unresolved: false };
      for (const ret of results) {
        const sub = cliArgTokenBranches(graph, ret, descriptors, seen);
        merged.tokensList.push(...sub.tokensList);
        merged.targetsCliEntry ||= sub.targetsCliEntry;
        merged.unresolved ||= sub.unresolved;
      }
      return merged;
    }
    return empty;
  }
  if (ts.isArrayLiteralExpression(expr)) return extractArrayTokenSequences(graph, expr, descriptors, seen);
  return empty;
}

function collectObjectCommandDescriptors(graph, expression, fleetSchemas, descriptors, seen = new Set()) {
  const expr = unwrap(expression);
  if (!expr || !ts.isObjectLiteralExpression(expr) || seen.has(expr)) return [];
  seen.add(expr);
  const found = [];
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : null;
    const val = unwrap(prop.initializer);
    if (name === "kind" && val && ts.isStringLiteralLike(val)) {
      const match = findDescriptorForKind(val.text, descriptors);
      if (match) found.push(match);
    } else if (name === "schema" && val && ts.isStringLiteralLike(val)) {
      const mappedKind = fleetSchemas.get(val.text);
      if (mappedKind) {
        const match = findDescriptorForKind(mappedKind, descriptors);
        if (match) found.push(match);
      }
    } else if ((name === "action" || name === "payload") && val && ts.isObjectLiteralExpression(val)) {
      found.push(...collectObjectCommandDescriptors(graph, val, fleetSchemas, descriptors, seen));
    }
  }
  return found;
}

function walkWrapperCommandSignals(graph, declaration, fleetSchemas, descriptors, seen = new Set()) {
  const empty = { descriptors: [], targetsCliEntry: false };
  if (!declaration || seen.has(declaration)) return empty;
  let graphCache = wrapperSignalsCache.get(graph);
  if (!graphCache) {
    graphCache = new WeakMap();
    wrapperSignalsCache.set(graph, graphCache);
  }
  const cached = graphCache.get(declaration);
  if (cached && seen.size === 0) return cached;
  const file = graph.fileOf(declaration);
  if (!file.startsWith("tools/") && !file.startsWith("packages/daemon/src/fleet/")) return empty;
  seen.add(declaration);
  const paramSeen = new Set();
  for (const param of declaration.parameters ?? []) {
    if (ts.isIdentifier(param.name)) paramSeen.add(`param:${param.name.text}`);
  }
  const matched = [];
  let targetsCliEntry = false;
  ts.forEachChild(declaration, function visit(child) {
    if (ts.isCallExpression(child)) {
      for (const arg of child.arguments) {
        matched.push(...collectObjectCommandDescriptors(graph, arg, fleetSchemas, descriptors));
        const branch = cliArgTokenBranches(graph, arg, descriptors, new Set(paramSeen));
        if (branch.targetsCliEntry || cliEntryTarget(graph, arg)) targetsCliEntry = true;
        for (const seq of branch.tokensList) {
          const hit = matchCliDescriptor(seq, descriptors);
          if (hit) matched.push(hit);
        }
      }
      const nextDecl = graph.callDeclaration(child);
      const nested = walkWrapperCommandSignals(graph, nextDecl, fleetSchemas, descriptors, seen);
      matched.push(...nested.descriptors);
      targetsCliEntry ||= nested.targetsCliEntry;
    }
    ts.forEachChild(child, visit);
  });
  const result = { descriptors: matched, targetsCliEntry };
  if (seen.size === 1) graphCache.set(declaration, result);
  return result;
}

function matrixRowActionKind(row, descriptors) {
  const tuple = unwrap(row);
  if (!ts.isArrayLiteralExpression(tuple) || tuple.elements.length < 2) return null;
  const metricExpr = unwrap(tuple.elements[0]);
  const builderExpr = unwrap(tuple.elements[1]);
  if (!metricExpr || !ts.isStringLiteralLike(metricExpr) || !isFunctionNode(builderExpr)) return null;
  const d = findDescriptorForKind(metricExpr.text.split("~", 1)[0], descriptors);
  return d ? (d.actionKind ?? d.id) : null;
}

function matrixLoopActionKinds(graph, node, descriptors) {
  if (descriptors.length === 0) return new Set();
  for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (!ts.isForOfStatement(current)) continue;
    const rows = arrayElementsFromExpression(graph, current.expression);
    if (!rows || rows.length < 2) continue;
    const kinds = new Set();
    for (const row of rows) {
      const kind = matrixRowActionKind(row, descriptors);
      if (kind) kinds.add(kind);
    }
    if (kinds.size >= 2) return kinds;
  }
  return new Set();
}

function clientPortReachesCliEntry(graph, declaration, seen = new Set()) {
  if (!declaration || seen.has(declaration)) return false;
  seen.add(declaration);
  let reached = false;
  ts.forEachChild(declaration, function visit(child) {
    if (reached) return;
    if (cliEntryTarget(graph, child)) {
      reached = true;
      return;
    }
    if (ts.isCallExpression(child)) {
      const target = graph.callDeclaration(child);
      if (clientPortReachesCliEntry(graph, target, seen)) {
        reached = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  });
  return reached;
}

/** Resolve all business CLI/RPC descriptors bound directly or indirectly by a callsite. */
export function resolvedCommandBindings(graph, node, descriptors = []) {
  const empty = { descriptors: [], targetsCliEntry: false, helpOnly: false, matrixTable: false };
  if (!ts.isCallExpression(node)) return empty;
  const firstArg = unwrap(node.arguments[0]);
  if (firstArg && ts.isStringLiteralLike(firstArg) && NON_CLIENT_COMMANDS.has(firstArg.text)) return empty;
  if (descriptors.length === 0) return empty;

  const fleetSchemas = fleetSchemaKinds(graph);
  const byId = new Map();
  let targetsCliEntry = false;
  let allHelpOnly = true;
  let sawAnyArgs = false;
  const isRootTool = rootToolingSource(graph, node);
  const declaration = isRootTool ? graph.callDeclaration(node) : null;
  const reachesTransport = declaration ? clientPortReachesTransport(graph, declaration) : !isRootTool;

  for (const arg of node.arguments) {
    if (reachesTransport && cliEntryTarget(graph, arg)) targetsCliEntry = true;
    for (const desc of collectObjectCommandDescriptors(graph, arg, fleetSchemas, descriptors)) byId.set(desc.id, desc);
    const branches = cliArgTokenBranches(graph, arg, descriptors);
    if (reachesTransport && branches.targetsCliEntry) targetsCliEntry = true;
    if (branches.tokensList.length > 0 || branches.unresolved) sawAnyArgs = true;
    if (!branches.helpOnly && (branches.tokensList.length > 0 || branches.unresolved)) allHelpOnly = false;
    for (const tokens of branches.tokensList) {
      const hit = matchCliDescriptor(tokens, descriptors);
      if (hit) byId.set(hit.id, hit);
    }
  }

  const helpOnly = sawAnyArgs && allHelpOnly && byId.size === 0;
  if (isRootTool && reachesTransport) {
    if (cliEntryTarget(graph, node.expression) || clientPortReachesCliEntry(graph, declaration)) targetsCliEntry = true;
    if (byId.size === 0 && !helpOnly) {
      const wrapped = walkWrapperCommandSignals(graph, declaration, fleetSchemas, descriptors);
      if (wrapped.targetsCliEntry) targetsCliEntry = true;
      for (const desc of wrapped.descriptors) byId.set(desc.id, desc);
    }
  }

  const finalHelpOnly = sawAnyArgs && allHelpOnly && byId.size === 0;
  const matrixTable = byId.size === 0 && !finalHelpOnly && matrixLoopActionKinds(graph, node, descriptors).size >= 2;
  return { descriptors: [...byId.values()], targetsCliEntry, helpOnly: finalHelpOnly, matrixTable };
}

/** Extracts the concrete protocol/CLI descriptor invoked at a call site, or null for generic/dynamic runners. */
export function clientCommandBinding(graph, node, descriptors = []) {
  const resolved = resolvedCommandBindings(graph, node, descriptors);
  if (resolved.descriptors.length === 0) return null;
  const owners = new Set(resolved.descriptors.map((d) => d.actionKind ?? d.id));
  if (owners.size > 1) return null;
  return resolved.descriptors[0];
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
  const resolved = resolvedCommandBindings(graph, node, descriptors);
  if (resolved.descriptors.length === 0) return null;
  const targetKind = action.executionClass === "repo-read" ? "repo-read" : action.kind;
  const matchesAction = (descriptor) =>
    (action.executionClass === "repo-read" ? descriptor.commandClass : (descriptor.actionKind ?? descriptor.id)) ===
    targetKind;
  if (!resolved.descriptors.every(matchesAction)) return null;
  if (resolved.descriptors.length === 1) {
    const descriptor = resolved.descriptors[0];
    if (descriptor.id !== source.route && (descriptor.actionKind ?? descriptor.id) !== source.route) return null;
  } else if (source.route !== action.kind) {
    return null;
  }
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
  // Business CLI/RPC calls and opaque CLI launchers in tools/ belong to their business ActionDeclaration, not package-assets-build.
  if (rootToolingSource(graph, node)) {
    const resolved = resolvedCommandBindings(graph, node, descriptors);
    if (resolved.descriptors.length > 0 && !resolved.helpOnly) return null;
    if (resolved.targetsCliEntry && !resolved.helpOnly && !resolved.matrixTable) return null;
  }
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
