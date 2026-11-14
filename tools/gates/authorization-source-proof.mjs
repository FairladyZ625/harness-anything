import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { stripGlobals } from "../../packages/cli/src/cli/thin-command-flags.ts";
import { bindArguments, isFunctionNode, makeEvaluator, unwrap } from "./authorization-flow-graph.mjs";
import { scanOntologyText } from "./ontology-closure-scan.mjs";

export const sourceFileOf = (source) => source.candidateId.split(":")[2].split("#")[0];
import {
  declaredPortKey,
  guiCallbackCallerFiles,
  guiClientSource,
  resolvedGuiClientBindings,
  returnExpressions,
  sourceSite,
} from "./authorization-gui-source-proof.mjs";
export { guiCallbackCallerFiles, guiClientSource, resolvedGuiClientBindings, sourceSite };

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

const NON_CLIENT_COMMANDS = new Set(["git", "npm", "npx", "gh", "taskkill", "cat"]);
const OFFLINE_READ_CLI_DESCRIPTORS = Object.freeze([
  { id: "events-tail", path: ["events", "tail"], commandClass: "repo-read" },
]);
function isHelpOrVersionFlag(token) {
  return token === "--help" || token === "-h" || token === "--version" || token === "-V" || token === "-v";
}
function isCliCapabilitiesMeta(remaining) {
  return (
    remaining.length >= 1 &&
    remaining.length <= 2 &&
    ts.isStringLiteralLike(remaining[0]) &&
    remaining[0].text === "capabilities" &&
    (remaining.length === 1 || (ts.isStringLiteralLike(remaining[1]) && remaining[1].text === "--json"))
  );
}
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
  for (const descriptor of [...descriptors, ...OFFLINE_READ_CLI_DESCRIPTORS]) {
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
  if (isCliCapabilitiesMeta(remaining)) {
    helpOnly = true;
    return {
      tokensList: [remaining.map((node) => node.text)],
      targetsCliEntry,
      helpOnly,
      unresolved: false,
    };
  }
  if (
    remaining.length > 0 &&
    remaining.length <= 2 &&
    ts.isStringLiteralLike(remaining[remaining.length - 1]) &&
    isHelpOrVersionFlag(remaining[remaining.length - 1].text)
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
    if (isHelpOrVersionFlag(item.text) && !inCommandBody) {
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
  const empty = { descriptors: [], targetsCliEntry: false, helpOnly: false };
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
  return { descriptors: [...byId.values()], targetsCliEntry, helpOnly: finalHelpOnly };
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

/** Server descriptor routes whose AuthorizationPort dominance must hold for a client entry source. */
export function clientEntryRequiredRoutes(graph, node, source, action, descriptors = []) {
  if (!clientEntryEvidence(graph, node, source, action, descriptors) || action.executionClass === "repo-read")
    return [];
  if (guiClientSource(graph, node)) {
    const resolved = resolvedGuiClientBindings(graph, node, descriptors);
    return [...new Set(resolved.bindings.filter((b) => !b.isRead).map((b) => b.route))].sort();
  }
  return [source.route];
}

/** A root tools/ script or non-main GUI surface calling an authorized CLI/daemon action must bind its typed client port and action route. */
export function clientEntryEvidence(graph, node, source, action, descriptors = []) {
  const localProcessHostAction =
    action.ontology?.authority === "local-process" &&
    action.executionClass === "admin" &&
    action.residency?.scope === "host-local";
  if (
    !source.port ||
    source.role !== "client" ||
    action.ontology?.technical ||
    (action.ontology?.authority && !localProcessHostAction)
  )
    return null;
  if (guiClientSource(graph, node)) {
    if (action.ontology?.authority) return null;
    const declaration = graph.callDeclaration(node);
    if (!declaration || declaredPortKey(graph, node) !== source.port) return null;
    const resolved = resolvedGuiClientBindings(graph, node, descriptors);
    if (!resolved.reachesDaemonTransport || resolved.hasUnprovenCallback || resolved.bindings.length === 0) return null;
    if (resolved.bindings.length === 1) {
      const binding = resolved.bindings[0];
      if (binding.actionKind !== action.kind) return null;
      if (action.executionClass === "repo-read") {
        if (source.route !== binding.route && source.route !== action.kind) return null;
      } else {
        if (source.route !== binding.route) return null;
        if (!descriptors.some((d) => d.id === source.route && (d.actionKind ?? d.id) === action.kind)) return null;
      }
      return [`typed GUI client port ${source.port} invokes ${source.route} (${action.kind})`];
    }
    if (!resolved.viaCallbackParam) return null;
    if (action.executionClass === "repo-read") {
      if (!resolved.bindings.every((b) => b.isRead && b.actionKind === action.kind)) return null;
      if (!resolved.bindings.some((b) => b.route === source.route) && source.route !== action.kind) return null;
    } else {
      const nonReads = resolved.bindings.filter((b) => !b.isRead);
      if (nonReads.length === 0) return null;
      if (!nonReads.some((b) => b.actionKind === action.kind && b.route === source.route)) return null;
      if (!nonReads.every((b) => descriptors.some((d) => d.id === b.route && (d.actionKind ?? d.id) === b.actionKind)))
        return null;
    }
    const routeList = resolved.bindings.map((b) => b.route).join(", ");
    return [
      `typed GUI callback client port ${source.port} multiplexes [${routeList}] under ${source.route} (${action.kind})`,
    ];
  }
  if (!rootToolingSource(graph, node)) return null;
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
  if (
    localProcessHostAction &&
    !resolved.descriptors.every((descriptor) => descriptor.hostAuthority === "local-process")
  )
    return null;
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
    if (resolved.targetsCliEntry && !resolved.helpOnly) return null;
  }
  // Business RPCs, daemon-forwarding IPC calls, and unproven callbacks in GUI cannot claim daemon-local-state.
  if (guiClientSource(graph, node)) {
    const resolved = resolvedGuiClientBindings(graph, node, descriptors);
    if (resolved.bindings.length > 0 || resolved.reachesDaemonTransport || resolved.hasUnprovenCallback) return null;
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

export function processOutputEvidence(graph, node, action) {
  return (
    action.ontology?.authority === "local-process" &&
    action.residency.scope === "host-local" &&
    processOwnedOutput(graph, node)
  );
}

function property(node, name) {
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.find(
      (entry) =>
        (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) &&
        entry.name &&
        (ts.isIdentifier(entry.name) || ts.isStringLiteralLike(entry.name)) &&
        entry.name.text === name,
    )
  );
}

function functionAncestor(node) {
  for (let current = node.parent; current; current = current.parent) if (isFunctionNode(current)) return current;
  return null;
}

function hostApiFactory(graph, entry) {
  const fn = functionAncestor(entry),
    member = fn?.parent,
    object = member?.parent;
  if (
    !fn ||
    !ts.isPropertyAssignment(member) ||
    !ts.isObjectLiteralExpression(object) ||
    !["createDaemonHostControlApi", "createDaemonHostRuntimeApi"].some((name) => {
      let current = object.parent;
      while (current && !isFunctionNode(current)) current = current.parent;
      return current?.name?.getText() === name;
    })
  )
    return null;
  const contract = graph.interfaceMembers("packages/daemon/src/daemon-host-types.ts", "DaemonHost"),
    name =
      member.name && (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) ? member.name.text : null,
    declaration = name && contract.get(name),
    hosted = graph.modules.get("packages/daemon/src/daemon-host-open.ts")?.sourceFile;
  if (!name || !declaration || !hosted || !graph.implementsMember(member, name, new Set([declaration]))) return null;
  let registered = false;
  (function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["createDaemonHostControlApi", "createDaemonHostRuntimeApi"].includes(node.expression.text)
    )
      registered = true;
    ts.forEachChild(node, visit);
  })(hosted);
  return registered ? { fn, name, object } : null;
}

function statementOf(fn, node) {
  let current = node;
  while (current.parent && current.parent !== fn.body) {
    if (isFunctionNode(current.parent)) return null;
    current = current.parent;
  }
  return current.parent === fn.body ? current : null;
}

function controlFlowUnsafe(fn, node) {
  for (let current = node; current && current !== fn.body; current = current.parent) {
    if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isSwitchStatement(current) ||
      ts.isTryStatement(current) ||
      ts.isIterationStatement(current, true) ||
      (ts.isBinaryExpression(current) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(current.operatorToken.kind)) ||
      Boolean(current.flags & ts.NodeFlags.OptionalChain)
    )
      return true;
  }
  return false;
}

