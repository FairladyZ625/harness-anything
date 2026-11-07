// Static source graph for the durable-authorization gate: lexical scopes, import resolution,
// callable evaluation and branch folding. Nothing here knows a production function name; the
// only anchors are the kernel authorities handed in through `facts`.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parseTypeScript, walkTypeScriptFiles } from "./ontology-gate-lib.mjs";

const sourceRoots = ["packages/daemon/src", "packages/authorization-keycloak/src", "packages/application/src"];
const maxEvaluationDepth = 12;
// A request travels through many frames before its effect; provenance is memoized per frame.
const maxProvenanceDepth = 64;

export const isFunctionNode = (node) =>
  Boolean(node) &&
  (ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node));

export function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isTypeAssertionExpression(current))
  )
    current = current.expression;
  return current;
}

export const memberName = (node) =>
  ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;

function bindingNames(name, visit, trail = []) {
  if (ts.isIdentifier(name)) return visit(name.text, trail);
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    // A rest element keeps the remaining fields of the same object.
    const key = element.dotDotDotToken
      ? "..."
      : element.propertyName
        ? memberName(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
    bindingNames(element.name, visit, [...trail, key]);
  }
}

function declareStatements(statements, bindings) {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        bindingNames(declaration.name, (name, trail) => bindings.set(name, { kind: "var", declaration, trail }));
    else if (ts.isFunctionDeclaration(statement) && statement.name)
      bindings.set(statement.name.text, { kind: "fn", node: statement });
    else if (ts.isClassDeclaration(statement) && statement.name)
      bindings.set(statement.name.text, { kind: "class", node: statement });
  }
}

/**
 * `rootDir` holds the traced sources; `anchorRoot` holds the kernel authority files the anchors
 * name (the same checkout unless a test traces a mutated copy of the sources).
 */