function callsInStatement(statement) {
  const calls = [];
  (function walk(node) {
    if (isFunctionNode(node)) return;
    if (ts.isCallExpression(node)) {
      calls.push(node);
      return;
    }
    ts.forEachChild(node, walk);
  })(statement);
  return calls;
}

function terminatesBeforeEffect(statement) {
  return ts.isReturnStatement(statement) || ts.isThrowStatement(statement);
}

function callNamed(call, name) {
  const expression = unwrap(call.expression);
  return (
    (ts.isPropertyAccessExpression(expression) && expression.name.text === name) ||
    (ts.isIdentifier(expression) && expression.text === name)
  );
}

/** A guard only dominates an effect when both are on the function's unconditional statement path. */
function dominatingCall(fn, source, name, predicate = () => true) {
  if (!fn?.body || !ts.isBlock(fn.body)) return null;
  const statement = statementOf(fn, source),
    index = statement && fn.body.statements.indexOf(statement);
  if (!statement || index < 0) return null;
  for (const previous of fn.body.statements.slice(0, index)) {
    if (terminatesBeforeEffect(previous)) continue;
    const match = callsInStatement(previous).find(
      (call) => callNamed(call, name) && predicate(call) && !controlFlowUnsafe(fn, call),
    );
    if (match) return match;
  }
  return null;
}

/** Reachability follows evaluated callback bindings; nested uncalled functions are not visited. */
function reachableCall(graph, fn, name) {
  if (!fn) return false;
  const targets = [];
  (function visit(node) {
    if (isFunctionNode(node)) return;
    if (ts.isCallExpression(node) && callNamed(node, name)) targets.push(sourceSite(graph, node));
    ts.forEachChild(node, visit);
  })(fn.body);
  return targets.some((target) => processSourceSites(graph, fn, { targets: [target] }).has(target));
}

function resolvedMemberCall(graph, call, file, owner, name) {
  const declaration = graph.callDeclaration(call),
    member = declaration?.name ? declaration : declaration?.parent;
  return Boolean(
    member &&
      member.name?.getText() === name &&
      graph.fileOf(member) === file &&
      member.parent?.name?.getText() === owner,
  );
}

/** References are symbol-bound; only immutable local aliases may preserve an entry value. */
function referenceBinding(graph, expression, seen = new Set()) {
  const node = unwrap(expression);
  if (!node || !ts.isIdentifier(node) || seen.has(node)) return null;
  seen.add(node);
  const binding = graph.lookup(node.text, node);
  if (!binding || binding.trail?.length) return null;
  if (binding.kind === "param") return binding.parameter;
  if (binding.kind !== "var" || !(binding.declaration.parent.flags & ts.NodeFlags.Const)) return null;
  const initial = unwrap(binding.declaration.initializer);
  return initial && ts.isIdentifier(initial) ? referenceBinding(graph, initial, seen) : binding.declaration;
}

function memberBase(expression, fields) {
  let node = unwrap(expression);
  for (const field of [...fields].reverse()) {
    if (!node || !ts.isPropertyAccessExpression(node) || node.name.text !== field || node.questionDotToken) return null;
    node = unwrap(node.expression);
  }
  return node;
}

const sameReference = (graph, expression, binding) =>
  Boolean(binding && referenceBinding(graph, expression) === binding);
const callReceiver = (call, name) =>
  call && ts.isCallExpression(call) && !call.questionDotToken && memberBase(call.expression, [name]);

function contextCall(graph, call, fn, name) {
  return sameReference(graph, callReceiver(call, name), functionAncestor(fn)?.parameters[0]);
}

function localBefore(fn, declaration, source) {
  if (!declaration || !source || !fn?.body || !ts.isBlock(fn.body)) return false;
  const statement = declaration && statementOf(fn, declaration),
    target = statementOf(fn, source);
  return Boolean(
    statement &&
      target &&
      functionAncestor(declaration) === fn &&
      fn.body.statements.indexOf(statement) < fn.body.statements.indexOf(target) &&
      !controlFlowUnsafe(fn, declaration),
  );
}

function scopedCell(graph, receiver, fn, source) {
  const cell = referenceBinding(graph, receiver),
    call = cell && unwrap(cell.initializer),
    context = functionAncestor(fn)?.parameters[0];
  return localBefore(fn, cell, source) &&
    contextCall(graph, call, fn, "requiredCell") &&
    call.arguments.length === 4 &&
    ["cells", "warming", "unavailable"].every((field, index) =>
      sameReference(graph, memberBase(call.arguments[index], [field]), context),
    ) &&
    sameReference(graph, call.arguments[3], fn.parameters[0])
    ? cell
    : null;
}

function cellRoot(graph, expression, cell) {
  const status = memberBase(expression, ["rootDir"]);
  return Boolean(
    status &&
      ts.isCallExpression(status) &&
      status.arguments.length === 0 &&
      sameReference(graph, callReceiver(status, "status"), cell),
  );
}

function scopedBinding(graph, expression, fn, cell, writer) {
  const call = unwrap(expression);
  return (
    contextCall(graph, call, fn, "binding") &&
    cellRoot(graph, call.arguments[0], cell) &&
    sameReference(graph, call.arguments[1], fn.parameters[2]) &&
    (writer
      ? call.arguments.length === 4 && sameReference(graph, call.arguments[3], fn.parameters[0])
      : call.arguments.length === 2)
  );
}

function scopedHostGuard(graph, call, fn) {
  return (
    contextCall(graph, call, fn, "requireHostMode") &&
    call.arguments.length === 3 &&
    resolvedMemberCall(
      graph,
      call,
      "packages/daemon/src/daemon-host-context.ts",
      "DaemonHostApiContext",
      "requireHostMode",
    ) &&
    sameReference(graph, call.arguments[0], fn.parameters[0]) &&
    runtimeHostModeArgument(graph, call.arguments[1]) &&
    sameReference(graph, call.arguments[2], fn.parameters[2])
  );
}

/** A guard and a later use cannot share the same binding after that binding is overwritten. */
function stableScope(graph, fn, locals) {
  const roots = [...fn.parameters, ...locals];
  let changed = false;
  function visit(node) {
    if (changed) return;
    const write =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ? node.left
        : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
          ? node.operand
          : null;
    if (write) {
      let root = unwrap(write);
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = unwrap(root.expression);
      changed = roots.includes(referenceBinding(graph, root));
    }
    ts.forEachChild(node, visit);
  }
  visit(fn.body);
  return !changed;
}

function scopedWitnessIssuer(graph, fn) {
  if (!fn || !isFunctionNode(fn) || !ts.isBlock(fn.body)) return false;
  const statement = fn.body.statements.at(-1),
    token = statement && ts.isReturnStatement(statement) && unwrap(statement.expression),
    cell = scopedCell(graph, memberBase(callReceiver(token, "issueWitnessToken"), ["runtime"]), fn, token),
    identity = token && ts.isCallExpression(token) && unwrap(token.arguments[1]),
    principal = identity && ts.isObjectLiteralExpression(identity) && property(identity, "principalId"),
    source = identity && ts.isObjectLiteralExpression(identity) && property(identity, "source"),
    binding =
      source && ts.isPropertyAssignment(source) && referenceBinding(graph, memberBase(source.initializer, ["source"]));
  return Boolean(
    cell &&
      binding &&
      returnExpressions(fn).length === 1 &&
      identity.properties.length === 2 &&
      principal &&
      ts.isPropertyAssignment(principal) &&
      resolvedMemberCall(
        graph,
        token,
        "packages/daemon/src/agent-runtime-stream.ts",
        "AgentRuntimeStreamHub",
        "issueWitnessToken",
      ) &&
      sameReference(graph, token.arguments[0], fn.parameters[1]) &&
      sameReference(graph, memberBase(principal.initializer, ["actor", "principal", "personId"]), binding) &&
      localBefore(fn, binding, token) &&
      scopedBinding(graph, binding.initializer, fn, cell, false) &&
      dominatingCall(fn, token, "requireHostMode", (call) => scopedHostGuard(graph, call, fn)) &&
      stableScope(graph, fn, [cell, binding]),
  );
}