export function buildFlowGraph(rootDir, { anchorRoot = rootDir } = {}) {
  const modules = new Map(),
    members = new Map(),
    typedEntries = new Map(),
    scopes = new WeakMap();
  const files = sourceRoots.flatMap((root) => walkTypeScriptFiles(rootDir, root)),
    // The checker answers one question only: which implementations a typed member call can reach.
    program = ts.createProgram({
      rootNames: files.map((file) => path.join(rootDir, file)),
      options: {
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        strict: true,
        types: [],
      },
    }),
    checker = program.getTypeChecker(),
    relativeFiles = new WeakMap();
  for (const file of files) {
    const sourceFile = program.getSourceFile(path.join(rootDir, file)) ?? parseTypeScript(rootDir, file),
      imports = new Map();
    relativeFiles.set(sourceFile, file);
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue;
      const from = statement.moduleSpecifier.text,
        named = statement.importClause.namedBindings;
      if (statement.importClause.name) imports.set(statement.importClause.name.text, { from, exported: "default" });
      if (named && ts.isNamespaceImport(named)) imports.set(named.name.text, { from, exported: "*" });
      if (named && ts.isNamedImports(named))
        for (const element of named.elements)
          if (!element.isTypeOnly)
            imports.set(element.name.text, { from, exported: element.propertyName?.text ?? element.name.text });
    }
    modules.set(file, { file, sourceFile, imports });
    indexMembers(sourceFile, file);
  }
  return {
    rootDir,
    modules,
    members,
    typedEntries,
    lookup,
    importTarget,
    exportedBinding,
    fileOf,
    implementsMember,
    memberSignature,
    interfaceMembers,
    carriesTransport,
  };

  /** Whether an argument is (or holds) an authentication context: a value with a transport discriminant. */
  function carriesTransport(node) {
    const type = checker.getTypeAtLocation(node);
    return (type.isUnion() ? type.types : [type]).some((part) => checker.getPropertyOfType(part, "transportKind"));
  }

  /** The member declarations of an interface in a kernel authority file, keyed by member name. */
  function interfaceMembers(file, name) {
    const source = program.getSourceFile(fs.realpathSync(path.join(anchorRoot, file))),
      declaration = source?.statements.find(
        (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === name,
      );
    if (!declaration) throw new Error(`${file}: interface ${name} is missing`);
    return new Map(
      declaration.members.filter((member) => member.name).map((member) => [memberName(member.name), member]),
    );
  }

  function fileOf(node) {
    const source = node.getSourceFile();
    return relativeFiles.get(source) ?? source.fileName;
  }

  /** The declarations a property call names: interface signatures or the concrete member itself. */
  function memberSignature(access) {
    const symbol = checker.getSymbolAtLocation(access.name),
      declarations = symbol?.declarations ?? [];
    return declarations.length === 0 ? null : new Set(declarations);
  }

  /** Whether an object/class member is contextually typed as one of the named signatures. */
  function implementsMember(declaration, key, signatures) {
    const owners = [];
    const container = declaration.parent;
    if (ts.isObjectLiteralExpression(container)) {
      const contextual = checker.getContextualType(container);
      if (contextual) owners.push(contextual);
    } else if (ts.isClassLike(container))
      for (const clause of container.heritageClauses ?? [])
        for (const type of clause.types) owners.push(checker.getTypeAtLocation(type));
    if (
      owners.some((owner) =>
        (owner.isUnion() ? owner.types : [owner]).some((part) =>
          (checker.getPropertyOfType(part, key)?.declarations ?? []).some((candidate) => signatures.has(candidate)),
        ),
      )
    )
      return true;
    // A class without an `implements` clause still receives calls typed through an interface it
    // structurally satisfies: that is where a typed member call dispatches.
    if (!ts.isClassLike(container) || !container.name) return false;
    const symbol = checker.getSymbolAtLocation(container.name),
      instance = symbol && checker.getDeclaredTypeOfSymbol(symbol);
    if (!instance) return false;
    return [...signatures].some((signature) => {
      const owner = signature.parent;
      if (!owner || !(ts.isInterfaceDeclaration(owner) || ts.isTypeLiteralNode(owner))) return false;
      const target = ts.isInterfaceDeclaration(owner)
        ? checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(owner.name))
        : checker.getTypeAtLocation(owner);
      return checker.isTypeAssignableTo(instance, target);
    });
  }

  function addMember(name, value, file, declaration) {
    if (name === null) return;
    const entries = members.get(name) ?? [];
    entries.push({ value, file, declaration });
    members.set(name, entries);
  }

  function indexMembers(node, file) {
    if (ts.isPropertyAssignment(node)) addMember(memberName(node.name), node.initializer, file, node);
    else if (ts.isShorthandPropertyAssignment(node)) addMember(node.name.text, node.name, file, node);
    else if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) && node.body)
      addMember(memberName(node.name), node, file, node);
    else if (ts.isPropertyDeclaration(node) && node.initializer)
      addMember(memberName(node.name), node.initializer, file, node);
    else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      node.type &&
      ts.isIndexedAccessTypeNode(node.type) &&
      ts.isLiteralTypeNode(node.type.indexType) &&
      ts.isStringLiteral(node.type.indexType.literal)
    ) {
      // `const run: RepoCell["run"]` names the typed member a transport hands its requests to.
      const key = `${node.type.objectType.getText()}.${node.type.indexType.literal.text}`,
        entries = typedEntries.get(key) ?? [];
      entries.push(node.initializer);
      typedEntries.set(key, entries);
    }
    ts.forEachChild(node, (child) => indexMembers(child, file));
  }

  function scopeBindings(scope) {
    const cached = scopes.get(scope);
    if (cached) return cached;
    const bindings = new Map();
    if (
      ts.isSourceFile(scope) ||
      ts.isBlock(scope) ||
      ts.isModuleBlock(scope) ||
      ts.isCaseClause(scope) ||
      ts.isDefaultClause(scope)
    )
      declareStatements(scope.statements, bindings);
    else if (ts.isFunctionLike(scope)) {
      for (const parameter of scope.parameters)
        bindingNames(parameter.name, (name, trail) => bindings.set(name, { kind: "param", parameter, trail }));
      if (ts.isFunctionExpression(scope) && scope.name) bindings.set(scope.name.text, { kind: "fn", node: scope });
    } else if (ts.isCatchClause(scope) && scope.variableDeclaration)
      bindingNames(scope.variableDeclaration.name, (name) => bindings.set(name, { kind: "opaque" }));
    else if (
      (ts.isForOfStatement(scope) || ts.isForInStatement(scope) || ts.isForStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer)
    )
      for (const declaration of scope.initializer.declarations)
        bindingNames(declaration.name, (name) => bindings.set(name, { kind: "opaque" }));
    scopes.set(scope, bindings);
    return bindings;
  }

  function lookup(name, from) {
    for (let scope = from; scope; scope = scope.parent) {
      const found = scopeBindings(scope).get(name);
      if (found) return found;
      if (ts.isSourceFile(scope)) {
        const file = fileOf(scope),
          imported = modules.get(file)?.imports.get(name);
        return imported ? { kind: "import", file, ...imported } : null;
      }
    }
    return null;
  }

  function importTarget(binding) {
    if (!binding.from.startsWith(".")) return { external: true };
    const file = path.posix.normalize(path.posix.join(path.posix.dirname(binding.file), binding.from));
    if (modules.has(file)) return { file };
    // A sibling package outside the traced roots is an external boundary, not a broken edge.
    return fs.existsSync(path.join(rootDir, file))
      ? { external: true }
      : { broken: `${binding.file}: import ${binding.from} is missing` };
  }

  /** Only a real export qualifies: a same-named private function does not answer an import. */
  function exportedBinding(file, exported) {
    const { sourceFile } = modules.get(file);
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause))
        continue;
      const entry = statement.exportClause.elements.find((element) => element.name.text === exported);
      if (!entry) continue;
      const local = entry.propertyName?.text ?? entry.name.text;
      if (!statement.moduleSpecifier) return lookup(local, sourceFile);
      return { kind: "import", file, from: statement.moduleSpecifier.text, exported: local };
    }
    const bindings = scopeBindings(sourceFile),
      binding = bindings.get(exported);
    if (!binding) return null;
    const declared = binding.kind === "var" ? binding.declaration.parent.parent : binding.node;
    return declared.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ? binding : null;
  }
}