/** Host entry evidence binds admission and the actual effect to one repository/authentication scope. */
export function hostServiceEntryEvidence(graph, node, source, action, route) {
  if (!route?.ok || route.kind !== action.kind || route.id !== source.route || source.role !== "effect") return null;
  if (action.kind === "rbac-bootstrap") return hostRbacServiceEvidence(graph, node);
  if (action.kind !== "runtime-run") return null;
  const forwarded = runtimeForwardingServiceEvidence(graph, node);
  if (forwarded) return forwarded;
  const entry = hostApiFactory(graph, node);
  if (!entry) return null;
  const fn = entry.fn;
  if (entry.name === "runtimeIngress") {
    const ingress = dominatingCall(fn, node, "runtimeIngress", (call) =>
        portMemberCall(graph, call, "packages/daemon/src/repo-cell-types.ts", "RepoCell", "runtimeIngress"),
      ),
      cell = scopedCell(graph, callReceiver(ingress, "runtimeIngress"), fn, ingress),
      receipt = referenceBinding(graph, memberBase(node.arguments[1], ["event"])),
      executor = callReceiver(node, "settle");
    return cell &&
      receipt &&
      unwrap(receipt.initializer) === ingress &&
      localBefore(fn, receipt, node) &&
      sameReference(graph, ingress.arguments[0], fn.parameters[1]) &&
      scopedBinding(graph, ingress.arguments[1], fn, cell, true) &&
      dominatingCall(fn, ingress, "requireHostMode", (call) => scopedHostGuard(graph, call, fn)) &&
      contextCall(graph, executor, fn, "decisionPointExecutorFor") &&
      sameReference(graph, executor.arguments[0], fn.parameters[0]) &&
      cellRoot(graph, executor.arguments[1], cell) &&
      sameReference(graph, node.arguments[0], cell) &&
      stableScope(graph, fn, [cell, receipt])
      ? [
          "runtimeIngress: host admission, RepoCell ingress binding and settlement share the entry repository/authentication",
        ]
      : null;
  }
  if (entry.name === "publishRuntimeWitness") {
    const issuer = property(entry.object, "issueRuntimeWitness"),
      issuerFn = issuer && ts.isPropertyAssignment(issuer) && unwrap(issuer.initializer),
      cell = scopedCell(graph, memberBase(callReceiver(node, "publish"), ["runtime"]), fn, node),
      witness = referenceBinding(graph, memberBase(node.arguments[0], ["runtimeSessionId"])),
      bind = witness && unwrap(witness.initializer);
    return cell &&
      localBefore(fn, witness, node) &&
      sameReference(graph, memberBase(callReceiver(bind, "bindWitness"), ["runtime"]), cell) &&
      sameReference(graph, bind.arguments[0], fn.parameters[1]) &&
      sameReference(graph, node.arguments[1], fn.parameters[2]) &&
      portMemberCall(graph, node, "packages/daemon/src/agent-runtime-stream.ts", "AgentRuntimeStreamHub", "publish") &&
      dominatingCall(
        fn,
        node,
        "bindWitness",
        (call) =>
          call === bind &&
          portMemberCall(
            graph,
            call,
            "packages/daemon/src/agent-runtime-stream.ts",
            "AgentRuntimeStreamHub",
            "bindWitness",
          ),
      ) &&
      scopedWitnessIssuer(graph, issuerFn) &&
      stableScope(graph, fn, [cell, witness])
      ? ["publishRuntimeWitness: a scoped issuer and the same repository's bound token own the published session"]
      : null;
  }
  return null;
}

function runtimeHostModeArgument(graph, argument) {
  const node = unwrap(argument),
    descriptorCall = ts.isCallExpression(node) && unwrap(node.expression),
    descriptorBinding =
      descriptorCall && ts.isIdentifier(descriptorCall) ? graph.lookup(descriptorCall.text, descriptorCall) : null,
    binding = ts.isIdentifier(node) && graph.lookup(node.text, node);
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(descriptorCall) &&
    descriptorBinding?.exported === "commandDescriptorForAction" &&
    descriptorBinding.from.includes("daemon-protocol") &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(unwrap(node.arguments[0])) &&
    unwrap(node.arguments[0]).text === "runtime-run"
  )
    return true;
  return (
    ts.isIdentifier(node) &&
    binding?.kind === "import" &&
    binding.exported === "ledgerWriteCommandTopology" &&
    binding.from.includes("preset-command-contract")
  );
}

function effectiveObjectProperty(graph, expression, name) {
  const evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true }),
    values = evaluator.evaluate(expression, new Map());
  if (values.length !== 1 || !values[0].object) return null;
  const object = values[0].object;
  // Only plain properties have statically visible object-spread and overwrite semantics. A
  // computed key, shorthand, method, or accessor can define/replace the effective value.
  if (
    object.properties.some(
      (property) =>
        !ts.isPropertyAssignment(property) ||
        !property.name ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)),
    )
  )
    return null;
  const matches = object.properties.filter((property) => property.name.text === name);
  if (matches.length !== 1) return null;
  const value = unwrap(matches[0].initializer);
  return ts.isStringLiteralLike(value) ? value.text : null;
}

function functionNamed(graph, file, name) {
  const source = graph.modules.get(file)?.sourceFile;
  let found = null;
  if (!source) return null;
  (function visit(node) {
    if (found) return;
    if (isFunctionNode(node) && node.name?.getText() === name) found = node;
    else ts.forEachChild(node, visit);
  })(source);
  return found;
}

function returnedPropertyFunction(fn, name) {
  let result = null;
  (function visit(node) {
    if (result || isFunctionNode(node)) return;
    if (ts.isReturnStatement(node) && ts.isObjectLiteralExpression(unwrap(node.expression))) {
      const value = property(unwrap(node.expression), name);
      if (value && ts.isPropertyAssignment(value)) {
        const initializer = unwrap(value.initializer);
        if (isFunctionNode(initializer)) result = initializer;
      }
      return;
    }
    ts.forEachChild(node, visit);
  })(fn?.body);
  return result;
}

/**
 * Bind a callback use to the factory value that produced its receiver. The migration view uses a
 * Proxy, so the proof follows the actual `get(..., "append") -> returned callback` shape instead
 * of accepting a same-named call in an unrelated nested function.
 */
function boundPropertyCall(graph, fn, bindingName, propertyName, factory, entry) {
  let declaration = null,
    proxy = null;
  (function findBinding(node) {
    if (declaration && proxy) return;
    if (isFunctionNode(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === bindingName &&
      ts.isCallExpression(unwrap(node.initializer)) &&
      graph.callDeclaration(unwrap(node.initializer)) === factory
    )
      declaration = node;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "store" &&
      ts.isNewExpression(unwrap(node.initializer)) &&
      unwrap(node.initializer).expression.getText() === "Proxy"
    )
      proxy = node;
    ts.forEachChild(node, findBinding);
  })(fn?.body);
  if (!declaration || !proxy) return false;
  const proxyCall = unwrap(proxy.initializer),
    handler = proxyCall.arguments[1] && unwrap(proxyCall.arguments[1]);
  if (
    !ts.isNewExpression(proxyCall) ||
    !ts.isObjectLiteralExpression(handler) ||
    graph.lookup("Proxy", proxyCall.expression)
  )
    return false;
  const getter = handler.properties.find(
    (entry) =>
      (ts.isMethodDeclaration(entry) || ts.isPropertyAssignment(entry)) && entry.name && entry.name.getText() === "get",
  );
  const getterFn = getter && ts.isPropertyAssignment(getter) ? unwrap(getter.initializer) : getter;
  if (!getterFn || !isFunctionNode(getterFn)) return false;
  // Only the real Proxy property parameter can select the append callback. Earlier
  // selectors must be disjoint literal keys, so none can swallow this property first.
  const selector = (statement) => {
    if (!ts.isIfStatement(statement) || statement.elseStatement) return null;
    const condition = unwrap(statement.expression);
    return ts.isBinaryExpression(condition) &&
      condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      sameReference(graph, condition.left, getterFn.parameters[1]) &&
      ts.isStringLiteralLike(unwrap(condition.right))
      ? unwrap(condition.right).text
      : null;
  };
  const statements = getterFn.body?.statements,
    index = statements?.findIndex((statement) => selector(statement) === "append"),
    branch = index >= 0 && statements[index].thenStatement,
    appendCallback = branch && ts.isReturnStatement(branch) && unwrap(branch.expression),
    accept = returnedPropertyFunction(fn, "accept"),
    append = accept && unwrap(accept.body);
  if (
    !(index >= 0) ||
    statements.slice(0, index).some((statement) => selector(statement) === null) ||
    !appendCallback ||
    !isFunctionNode(appendCallback) ||
    !sameReference(graph, callReceiver(append, "append"), proxy) ||
    !reachesSource(graph, entry, append)
  )
    return false;
  let found = false;
  (function visit(node) {
    if (found || isFunctionNode(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(unwrap(node.expression)) &&
      unwrap(node.expression).name.text === propertyName &&
      ts.isIdentifier(unwrap(node.expression).expression) &&
      unwrap(node.expression).expression.text === bindingName &&
      graph.lookup(bindingName, unwrap(node.expression).expression)?.declaration === declaration &&
      reachesSource(graph, appendCallback, node)
    )
      found = true;
    else ts.forEachChild(node, visit);
  })(appendCallback.body);
  return found;
}

/** The runtime callback is registered with the real forwarding port and calls its typed owner. */
function runtimeForwardingServiceEvidence(graph, node) {
  const fn = functionAncestor(node),
    member = fn?.parent,
    object = member?.parent,
    call = object?.parent,
    service = graph.callDeclaration(node),
    forward = call && ts.isCallExpression(call) ? graph.callDeclaration(call) : null;
  return fn &&
    ts.isPropertyAssignment(member) &&
    member.name.getText() === "runRuntime" &&
    ts.isObjectLiteralExpression(object) &&
    ts.isCallExpression(call) &&
    forward?.name?.getText() === "forward" &&
    graph.fileOf(forward) === "packages/daemon/src/fleet/forwarding-port.ts" &&
    reachableCall(graph, forward, "runRuntime") &&
    service &&
    graph.fileOf(service) === "packages/daemon/src/fleet-edge-runtime.ts" &&
    service.parent?.name?.getText() === "run"
    ? ["runtime-run: invoked forwarding callback delegates to the typed Fleet edge runtime owner"]
    : null;
}

function typedHostMemberShape(graph, node, name) {
  let member = node.parent;
  while (member && !(ts.isPropertyAssignment(member) && member.name.getText() === name)) member = member.parent;
  const fn = member && unwrap(member.initializer),
    object = member?.parent,
    host = object?.parent,
    declaration = graph.interfaceMembers("packages/daemon/src/daemon-host-types.ts", "DaemonHost").get(name);
  let owner = host?.parent;
  while (owner && !isFunctionNode(owner)) owner = owner.parent;
  if (
    !fn ||
    !isFunctionNode(fn) ||
    !ts.isObjectLiteralExpression(object) ||
    !ts.isVariableDeclaration(host) ||
    host.type?.getText() !== "DaemonHost" ||
    owner?.name?.getText() !== "openDaemonHost" ||
    !declaration ||
    !graph.implementsMember(member, name, new Set([declaration]))
  )
    return null;
  return { fn, member, object, host, declaration };
}

function typedHostMember(graph, node, name) {
  const shape = typedHostMemberShape(graph, node, name);
  if (!shape) return null;
  const { fn } = shape;
  const first = ts.isBlock(fn.body) && fn.body.statements[0],
    call = first && ts.isExpressionStatement(first) && unwrap(first.expression),
    guard = call && ts.isCallExpression(call) && graph.callDeclaration(call),
    auth = call && ts.isCallExpression(call) && unwrap(call.arguments[0]);
  return guard?.name?.getText() === "localOnly" &&
    graph.fileOf(guard) === "packages/daemon/src/daemon-host-status.ts" &&
    auth &&
    ts.isIdentifier(auth) &&
    graph.lookup(auth.text, auth)?.parameter === fn.parameters[1]
    ? fn
    : null;
}

function forwardingServiceShape(graph, node) {
  const fn = functionAncestor(node),
    member = fn?.parent,
    object = member?.parent,
    call = object?.parent,
    forward = call && ts.isCallExpression(call) ? graph.callDeclaration(call) : null;
  return Boolean(
    fn &&
      ts.isPropertyAssignment(member) &&
      ts.isObjectLiteralExpression(object) &&
      ts.isCallExpression(call) &&
      forward?.name?.getText() === "forward" &&
      graph.fileOf(forward) === "packages/daemon/src/fleet/forwarding-port.ts",
  );
}

/** Host callbacks must use the host proof; a generic descriptor trace cannot replace it. */
export function hostServiceEntryRequired(graph, node, action) {
  if (action.kind === "rbac-bootstrap") return Boolean(typedHostMemberShape(graph, node, "manageRbac"));
  if (action.kind !== "runtime-run") return false;
  return Boolean(hostApiFactory(graph, node) || forwardingServiceShape(graph, node));
}

function portMemberCall(graph, node, file, contract, name) {
  // Mutated/partial graphs intentionally omit some type-only anchors. Missing authority
  // declarations are inconclusive evidence, so reject the proof instead of throwing.
  if (!graph.modules.has(file)) return false;
  const member = graph.interfaceMembers(file, contract).get(name),
    declaration = graph.callDeclaration(node),
    resolved = declaration?.name ? declaration : declaration?.parent,
    signatures = ts.isPropertyAccessExpression(unwrap(node.expression))
      ? graph.memberSignature(node.expression)
      : new Set();
  return Boolean(
    member &&
      ((signatures && signatures.has(member)) ||
        (resolved && (member === resolved || graph.implementsMember(resolved, name, new Set([member]))))),
  );
}

function invokesCallbackSource(graph, call, node) {
  const evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true }),
    callees = evaluator.evaluate(call.expression, new Map());
  return (
    callees.length > 0 &&
    callees.every(
      (callee) =>
        callee.fn &&
        reachesSource(graph, callee.node, node, {
          evaluator,
          env: bindArguments(callee, call.arguments, new Map()),
        }),
    )
  );
}