/** An environment maps a parameter node to the argument expression evaluated in its caller's env. */
export function bindArguments(fn, args, callerEnv, env = fn.env) {
  const next = new Map(env);
  fn.node.parameters.forEach((parameter, index) => {
    if (parameter.dotDotDotToken) return;
    if (args[index]) next.set(parameter, { expression: args[index], env: callerEnv });
  });
  return next;
}

export function makeEvaluator(graph, facts) {
  const unknown = { unknown: true },
    memberCache = new Map(),
    contextFree = new Map(),
    assignments = new Map(),
    provenanceCache = new WeakMap();

  function evaluateBinding(binding, name, env, depth) {
    // A nested declaration closes over its enclosing frame; a module-level one over nothing.
    if (binding.kind === "fn")
      return [{ fn: true, node: binding.node, env: ts.isSourceFile(binding.node.parent) ? new Map() : env }];
    if (binding.kind === "class") return [{ classNode: binding.node, env }];
    if (binding.kind === "opaque") return [unknown];
    if (binding.kind === "import") {
      const target = graph.importTarget(binding);
      if (target.external) return [{ external: binding.exported }];
      if (target.broken) return [{ broken: target.broken }];
      const exported = graph.exportedBinding(target.file, binding.exported);
      return exported
        ? evaluateBinding(exported, binding.exported, new Map(), depth + 1)
        : [{ broken: `${target.file}: ${binding.exported} is not exported` }];
    }
    const trail = binding.trail ?? [];
    if (binding.kind === "param") {
      const bound = env.get(binding.parameter);
      if (!bound) return [unknown];
      return bound.root ? [bound] : project(evaluate(bound.expression, bound.env, depth + 1), trail, depth);
    }
    const initializer = binding.declaration.initializer;
    return initializer ? project(evaluate(initializer, env, depth + 1), trail, depth) : [unknown];
  }

  function project(values, trail, depth) {
    return trail.reduce((current, key) => current.flatMap((value) => memberOf(value, key, depth)), values);
  }

  function memberOf(value, key, depth) {
    if (value.module) {
      const exported = graph.exportedBinding(value.module, key);
      return exported
        ? evaluateBinding(exported, key, new Map(), depth + 1)
        : [{ broken: `${value.module}: ${key} is not exported` }];
    }
    if (value.object) {
      for (const property of [...value.object.properties].reverse()) {
        if (ts.isSpreadAssignment(property)) {
          const inner = evaluate(property.expression, value.env, depth + 1).flatMap((spread) =>
            spread.object ? memberOf(spread, key, depth + 1) : [],
          );
          if (inner.length && !inner.every((entry) => entry.unknown)) return inner;
          continue;
        }
        if (property.name && memberName(property.name) === key) {
          if (ts.isPropertyAssignment(property)) return evaluate(property.initializer, value.env, depth + 1);
          if (ts.isShorthandPropertyAssignment(property)) return evaluate(property.name, value.env, depth + 1);
          return [{ fn: true, node: property, env: value.env }];
        }
      }
      return [unknown];
    }
    if (value.classNode) {
      const member = value.classNode.members.find((entry) => entry.name && memberName(entry.name) === key);
      if (member && ts.isMethodDeclaration(member) && member.body) return [{ fn: true, node: member, env: value.env }];
      if (member && ts.isPropertyDeclaration(member) && member.initializer)
        return evaluate(member.initializer, value.env, depth + 1);
    }
    return [unknown];
  }

  /** Name-indexed fallback for injected context objects; every candidate must itself resolve. */
  function memberCandidates(key, depth, access) {
    const signatures = access ? graph.memberSignature(access) : null,
      cacheKey = signatures ? [...signatures][0] : key;
    if (memberCache.has(cacheKey)) return memberCache.get(cacheKey);
    const all = graph.members.get(key) ?? [];
    if (all.length === 0) return [{ external: key }];
    // A typed receiver reaches only the implementations of its own interface member; an
    // untyped one keeps every same-named candidate, so a narrowing can never hide an effect.
    const typed = signatures
        ? all.filter(
            (entry) => signatures.has(entry.declaration) || graph.implementsMember(entry.declaration, key, signatures),
          )
        : [],
      entries = signatures ? typed : all;
    // A typed member whose implementation lives outside the traced packages is an external call.
    if (entries.length === 0) return [{ external: key }];
    memberCache.set(cacheKey, [unknown]);
    const values = distinct(
      entries.flatMap(({ value }) =>
        isFunctionNode(value)
          ? [{ fn: true, node: value, env: new Map() }]
          : evaluate(value, new Map(), depth + 1).filter((entry) => entry.fn || entry.broken),
      ),
    );
    memberCache.set(cacheKey, values);
    return values;
  }

  /** One entry per value; a closure is the same value only under the same captured frame. */
  function distinct(values) {
    const seen = new Map();
    return values.filter((value) => {
      const identity =
          value.node ?? value.object ?? value.classNode ?? value.module ?? value.broken ?? value.external ?? "unknown",
        frames = seen.get(identity) ?? new Set(),
        frame = value.env ?? null;
      if (frames.has(frame)) return false;
      frames.add(frame);
      seen.set(identity, frames);
      return true;
    });
  }

  function evaluate(expression, env, depth = 0) {
    if (depth > maxEvaluationDepth) return [unknown];
    // Context-free evaluations are pure in the node, so each is computed once.
    if (env.size === 0 && expression) {
      const cached = contextFree.get(expression);
      if (cached) return cached;
      contextFree.set(expression, [unknown]);
      const values = evaluateNode(expression, env, depth);
      contextFree.set(expression, values);
      return values;
    }
    return evaluateNode(expression, env, depth);
  }

  function evaluateNode(expression, env, depth) {
    const node = unwrap(expression);
    if (!node) return [unknown];
    if (ts.isIdentifier(node)) {
      const binding = graph.lookup(node.text, node);
      if (binding) return evaluateBinding(binding, node.text, env, depth);
      return node.text in globalThis || node.text === "undefined"
        ? [{ external: node.text }]
        : [{ broken: `${graph.fileOf(node)}: ${node.text} is not defined` }];
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return [{ fn: true, node, env }];
    if (ts.isObjectLiteralExpression(node)) return [{ object: node, env }];
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      for (let scope = node.parent; scope; scope = scope.parent)
        if (ts.isClassLike(scope)) return [{ classNode: scope, env }];
      return [unknown];
    }
    if (ts.isConditionalExpression(node)) {
      const folded = fold(node.condition, env, depth + 1);
      if (folded) return evaluate(folded.value ? node.whenTrue : node.whenFalse, env, depth + 1);
      return [...evaluate(node.whenTrue, env, depth + 1), ...evaluate(node.whenFalse, env, depth + 1)];
    }
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)
    )
      return [...evaluate(node.left, env, depth + 1), ...evaluate(node.right, env, depth + 1)];
    if (ts.isPropertyAccessExpression(node)) {
      const key = memberName(node.name),
        receivers = evaluate(node.expression, env, depth + 1),
        direct = receivers.flatMap((value) =>
          value.object || value.classNode || value.module ? memberOf(value, key, depth + 1) : [],
        );
      const known = direct.filter((value) => !value.unknown),
        opaque = receivers.some((value) => value.unknown || value.broken || value.fn),
        // Only a called member falls back to its implementations; data members stay unknown.
        called = ts.isCallExpression(node.parent) && unwrap(node.parent.expression) === node;
      if (!opaque && known.length) return known;
      if (!opaque && receivers.some((value) => value.external !== undefined)) return [{ external: key }];
      return called ? distinct([...known, ...memberCandidates(key, depth, node)]) : known.length ? known : [unknown];
    }
    if (ts.isNewExpression(node)) return evaluate(node.expression, env, depth + 1);
    if (ts.isCallExpression(node)) return evaluateCall(node, env, depth);
    return [unknown];
  }

  function evaluateCall(node, env, depth) {
    const callee = unwrap(node.expression);
    // A dynamic import of a traced module is that module's namespace, like a static import.
    if (callee.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (!specifier || !ts.isStringLiteralLike(specifier)) return [unknown];
      const target = graph.importTarget({ file: graph.fileOf(node), from: specifier.text });
      if (target.external) return [{ external: specifier.text }];
      if (target.broken) return [{ broken: target.broken }];
      return [{ module: target.file }];
    }
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "then") {
      const [resolved] = node.arguments;
      if (!resolved) return evaluate(callee.expression, env, depth + 1);
      return evaluate(resolved, env, depth + 1).flatMap((value) =>
        value.fn ? returnValues(value, bindArguments(value, [callee.expression], env), depth + 1) : [unknown],
      );
    }
    return distinct(
      evaluate(callee, env, depth + 1).flatMap((value) =>
        value.fn
          ? returnValues(value, bindArguments(value, node.arguments, env), depth + 1)
          : value.broken
            ? [value]
            : [unknown],
      ),
    );
  }

  /** The values `fn` can return on branches that survive folding under the current facts. */
  function returnValues(fn, env, depth) {
    const body = fn.node.body;
    if (!body) return [unknown];
    if (!ts.isBlock(body)) return evaluate(body, env, depth + 1);
    const values = [];
    collect(body);
    return values.length ? values : [unknown];
    function collect(statement) {
      if (!statement) return false;
      if (ts.isReturnStatement(statement)) {
        if (statement.expression) values.push(...evaluate(statement.expression, env, depth + 1));
        return true;
      }
      if (ts.isThrowStatement(statement)) return true;
      if (ts.isBlock(statement)) return statement.statements.some(collect);
      if (ts.isIfStatement(statement)) {
        const folded = fold(statement.expression, env, depth + 1);
        if (folded) return collect(folded.value ? statement.thenStatement : statement.elseStatement);
        const left = collect(statement.thenStatement),
          right = collect(statement.elseStatement);
        return left && right;
      }
      if (ts.isTryStatement(statement)) return collect(statement.tryBlock);
      return false;
    }
  }

  function literal(node) {
    if (ts.isStringLiteralLike(node)) return { value: node.text };
    if (ts.isNumericLiteral(node)) return { value: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { value: null };
    return null;
  }

  function foldIdentifier(node, env, depth) {
    if (node.text === "undefined") return { value: undefined };
    const binding = graph.lookup(node.text, node);
    if (!binding) return null;
    if (binding.kind === "param") {
      const bound = env.get(binding.parameter);
      if (!bound) return null;
      if (bound.root)
        return binding.trail.length === 1 && binding.trail[0] ? requestField(binding.trail[0], "request") : null;
      if (binding.trail.length === 1 && binding.trail[0])
        return fieldOf(bound.expression, binding.trail[0], bound.env, depth + 1);
      return binding.trail.length === 0 ? fold(bound.expression, bound.env, depth + 1) : null;
    }
    if (binding.kind === "import") {
      if (binding.from === facts.authorityModule && Object.hasOwn(facts.constants, binding.exported))
        return { value: facts.constants[binding.exported] };
      const target = graph.importTarget(binding);
      if (!target.file) return null;
      const exported = graph.exportedBinding(target.file, binding.exported);
      return exported?.kind === "var" && exported.trail.length === 0 && exported.declaration.initializer
        ? fold(exported.declaration.initializer, new Map(), depth + 1)
        : null;
    }
    if (binding.kind !== "var" || !binding.declaration.initializer) return null;
    if (binding.trail.length === 1 && binding.trail[0])
      return fieldOf(binding.declaration.initializer, binding.trail[0], env, depth + 1);
    if (binding.trail.length > 0 || !(binding.declaration.parent.flags & ts.NodeFlags.Const)) return null;
    return fold(binding.declaration.initializer, env, depth + 1);
  }

  /**
   * Request provenance. `request` values carry the descriptor's RPC method; `action` values are
   * the command object built from the request (a call over request data), which carries its kind.
   * A plain sub-field of the request, such as a repository id, carries neither kind nor action.
   */
  function provenance(expression, env, depth = 0) {
    if (depth > maxProvenanceDepth) return null;
    const node = unwrap(expression);
    if (!node) return null;
    const cache = provenanceCache.get(env) ?? new Map();
    provenanceCache.set(env, cache);
    if (cache.has(node)) return cache.get(node);
    cache.set(node, null);
    const tag = provenanceOf(node, env, depth);
    cache.set(node, tag);
    return tag;
  }

  function provenanceOf(node, env, depth) {
    if (ts.isIdentifier(node)) {
      const binding = graph.lookup(node.text, node);
      if (binding?.kind === "param") {
        const bound = env.get(binding.parameter);
        if (!bound) return null;
        if (bound.root) return "request";
        return provenance(bound.expression, bound.env, depth + 1);
      }
      if (binding?.kind !== "var") return null;
      const values = binding.declaration.initializer
        ? [binding.declaration.initializer]
        : assignedValues(binding.declaration);
      const tags = values.map((value) => provenance(value, env, depth + 1));
      const tag = tags.includes("action") ? "action" : tags.includes("request") ? "request" : null;
      return tag;
    }
    // A field keeps its owner's provenance: `resolution.action` is still the action.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return provenance(node.expression, env, depth + 1);
    if (ts.isCallExpression(node))
      return node.arguments.some((argument) => provenance(argument, env, depth + 1)) ? "action" : null;
    // Text and choices computed from request data are request data.
    const parts = ts.isTemplateExpression(node)
      ? node.templateSpans.map((span) => span.expression)
      : ts.isConditionalExpression(node)
        ? [node.whenTrue, node.whenFalse]
        : ts.isBinaryExpression(node)
          ? [node.left, node.right]
          : null;
    if (parts) return parts.some((part) => provenance(part, env, depth + 1)) ? "request" : null;
    if (ts.isObjectLiteralExpression(node)) {
      // Spreading the action keeps it the action; carrying request fields makes request data.
      const tags = node.properties.map((property) =>
        ts.isSpreadAssignment(property)
          ? provenance(property.expression, env, depth + 1)
          : ts.isPropertyAssignment(property)
            ? provenance(property.initializer, env, depth + 1) && "request"
            : ts.isShorthandPropertyAssignment(property)
              ? provenance(property.name, env, depth + 1) && "request"
              : null,
      );
      return tags.includes("action") ? "action" : tags.includes("request") ? "request" : null;
    }
    return null;
  }

  const fromRequest = (expression, env) => provenance(expression, env) !== null;

  /** Values assigned to a `let` declared without an initializer, within its declaring function. */
  function assignedValues(declaration) {
    if (assignments.has(declaration)) return assignments.get(declaration);
    const values = [],
      name = ts.isIdentifier(declaration.name) ? declaration.name.text : null;
    let scope = declaration.parent;
    while (scope && !isFunctionNode(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    if (name && scope)
      (function walk(node) {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(unwrap(node.left)) &&
          unwrap(node.left).text === name &&
          graph.lookup(name, node)?.declaration === declaration
        )
          values.push(node.right);
        ts.forEachChild(node, walk);
      })(scope);
    assignments.set(declaration, values);
    return values;
  }

  /** The literal object an expression denotes, followed through bindings, with its environment. */
  /**
   * The object literals an expression can evaluate to, through bindings, fields, choices and the
   * returns of traced calls; null when any of them is opaque.
   */
  function objectLiteralsOf(expression, env, depth = 0) {
    const node = unwrap(expression);
    if (!node || depth > maxEvaluationDepth) return null;
    if (ts.isObjectLiteralExpression(node)) return [{ object: node, env }];
    if (ts.isConditionalExpression(node)) {
      const folded = fold(node.condition, env, depth + 1);
      if (folded) return objectLiteralsOf(folded.value ? node.whenTrue : node.whenFalse, env, depth + 1);
      const left = objectLiteralsOf(node.whenTrue, env, depth + 1),
        right = left && objectLiteralsOf(node.whenFalse, env, depth + 1);
      return left && right ? [...left, ...right] : null;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const owners = objectLiteralsOf(node.expression, env, depth + 1);
      if (!owners) return null;
      const fields = owners.map((owner) => fieldLiterals(owner, node.name.text, depth + 1));
      return fields.every(Boolean) ? fields.flat() : null;
    }
    if (ts.isCallExpression(node)) {
      const callees = evaluate(node.expression, env, depth + 1);
      if (callees.length === 0 || !callees.every((value) => value.fn && value.node.body)) return null;
      const results = callees.flatMap((value) => {
        const callEnv = bindArguments(value, node.arguments, env);
        return returnExpressions(value.node).map((result) => objectLiteralsOf(result, callEnv, depth + 1));
      });
      return results.length && results.every(Boolean) ? results.flat() : null;
    }
    if (!ts.isIdentifier(node)) return null;
    const binding = graph.lookup(node.text, node);
    const trail = binding?.trail ?? [];
    let source = null,
      sourceEnv = env;
    if (binding?.kind === "param") {
      const bound = env.get(binding.parameter);
      if (!bound?.expression) return null;
      source = bound.expression;
      sourceEnv = bound.env;
    } else if (binding?.kind === "var" && binding.declaration.initializer) source = binding.declaration.initializer;
    if (!source || trail.length > 1) return null;
    const owners = objectLiteralsOf(source, sourceEnv, depth + 1);
    if (!owners || trail.length === 0 || trail[0] === "...") return owners;
    const fields = owners.map((owner) => fieldLiterals(owner, trail[0], depth + 1));
    return fields.every(Boolean) ? fields.flat() : null;
  }

  function fieldLiterals(owner, key, depth) {
    for (const property of [...owner.object.properties].reverse()) {
      if (ts.isSpreadAssignment(property)) {
        const inner = objectLiteralsOf(property.expression, owner.env, depth + 1);
        if (
          inner &&
          inner.every(
            (candidate) =>
              !candidate.object.properties.some((entry) => entry.name && memberName(entry.name) === key) &&
              !candidate.object.properties.some(ts.isSpreadAssignment),
          )
        )
          continue;
        return inner && inner.length === 1 ? fieldLiterals(inner[0], key, depth + 1) : null;
      }
      if (property.name && memberName(property.name) === key) {
        if (ts.isPropertyAssignment(property)) return objectLiteralsOf(property.initializer, owner.env, depth + 1);
        if (ts.isShorthandPropertyAssignment(property)) return objectLiteralsOf(property.name, owner.env, depth + 1);
        return null;
      }
    }
    return null;
  }

  function returnExpressions(fn) {
    if (!ts.isBlock(fn.body)) return [fn.body];
    const results = [];
    (function collect(node) {
      if (node !== fn.body && (isFunctionNode(node) || ts.isClassLike(node))) return;
      if (ts.isReturnStatement(node) && node.expression) results.push(node.expression);
      ts.forEachChild(node, collect);
    })(fn.body);
    return results;
  }

  /**
   * A kind spelled from request data (`runtime-handoff-${operation}`) is the kind the request
   * selected when the descriptor's kind fits the authored spelling.
   */
  function requestSelectedKind(key, initializer, env) {
    const node = unwrap(initializer);
    if (key !== "kind" || facts.kind === undefined || !ts.isTemplateExpression(node)) return null;
    if (!node.templateSpans.every((span) => fold(span.expression, env) || provenance(span.expression, env)))
      return null;
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
      pattern = new RegExp(
        `^${escape(node.head.text)}${node.templateSpans.map((span) => `.+${escape(span.literal.text)}`).join("")}$`,
        "u",
      );
    return pattern.test(facts.kind) ? { value: facts.kind } : null;
  }

  function requestField(key, tag) {
    if (key === "method" && facts.method !== undefined) return { value: facts.method };
    if (facts.fields && Object.hasOwn(facts.fields, key)) return { value: facts.fields[key] };
    if (key === "kind" && tag === "action" && facts.kind !== undefined) return { value: facts.kind };
    return null;
  }

  function fieldOf(baseExpression, key, env, depth, optional = false) {
    // Protocol fields: a durable descriptor's class is fixed, and a dry-run preview is not this route.
    if (key === "commandClass" && facts.commandClass) return { value: facts.commandClass };
    if (key === "dryRun" && facts.kind) return { value: false };
    const literals = objectLiteralsOf(baseExpression, env, depth + 1);
    if (literals) {
      // Every object the base can be must agree on the field.
      const values = literals.map((literal) => literalField(literal, key, depth));
      return values.every((value) => value && value.value === values[0].value) ? values[0] : null;
    }
    const tag = provenance(baseExpression, env);
    if (tag) {
      const field = requestField(key, tag);
      if (field) return field;
    }
    const base = fold(baseExpression, env, depth + 1);
    if (!base) return null;
    if (base.value === null || base.value === undefined) return optional ? { value: undefined } : null;
    if (typeof base.value === "string" && key === "length") return { value: base.value.length };
    if (typeof base.value !== "object") return null;
    return Object.hasOwn(base.value, key) ? { value: base.value[key] } : null;
  }

  function literalField(literal, key, depth) {
    {
      for (const property of [...literal.object.properties].reverse()) {
        if (ts.isSpreadAssignment(property)) {
          const inner = objectLiteralsOf(property.expression, literal.env, depth + 1);
          if (inner) {
            const values = inner.map((candidate) => literalField(candidate, key, depth + 1));
            if (values.every((value) => value && value.value === values[0].value)) return values[0];
          }
          const tag = provenance(property.expression, literal.env);
          if (tag) {
            // An authored field is the command's own discriminant; validated request params do
            // not carry it, so a request spread does not stand in for it.
            const authored = literal.object.properties.some(
              (other) => other.pos < property.pos && other.name && memberName(other.name) === key,
            );
            if (authored) continue;
            const field = requestField(key, tag);
            if (field) return field;
          }
          continue;
        }
        if (property.name && memberName(property.name) === key) {
          if (ts.isPropertyAssignment(property))
            return (
              fold(property.initializer, literal.env, depth + 1) ??
              requestSelectedKind(key, property.initializer, literal.env)
            );
          if (ts.isShorthandPropertyAssignment(property)) return fold(property.name, literal.env, depth + 1);
          return null;
        }
      }
      return null;
    }
  }

  function foldProperty(node, env, depth) {
    return fieldOf(node.expression, node.name.text, env, depth, Boolean(node.questionDotToken));
  }

  function foldCall(node, env, depth) {
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (["includes", "has", "startsWith", "endsWith", "test"].includes(method) && node.arguments[0]) {
        const argument = fold(node.arguments[0], env, depth + 1),
          base = ts.isRegularExpressionLiteral(unwrap(callee.expression))
            ? { value: regexFrom(unwrap(callee.expression)) }
            : fold(callee.expression, env, depth + 1);
        if (!argument || !base) return null;
        if (method === "test" && base.value instanceof RegExp)
          return { value: base.value.test(String(argument.value)) };
        if (method === "has" && base.value instanceof Set) return { value: base.value.has(argument.value) };
        if (method === "includes" && (Array.isArray(base.value) || typeof base.value === "string"))
          return { value: base.value.includes(argument.value) };
        if (typeof base.value === "string" && method !== "has" && method !== "test")
          return { value: base.value[method](argument.value) };
      }
      if (["replace", "slice"].includes(method)) {
        const base = fold(callee.expression, env, depth + 1),
          args = node.arguments.map((argument) => fold(argument, env, depth + 1));
        if (base && typeof base.value === "string" && args.every(Boolean))
          return { value: base.value[method](...args.map(({ value }) => value)) };
      }
      return null;
    }
    if (ts.isIdentifier(callee)) {
      const binding = graph.lookup(callee.text, callee);
      if (
        binding?.kind === "import" &&
        binding.from === facts.authorityModule &&
        Object.hasOwn(facts.functions, binding.exported)
      ) {
        // The authority answers only when every input it is asked about is present and decided;
        // an absent optional field or an undecided input leaves the branch live.
        const inputs = node.arguments.map((argument) => fold(argument, env, depth + 1));
        return inputs.length > 0 && inputs.every((input) => input && input.value !== undefined && input.value !== null)
          ? applyAuthority(
              facts.functions[binding.exported],
              inputs.map((input) => input.value),
            )
          : null;
      }
    }
    // A single-expression predicate folds through its body, so extracting one is transparent.
    for (const value of evaluate(callee, env, depth + 1)) {
      if (!value.fn || !value.node.body) continue;
      const body = value.node.body,
        result = ts.isBlock(body)
          ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0])
            ? body.statements[0].expression
            : null
          : body;
      if (result) return fold(result, bindArguments(value, node.arguments, env), depth + 1);
    }
    return null;
  }

  /** The kernel authority evaluated on a folded input. */
  function applyAuthority(fn, inputs) {
    return { value: fn(...inputs) };
  }

  function regexFrom(node) {
    const text = node.text,
      end = text.lastIndexOf("/");
    return new RegExp(text.slice(1, end), text.slice(end + 1));
  }

  /** Three-valued: `{ value }` when the branch is decided, null when both branches remain live. */
  function fold(expression, env, depth = 0) {
    if (depth > maxEvaluationDepth) return null;
    const node = unwrap(expression);
    if (!node) return null;
    const constant = literal(node);
    if (constant) return constant;
    if (ts.isIdentifier(node)) return foldIdentifier(node, env, depth);
    if (ts.isPropertyAccessExpression(node)) return foldProperty(node, env, depth);
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const part = fold(span.expression, env, depth + 1);
        if (!part) return null;
        text += String(part.value) + span.literal.text;
      }
      return { value: text };
    }
    if (ts.isConditionalExpression(node)) {
      const condition = fold(node.condition, env, depth + 1);
      if (condition) return fold(condition.value ? node.whenTrue : node.whenFalse, env, depth + 1);
      const whenTrue = fold(node.whenTrue, env, depth + 1),
        whenFalse = fold(node.whenFalse, env, depth + 1);
      return whenTrue && whenFalse && whenTrue.value === whenFalse.value ? whenTrue : null;
    }
    if (ts.isTypeOfExpression(node)) {
      const inner = fold(node.expression, env, depth + 1);
      return inner ? { value: inner.value === null ? "object" : typeof inner.value } : null;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const elements = node.elements.map((element) => fold(element, env, depth + 1));
      return elements.every(Boolean) ? { value: elements.map(({ value }) => value) } : null;
    }
    if (ts.isNewExpression(node) && node.expression.getText() === "Set" && node.arguments?.[0]) {
      const values = fold(node.arguments[0], env, depth + 1);
      return values && Array.isArray(values.value) ? { value: new Set(values.value) } : null;
    }
    if (ts.isCallExpression(node)) {
      const frozen = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(frozen) && frozen.getText() === "Object.freeze" && node.arguments[0])
        return fold(node.arguments[0], env, depth + 1);
      return foldCall(node, env, depth);
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = fold(node.operand, env, depth + 1);
      return inner ? { value: !inner.value } : null;
    }
    if (ts.isBinaryExpression(node)) return foldBinary(node, env, depth);
    return null;
  }

  function foldBinary(node, env, depth) {
    const operator = node.operatorToken.kind,
      left = fold(node.left, env, depth + 1);
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (left && !left.value) return left;
      const right = fold(node.right, env, depth + 1);
      if (left) return right;
      return right && !right.value ? right : null;
    }
    if (operator === ts.SyntaxKind.BarBarToken) {
      if (left && left.value) return left;
      const right = fold(node.right, env, depth + 1);
      if (left) return right;
      return right && right.value ? right : null;
    }
    const right = fold(node.right, env, depth + 1);
    if (operator === ts.SyntaxKind.QuestionQuestionToken)
      return left ? ((left.value ?? null) === null ? right : left) : null;
    if (!left || !right) return null;
    if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(operator))
      return { value: left.value === right.value };
    if ([ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(operator))
      return { value: left.value !== right.value };
    return null;
  }

  return { evaluate, fold, returnValues, fromRequest, provenance };
}