/** RBAC's local facade delegates login state and managed lifecycle to their existing typed ports. */
function hostRbacServiceEvidence(graph, node) {
  const entry = typedHostMember(graph, node, "manageRbac"),
    callback = functionAncestor(node);
  if (!entry || !callback) return null;
  function invokedBody(fn) {
    if (!fn) return false;
    let parent = fn.parent;
    while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
    return (
      parent && ts.isCallExpression(parent) && unwrap(parent.expression) === fn && functionAncestor(parent) === entry
    );
  }
  const sessionFile = "packages/kernel/src/ports/identity-session-port.ts";
  if (portMemberCall(graph, node, sessionFile, "IdentitySessionPort", "complete") && invokedBody(callback))
    return ["rbac-bootstrap: local DaemonHost entry delegates login completion to IdentitySessionPort"];
  if (
    !portMemberCall(
      graph,
      node,
      "packages/kernel/src/ports/identity-management-port.ts",
      "IdentityManagementPort",
      "run",
    )
  )
    return null;
  const call = callback.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(callback) || !invokedBody(functionAncestor(call)))
    return null;
  if (
    portMemberCall(graph, call, sessionFile, "IdentitySessionPort", "configureAuthority") &&
    invokesCallbackSource(graph, call, node)
  )
    return ["rbac-bootstrap: managed lifecycle callback is owned by IdentitySessionPort.configureAuthority"];
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "then") return null;
  const guard = unwrap(callee.expression),
    declaration = ts.isCallExpression(guard) && graph.callDeclaration(guard);
  return declaration &&
    declaration.name?.getText() === "requireAuthorizedHostAction" &&
    graph.fileOf(declaration) === "packages/daemon/src/host-action-authorization.ts" &&
    effectiveObjectProperty(graph, guard.arguments[0], "kind") === "rbac-bootstrap"
    ? ["rbac-bootstrap: managed lifecycle callback runs after the host action's enforced authorization promise"]
    : null;
}

/** Callback-chain evidence only; delegatedServiceEntryEvidence also requires the actual route verdict. */
export function migrationServiceEntryEvidence(graph, node, source, action) {
  if (action.kind !== "migrate-import" || source.role !== "effect") return null;
  const fn = functionAncestor(node),
    file = fn && graph.fileOf(fn);
  if (!fn || !file) return null;
  const importFile = "packages/daemon/src/migration-import.ts",
    run = functionNamed(graph, importFile, "runMigrationImport");
  if (!run) return null;
  if (fn.name?.getText() === "stageAuthored" && file === "packages/daemon/src/migration-import-oracle-rebuild.ts") {
    const factory = functionNamed(graph, file, "createMigrationPlanningWorkspace"),
      view = functionNamed(graph, importFile, "stagedImportView"),
      callback = returnedPropertyFunction(factory, "stage");
    return factory &&
      view &&
      reachableCall(graph, run, "stagedImportView") &&
      reachableCall(graph, view, "createMigrationPlanningWorkspace") &&
      callback &&
      reachesSource(graph, callback, node) &&
      boundPropertyCall(graph, view, "workspace", "stage", factory, run)
      ? [
          "migrate-import: staged authored document I/O is reached through the registered planning workspace stage callback",
        ]
      : null;
  }
  if (fn.name?.getText() === "matchesRestatedFact" && file === importFile) {
    const addFact = functionNamed(graph, importFile, "addFact");
    return addFact && reachesSource(graph, run, addFact) && reachesSource(graph, addFact, node)
      ? [
          "migrate-import: the registered migration entry reaches the restatement claim through its actual callback arguments",
        ]
      : null;
  }
  return null;
}

/** A read source is covered by the scheduler callback that calls a typed RepoCell read. */
export function repoReadServiceEvidence(graph, node, source, action, descriptors) {
  if (
    action.executionClass !== "repo-read" ||
    action.kind !== "repository-read" ||
    source.route !== action.kind ||
    source.role !== "effect" ||
    !ts.isCallExpression(node)
  )
    return null;
  const declaration = graph.callDeclaration(node),
    actionArg = unwrap(node.arguments[0]),
    readKind = ts.isObjectLiteralExpression(actionArg) ? property(actionArg, "kind") : null,
    readId =
      readKind && ts.isPropertyAssignment(readKind) && ts.isStringLiteralLike(unwrap(readKind.initializer))
        ? unwrap(readKind.initializer).text
        : null,
    descriptor = descriptors.find((row) => row.id === readId && row.commandClass === "repo-read"),
    member = declaration?.parent,
    owner = member?.parent;
  if (
    !readId ||
    !descriptor ||
    !ts.isPropertySignature(member) ||
    member.name.getText() !== "run" ||
    !ts.isInterfaceDeclaration(owner) ||
    owner.name.text !== "RepoCell" ||
    graph.fileOf(declaration) !== "packages/daemon/src/repo-cell-types.ts"
  )
    return null;
  const callback = functionAncestor(node),
    binding = callback?.parent,
    object = binding?.parent,
    call = object?.parent,
    service = call && ts.isCallExpression(call) ? graph.callDeclaration(call) : null;
  const scheduler = functionNamed(graph, "packages/daemon/src/schedule-scheduler.ts", "evaluationPlan"),
    reachesRead = Boolean(scheduler && reachesSource(graph, scheduler, node));
  if (
    !callback ||
    !ts.isPropertyAssignment(binding) ||
    binding.name.getText() !== "localBinding" ||
    !ts.isObjectLiteralExpression(object) ||
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(unwrap(call.expression)) ||
    unwrap(call.expression).text !== "makeScheduleScheduler" ||
    service?.name?.getText() !== "makeScheduleScheduler" ||
    graph.fileOf(service) !== "packages/daemon/src/schedule-scheduler.ts" ||
    !reachesRead
  )
    return null;
  return [
    `schedule-show: RepoCell.run receives a registered repo-read action inside the scheduler's invoked localBinding callback`,
  ];
}

/** A called typed service owns the nested work; the descriptor trace still owns denial and route checks. */
export function delegatedServiceEntryEvidence(graph, node, source, action, descriptor, route, trace) {
  if (
    !route?.ok ||
    route.id !== source.route ||
    route.kind !== action.kind ||
    (descriptor?.actionKind ?? descriptor?.id) !== action.kind ||
    source.role !== "effect"
  )
    return null;
  const migration = migrationServiceEntryEvidence(graph, node, source, action);
  if (!migration && !(trace?.seen && trace.ok)) return null;
  const declaration = graph.callDeclaration(node),
    file = declaration && graph.fileOf(declaration),
    typedPort = Boolean(
      declaration &&
        ts.isMethodSignature(declaration) &&
        ts.isInterfaceDeclaration(declaration.parent) &&
        file.startsWith("packages/kernel/src/ports/"),
    );
  if (!declaration || (!(isFunctionNode(declaration) && declaration.body) && !typedPort && !migration)) return null;
  return (
    migration ?? [
      `${route.id}: verified descriptor denial plus reachable typed service entry ${file}#${declaration.name?.getText() ?? "call"}`,
    ]
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
  const callee = unwrap(node.expression);
  const binding = ts.isIdentifier(callee) ? graph.lookup(callee.text, callee) : null;
  const writesDirectory = binding?.from === "node:fs" && binding.exported === "cpSync",
    argument = node.arguments[writesDirectory ? 1 : 0],
    resolved = staticPath(graph, argument),
    destination = resolved instanceof URL ? fileURLToPath(resolved) : resolved,
    prefix = path.join(graph.rootDir, graph.fileOf(node).split("/").slice(0, 2).join("/"), "dist") + path.sep;
  return (
    binding?.from === "node:fs" &&
    ["rmSync", "writeFileSync", "cpSync"].includes(binding.exported) &&
    typeof destination === "string" &&
    (destination + path.sep).startsWith(prefix)
  );
}

function reachesSource(graph, entry, node, options = {}) {
  const target = sourceSite(graph, node);
  return processSourceSites(graph, entry, { ...options, targets: [target] }).has(target);
}

const processSitesCache = new WeakMap();
const processBoundSitesCache = new WeakMap();

/** Process ownership needs real call reachability, without interpreting RPC branch predicates. */
export function processSourceSites(graph, entry, options = {}) {
  // The graph and default bindings are immutable within an audit. Explicit callback bindings
  // remain separate: the same function can reach different sources under different arguments.
  const { evaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true }), env = new Map() } =
    options;
  const targetList = options.targets ? [...options.targets] : null;
  const targetKey = targetList ? `targets:${targetList.join("\u0000")}` : "all";
  const reusable = true;
  const bindingShape = (frame) =>
    [...frame.values()]
      .map((bound) => (bound.expression ? sourceSite(graph, bound.expression) : bound.root ? "<root>" : "<unknown>"))
      .join("|");
  const key = bindingShape(env);
  let cache = processSitesCache.get(graph);
  if (reusable && !options.evaluator && !options.env && cache?.has(entry)) {
    const cached = cache.get(entry);
    if (cached instanceof Map && cached.has(targetKey)) return cached.get(targetKey);
    if (targetKey === "all" && !(cached instanceof Map)) return cached;
  }
  let boundCache;
  if (reusable && (options.evaluator || options.env)) {
    let entries = processBoundSitesCache.get(graph);
    if (!entries) processBoundSitesCache.set(graph, (entries = new WeakMap()));
    let evaluators = entries.get(entry);
    if (!evaluators) entries.set(entry, (evaluators = new WeakMap()));
    let frames = evaluators.get(evaluator);
    if (!frames) evaluators.set(evaluator, (frames = new Map()));
    boundCache = frames;
    if (frames.has(`${targetKey}\u0000${key}`)) return frames.get(`${targetKey}\u0000${key}`);
  }
  const seen = new Map(),
    sites = new Set(),
    targetLookup = targetList && Object.fromEntries(targetList.map((target) => [target, true])),
    witnessedTargets = {};
  // A source-less traversal is a complete reachability query; only a targeted query
  // may stop after witnessing every requested site.
  let remainingCount = targetList ? targetList.length : Number.POSITIVE_INFINITY;
  function walk(fn, env) {
    const key = bindingShape(env),
      frames = seen.get(fn) ?? new Set();
    if (!fn.body || frames.has(key) || remainingCount === 0) return;
    frames.add(key);
    seen.set(fn, frames);
    // A function endpoint is witnessed only when the evaluated call actually enters it.
    // This proves callback binding without folding the callback's data-dependent result.
    const entrySite = isFunctionNode(fn) && sourceSite(graph, fn);
    if (entrySite && targetLookup?.[entrySite] && !witnessedTargets[entrySite]) {
      sites.add(entrySite);
      witnessedTargets[entrySite] = true;
      remainingCount -= 1;
      if (remainingCount === 0) return;
    }
    function visit(node) {
      if (remainingCount === 0 || isFunctionNode(node)) return;
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
        const site = sourceSite(graph, node);
        sites.add(site);
        if (targetLookup?.[site] && !witnessedTargets[site]) {
          witnessedTargets[site] = true;
          remainingCount -= 1;
        }
        // Membership queries can stop only after every requested source is witnessed. A missing
        // source still explores the complete reachable graph, including every callback binding.
        if (remainingCount === 0) return;
        const values = evaluator.evaluate(node.expression, env);
        const declared = graph.callDeclaration(node);
        for (const value of values.filter((value) => value.fn))
          walk(value.node, bindArguments(value, node.arguments, env));
        // A typeof callback signature can name another function's body. Prefer the
        // supplied function value; only an unresolved callable needs declaration fallback.
        if (isFunctionNode(declared) && declared.body && !values.some((value) => value.fn))
          walk(declared, bindArguments({ node: declared, env: new Map() }, node.arguments, env));
        if (values.some((value) => value.external !== undefined))
          for (const arg of node.arguments)
            for (const value of evaluator.evaluate(arg, env).filter((value) => value.fn)) walk(value.node, value.env);
      }
      ts.forEachChild(node, visit);
    }
    visit(fn.body);
  }
  walk(entry, env);
  if (reusable) {
    if (boundCache) boundCache.set(`${targetKey}\u0000${key}`, sites);
    else {
      if (!cache) processSitesCache.set(graph, (cache = new WeakMap()));
      const entries = cache.get(entry);
      if (entries instanceof Map) entries.set(targetKey, sites);
      else cache.set(entry, new Map([[targetKey, sites]]));
    }
  }
  return sites;
}
