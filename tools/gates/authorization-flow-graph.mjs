// Static source graph for the durable-authorization gate: lexical scopes, import resolution,
// callable evaluation and branch folding. Nothing here knows a production function name; the
// only anchors are the kernel authorities handed in through `facts`.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createSourceProgram } from "./authorization-source-program.mjs";
import {
  bindArguments,
  bindingNames,
  declareStatements,
  EMPTY_ENV,
  enclosingScopes,
  isFunctionNode,
  lexicalEnvironment,
  makeEnvironmentInterner,
  makeFileOf,
  memberName,
  registerSourceFileInterner,
  releaseSourceFileInterner,
  unwrap,
} from "./authorization-flow-env.mjs";
import { parseTypeScript, walkTypeScriptFiles } from "./ontology-gate-lib.mjs";

export { bindArguments, EMPTY_ENV, isFunctionNode, memberName, unwrap };

const sourceRoots = ["packages/daemon/src", "packages/authorization-keycloak/src", "packages/application/src"];
const maxEvaluationDepth = 12;
// A request travels through many frames before its effect; provenance is memoized per frame.
const maxProvenanceDepth = 64;

const policyIndexes = new WeakMap();
const serverSourceIndexes = new WeakMap();
const nonServerRoots = [
  "packages/gui/",
  "packages/cli/",
  "packages/dsh-plugin/",
  "packages/authorization-gui/",
  "packages/authorization-keycloak-gui/",
  "tools/",
];

/** Share source indexes while giving each audit its own evaluator/fact-scope identity. */
export function freshEvaluationGraph(graph) {
  graph.resetFramePool();
  return graph.freshQueries();
}

/** Exclude client/UI/tooling modules that cannot own or execute daemon server routes. */
export function serverSourceGraph(graph) {
  const included = (file) => !nonServerRoots.some((prefix) => file.startsWith(prefix));
  let indexes = serverSourceIndexes.get(graph.modules);
  if (!indexes) {
    indexes = {
      modules: new Map([...graph.modules].filter(([file]) => included(file))),
      members: new Map(
        [...graph.members]
          .map(([key, entries]) => [key, entries.filter((entry) => included(entry.file))])
          .filter(([, entries]) => entries.length > 0),
      ),
    };
    serverSourceIndexes.set(graph.modules, indexes);
  }
  return {
    ...graph,
    ...indexes,
    importTarget(binding) {
      const target = graph.importTarget(binding);
      return target.file && !included(target.file) ? { external: true } : target;
    },
  };
}

/** Keep the policy proof at its typed service boundary; source reachability uses the full graph. */
export function authorizationPolicyGraph(graph) {
  const included = (file) => sourceRoots.some((root) => file.startsWith(root + "/"));
  let indexes = policyIndexes.get(graph.modules);
  if (!indexes) {
    indexes = {
      modules: new Map([...graph.modules].filter(([file]) => included(file))),
      members: new Map(
        [...graph.members].map(([key, entries]) => [key, entries.filter((entry) => included(entry.file))]),
      ),
    };
    policyIndexes.set(graph.modules, indexes);
  }
  return {
    ...graph,
    ...indexes,
    importTarget(binding) {
      if (!binding.from.startsWith(".")) return { external: true };
      const target = graph.importTarget(binding);
      return target.file && !included(target.file) ? { external: true } : target;
    },
  };
}

/**
 * `rootDir` holds the traced sources; `anchorRoot` holds the kernel authority files the anchors
 * name (the same checkout unless a test traces a mutated copy of the sources).
 */
export function buildFlowGraph(
  rootDir,
  { anchorRoot = rootDir, sourceFiles = [], lexicalFiles = [], sourceOverrides = new Map(), oldProgram } = {},
) {
  const internEnv = makeEnvironmentInterner(lookup, freeParameters);
  const modules = new Map(),
    members = new Map(),
    typedEntries = new Map(),
    scopes = new WeakMap(),
    identifierLookups = new WeakMap(),
    callDeclarations = new WeakMap(),
    sourceFilesCache = new WeakMap(),
    memberSignatures = new WeakMap(),
    uniqueSymbolKeys = new WeakMap(),
    propertyLiteralCache = new WeakMap(),
    containerOwners = new WeakMap(),
    ownerCandidates = new WeakMap(),
    classInstanceTypes = new WeakMap(),
    ownerTargetTypes = new WeakMap(),
    assignabilityCache = new WeakMap(),
    takesInterfaceCache = new WeakMap(),
    carriesTransportCache = new WeakMap(),
    interfaceMemberMaps = new Map(),
    importTargets = new Map(),
    exportedBindings = new Map(),
    typeNames = new WeakMap(),
    anchorSources = new Map(),
    assignedValues = new Map(),
    singleAssignments = new Map(),
    nonSimpleWrites = new Set(),
    parameterQueries = new WeakMap(),
    pendingFreeParameters = [],
    activeParameters = new Set();
  const sourceFileOf = (node) => {
    let source = sourceFilesCache.get(node);
    if (!source) {
      source = node.getSourceFile();
      sourceFilesCache.set(node, source);
    }
    return source;
  };
  let files = [
    ...new Set([
      ...sourceRoots.flatMap((root) => walkTypeScriptFiles(rootDir, root)),
      ...sourceFiles,
      ...sourceOverrides.keys(),
    ]),
  ];
  const program = createSourceProgram(rootDir, { anchorRoot, files, sourceFiles, sourceOverrides, oldProgram }),
    checker = program.getTypeChecker(),
    programSources = new WeakSet(program.getSourceFiles()),
    relativeFiles = new WeakMap(),
    fileOf = makeFileOf(relativeFiles, sourceFileOf);
  // Declaration fallback can call an implementation outside the indexed source roots.
  // It still belongs to this Program and must use this graph's frame pool.
  files = [
    ...new Set([
      ...files,
      ...program
        .getSourceFiles()
        .map((file) => path.relative(rootDir, file.fileName).split(path.sep).join("/"))
        .filter(
          (file) =>
            (file.startsWith("packages/") || file.startsWith("tools/")) &&
            !file.includes("/node_modules/") &&
            !file.endsWith(".d.ts"),
        ),
      ...lexicalFiles,
    ]),
  ];
  for (const file of files) {
    const sourceFile =
        program.getSourceFile(path.join(rootDir, file)) ??
        (sourceOverrides.has(file)
          ? ts.createSourceFile(path.join(rootDir, file), sourceOverrides.get(file), ts.ScriptTarget.Latest, true)
          : parseTypeScript(rootDir, file)),
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
    if (programSources.has(sourceFile)) indexMembers(sourceFile, file);
  }
  // Index writes once per Program. A local's initializer alone does not describe `let db`
  // or values assigned by a nested callback; retain all their actual parameter dependencies.
  for (const { sourceFile } of modules.values())
    (function visit(node) {
      if (ts.isTypeNode(node)) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const simple = node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(unwrap(node.left));
        (function target(expression) {
          if (ts.isIdentifier(expression)) {
            if (ts.isPropertyAccessExpression(expression.parent) && expression.parent.name === expression) return;
            const binding = lookup(expression.text, expression);
            if (binding?.kind === "var" && !binding.moduleScoped) {
              const values = assignedValues.get(binding.declaration) ?? [];
              values.push(node.right);
              assignedValues.set(binding.declaration, values);
              if (!simple || singleAssignments.has(binding.declaration)) nonSimpleWrites.add(binding.declaration);
              else singleAssignments.set(binding.declaration, { expression: node.right, assign: node });
            }
          } else ts.forEachChild(expression, target);
        })(node.left);
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
        ts.isIdentifier(node.operand)
      ) {
        const binding = lookup(node.operand.text, node.operand);
        if (binding?.kind === "var" && !binding.moduleScoped) nonSimpleWrites.add(binding.declaration);
      }
      ts.forEachChild(node, visit);
    })(sourceFile);
  // Source lookup/type/free-parameter metadata depends only on this fixed tree.
  // Evaluation facts and argument frames belong to each fresh query context.
  const graph = {
    withSourceOverrides: (overrides) =>
      buildFlowGraph(rootDir, {
        anchorRoot,
        sourceFiles,
        lexicalFiles,
        sourceOverrides: overrides,
        oldProgram: program,
      }),
    freshQueries: () => ({ ...graph, ...queryContext(makeEnvironmentInterner(lookup, freeParameters)) }),
    rootDir,
    ...queryContext(internEnv),
    freeParameters,
    modules,
    members,
    typedEntries,
    lookup,
    importTarget,
    exportedBinding,
    fileOf,
    implementsMember,
    memberSignature,
    memberKey,
    uniqueSymbolKey,
    propertyAllowsLiteral,
    interfaceMembers,
    carriesTransport,
    takesInterface,
    callDeclaration: (node) => {
      if (callDeclarations.has(node)) return callDeclarations.get(node);
      const result = programSources.has(sourceFileOf(node))
        ? checker.getResolvedSignature(node)?.declaration
        : undefined;
      callDeclarations.set(node, result);
      return result;
    },
    typeName: (node) => {
      if (typeNames.has(node)) return typeNames.get(node);
      const result = programSources.has(sourceFileOf(node))
        ? checker.getTypeAtLocation(node).getSymbol()?.name
        : undefined;
      typeNames.set(node, result);
      return result;
    },
    singleAssignment(declaration) {
      if (!declaration || declaration.initializer || nonSimpleWrites.has(declaration)) return null;
      const entry = singleAssignments.get(declaration);
      if (!entry) return null;
      const enclosing = (node) => {
        for (let current = node?.parent; current; current = current.parent)
          if (isFunctionNode(current) || ts.isSourceFile(current)) return current;
        return null;
      };
      const scope = enclosing(declaration);
      if (!scope) return null;
      let withinScope = false;
      for (let current = entry.assign.parent; current; current = current.parent) {
        if (current === scope) {
          withinScope = true;
          break;
        }
        if (
          ts.isForStatement(current) ||
          ts.isForOfStatement(current) ||
          ts.isForInStatement(current) ||
          ts.isWhileStatement(current) ||
          ts.isDoStatement(current)
        )
          return null;
      }
      return withinScope ? entry : null;
    },
  };
  return graph;

  function queryContext(owner) {
    for (const sourceFile of program.getSourceFiles()) registerSourceFileInterner(sourceFile, owner);
    for (const { sourceFile } of modules.values()) registerSourceFileInterner(sourceFile, owner);
    return {
      internEnv: owner,
      resetFramePool: owner.resetFramePool,
      releaseQueries() {
        owner.resetFramePool();
        // Shared SourceFile keys must not retain a completed audit's frame owner.
        for (const sourceFile of program.getSourceFiles()) releaseSourceFileInterner(sourceFile, owner);
        for (const { sourceFile } of modules.values()) releaseSourceFileInterner(sourceFile, owner);
      },
    };
  }

  // This is lexical dependency analysis, independent of any descriptor's authority facts.
  // Only value references matter. Local aliases/functions/classes include their transitive
  // dependencies. Cycles reach a least fixed point instead of capturing unrelated parameters.
  function addFreeParameter(query, parameter) {
    if (!query.scopes.has(parameter.parent) || query.parameters.has(parameter)) return;
    query.parameters.add(parameter);
    if (!query.pending) {
      query.pending = true;
      pendingFreeParameters.push(query);
    }
  }

  function freeParameters(node) {
    const cached = parameterQueries.get(node);
    if (cached) return cached.parameters;
    const scopes = enclosingScopes(node),
      parameters = new Set(),
      query = { scopes, parameters, dependents: null, pending: false };
    // Publish the empty set before following dependencies so recursion adds an edge,
    // not an approximation. Parameter sets only grow; the worklist drains at the outer call.
    parameterQueries.set(node, query);
    function includeDependency(value, own = null) {
      const values = freeParameters(value),
        source = parameterQueries.get(value);
      source.dependents ??= new Map();
      const omissions = source.dependents.get(query) ?? new Set();
      omissions.add(own);
      source.dependents.set(query, omissions);
      for (const parameter of values) if (parameter.parent !== own) addFreeParameter(query, parameter);
    }
    // A function's body depends on its own arguments, but its value captures only
    // parameters outside its declaration. This also applies to const arrow aliases.
    function includeValue(value) {
      const expression = unwrap(value),
        own = isFunctionNode(expression) ? expression : null;
      includeDependency(value, own);
    }
    activeParameters.add(node);
    (function visit(current) {
      if (ts.isTypeNode(current)) return;
      if (ts.isIdentifier(current)) {
        const parent = current.parent;
        if (
          parent &&
          ((ts.isPropertyAccessExpression(parent) && parent.name === current) ||
            (ts.isBindingElement(parent) && parent.propertyName === current) ||
            (ts.isDeclarationName(current) && !ts.isShorthandPropertyAssignment(parent)))
        )
          return;
        const binding = lookup(current.text, current);
        if (binding?.kind === "param") addFreeParameter(query, binding.parameter);
        else if (binding?.kind === "var" && !binding.moduleScoped) {
          if (binding.declaration.initializer) includeValue(binding.declaration.initializer);
          for (const value of assignedValues.get(binding.declaration) ?? []) includeValue(value);
        } else if (["fn", "class"].includes(binding?.kind) && !ts.isSourceFile(binding.node.parent))
          includeValue(binding.node);
      } else if (current.kind === ts.SyntaxKind.ThisKeyword) {
        for (let scope = current.parent; scope && !ts.isSourceFile(scope); scope = scope.parent)
          if (ts.isClassLike(scope)) {
            includeDependency(scope);
            break;
          }
      }
      ts.forEachChild(current, visit);
    })(node);
    activeParameters.delete(node);
    if (activeParameters.size === 0) {
      // Each queued change adds a previously absent parameter. The finite lexical
      // parameter domains make this worklist terminate even for mutually recursive locals.
      for (let index = 0; index < pendingFreeParameters.length; index++) {
        const source = pendingFreeParameters[index];
        source.pending = false;
        for (const [dependent, omissions] of source.dependents ?? [])
          for (const parameter of source.parameters)
            for (const own of omissions)
              if (parameter.parent !== own) {
                addFreeParameter(dependent, parameter);
                break;
              }
      }
      pendingFreeParameters.length = 0;
    }
    return parameters;
  }

  /**
   * The anchor file as the program resolved it. The program's file names follow the paths its
   * imports resolved to, which is not always the real path of `anchorRoot/file`: a checkout under
   * a symlinked prefix (macOS /var -> /private/var) or a linked worktree spells one physical file
   * two ways. Try the declared root first, then its real path, and keep the resolved source.
   */
  function anchorSource(file) {
    const cached = anchorSources.get(file);
    if (cached) return cached;
    const candidate = path.join(anchorRoot, file),
      source =
        program.getSourceFile(path.join(rootDir, file)) ??
        program.getSourceFile(candidate) ??
        program.getSourceFile(fs.realpathSync(candidate));
    if (!source) throw new Error(`${file}: source is not part of the traced program`);
    anchorSources.set(file, source);
    return source;
  }

  /** The named interface in a kernel authority file, which must be an anchor of this program. */
  function anchorDeclaration(file, name) {
    const declaration = anchorSource(file).statements.find(
      (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === name,
    );
    if (!declaration) throw new Error(`${file}: interface ${name} is missing`);
    return declaration;
  }

  /**
   * Whether a parameter is a callback typed to receive the named kernel interface: the callee's
   * own contract that the value it is handed reaches the callback.
   */
  function takesInterface(parameter, file, name) {
    const cacheKey = `${file}\u0000${name}`;
    let byContract = takesInterfaceCache.get(parameter);
    if (byContract?.has(cacheKey)) return byContract.get(cacheKey);
    const declaration = anchorDeclaration(file, name),
      target = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(declaration.name)),
      type = checker.getNonNullableType(checker.getTypeAtLocation(parameter));
    const result = (type.isUnion() ? type.types : [type]).some((part) =>
      part.getCallSignatures().some((signature) =>
        signature.parameters.some((symbol) => {
          const accepted = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(symbol, parameter));
          return (
            !(accepted.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
            checker.isTypeAssignableTo(target, accepted) &&
            checker.isTypeAssignableTo(accepted, target)
          );
        }),
      ),
    );
    if (!byContract) takesInterfaceCache.set(parameter, (byContract = new Map()));
    byContract.set(cacheKey, result);
    return result;
  }

  /** Whether an argument is (or holds) an authentication context: a value with a transport discriminant. */
  function carriesTransport(node) {
    if (carriesTransportCache.has(node)) return carriesTransportCache.get(node);
    const type = checker.getTypeAtLocation(node);
    const result = (type.isUnion() ? type.types : [type]).some((part) =>
      checker.getPropertyOfType(part, "transportKind"),
    );
    carriesTransportCache.set(node, result);
    return result;
  }

  /** The member declarations of an interface in a kernel authority file, keyed by member name. */
  function interfaceMembers(file, name) {
    const cacheKey = `${file}\u0000${name}`;
    const cached = interfaceMemberMaps.get(cacheKey);
    if (cached) return cached;
    const declaration = anchorDeclaration(file, name);
    const map = new Map(
      declaration.members.filter((member) => member.name).map((member) => [memberName(member.name), member]),
    );
    interfaceMemberMaps.set(cacheKey, map);
    return map;
  }

  /** The declarations a property call names: interface signatures or the concrete member itself. */
  function memberSignature(access) {
    if (memberSignatures.has(access)) return memberSignatures.get(access);
    if (!programSources.has(sourceFileOf(access))) {
      memberSignatures.set(access, null);
      return null;
    }
    const symbol = checker.getSymbolAtLocation(ts.isElementAccessExpression(access) ? access : access.name),
      declarations = symbol?.declarations ?? [];
    const result = new Set();
    function resolve(declaration) {
      if (result.has(declaration)) return;
      result.add(declaration);
      const type = declaration.type;
      if (
        type &&
        ts.isIndexedAccessTypeNode(type) &&
        ts.isLiteralTypeNode(type.indexType) &&
        ts.isStringLiteral(type.indexType.literal)
      ) {
        const property = checker.getPropertyOfType(
          checker.getTypeFromTypeNode(type.objectType),
          type.indexType.literal.text,
        );
        for (const target of property?.declarations ?? []) resolve(target);
      }
    }
    declarations.forEach(resolve);
    const out = result.size === 0 ? null : result;
    memberSignatures.set(access, out);
    return out;
  }

  // Unique symbol types carry compiler-owned identity across imports. Keep that identity
  // separate from string keys; unresolved symbols still enumerate all possible members.
  function uniqueSymbolKey(expression) {
    if (!expression || !ts.isIdentifier(expression)) return null;
    if (uniqueSymbolKeys.has(expression)) return uniqueSymbolKeys.get(expression);
    if (!programSources.has(sourceFileOf(expression))) {
      uniqueSymbolKeys.set(expression, null);
      return null;
    }
    const type = checker.getTypeAtLocation(expression);
    const out = type.flags & ts.TypeFlags.UniqueESSymbol ? type : null;
    uniqueSymbolKeys.set(expression, out);
    return out;
  }

  // A derived result may use another discriminator namespace. Types can disprove a
  // request-field substitution; they never supply a positive authorization fact.
  function propertyAllowsLiteral(expression, key, value) {
    let byKey = propertyLiteralCache.get(expression);
    let allowed = byKey?.get(key);
    if (allowed === undefined) {
      if (!byKey) propertyLiteralCache.set(expression, (byKey = new Map()));
      if (!programSources.has(sourceFileOf(expression))) allowed = null;
      else {
        const property = checker.getTypeAtLocation(expression).getProperty(key);
        if (!property) allowed = null;
        else {
          const type = checker.getTypeOfSymbolAtLocation(property, expression),
            alternatives = type.isUnion() ? type.types : [type];
          allowed = alternatives.every((part) => part.flags & ts.TypeFlags.StringLiteral)
            ? new Set(alternatives.map((part) => part.value))
            : null;
        }
      }
      byKey.set(key, allowed);
    }
    return allowed === null ? null : allowed.has(value);
  }

  function memberKey(name) {
    return ts.isComputedPropertyName(name) ? uniqueSymbolKey(name.expression) : memberName(name);
  }

  function ownersOf(container) {
    let owners = containerOwners.get(container);
    if (!owners) {
      owners = [];
      if (ts.isObjectLiteralExpression(container)) {
        const contextual = checker.getContextualType(container);
        if (contextual) owners.push(contextual);
      } else if (ts.isClassLike(container))
        for (const clause of container.heritageClauses ?? [])
          for (const type of clause.types) owners.push(checker.getTypeAtLocation(type));
      containerOwners.set(container, owners);
    }
    return owners;
  }

  function ownerCandidatesFor(container, key) {
    let byKey = ownerCandidates.get(container);
    let candidates = byKey?.get(key);
    if (!candidates) {
      if (!byKey) ownerCandidates.set(container, (byKey = new Map()));
      candidates = [];
      for (const owner of ownersOf(container))
        for (const part of owner.isUnion() ? owner.types : [owner]) {
          const prop =
            typeof key === "string"
              ? checker.getPropertyOfType(part, key)
              : part.getProperties().find((property) => property.escapedName === key.escapedName);
          if (prop?.declarations) for (const candidate of prop.declarations) candidates.push(candidate);
        }
      byKey.set(key, candidates);
    }
    return candidates;
  }

  /** Whether an object/class member is contextually typed as one of the named signatures. */
  function implementsMember(declaration, key, signatures) {
    const container = declaration.parent;
    const candidates = ownerCandidatesFor(container, key);
    for (let index = 0; index < candidates.length; index++) if (signatures.has(candidates[index])) return true;
    // A class without an `implements` clause still receives calls typed through an interface it
    // structurally satisfies: that is where a typed member call dispatches.
    if (!ts.isClassLike(container) || !container.name) return false;
    let instance = classInstanceTypes.get(container);
    if (instance === undefined) {
      const symbol = checker.getSymbolAtLocation(container.name);
      instance = (symbol && checker.getDeclaredTypeOfSymbol(symbol)) || null;
      classInstanceTypes.set(container, instance);
    }
    if (!instance) return false;
    let byOwner = assignabilityCache.get(container);
    if (!byOwner) assignabilityCache.set(container, (byOwner = new WeakMap()));
    for (const signature of signatures) {
      const owner = signature.parent;
      if (!owner || !(ts.isInterfaceDeclaration(owner) || ts.isTypeLiteralNode(owner))) continue;
      let assignable = byOwner.get(owner);
      if (assignable === undefined) {
        let target = ownerTargetTypes.get(owner);
        if (target === undefined) {
          target = ts.isInterfaceDeclaration(owner)
            ? checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(owner.name))
            : checker.getTypeAtLocation(owner);
          ownerTargetTypes.set(owner, target);
        }
        assignable = checker.isTypeAssignableTo(instance, target);
        byOwner.set(owner, assignable);
      }
      if (assignable) return true;
    }
    return false;
  }

  function addMember(name, value, file, declaration) {
    if (name === null) return;
    const entries = members.get(name) ?? [];
    entries.push({ value, file, declaration });
    members.set(name, entries);
  }

  function indexMembers(node, file) {
    if (ts.isPropertyAssignment(node)) addMember(memberKey(node.name), node.initializer, file, node);
    else if (ts.isShorthandPropertyAssignment(node)) addMember(node.name.text, node.name, file, node);
    else if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) && node.body)
      addMember(memberKey(node.name), node, file, node);
    else if (ts.isPropertyDeclaration(node) && node.initializer)
      addMember(memberKey(node.name), node.initializer, file, node);
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

  function isBindingScope(scope) {
    return (
      ts.isSourceFile(scope) ||
      ts.isBlock(scope) ||
      ts.isModuleBlock(scope) ||
      ts.isCaseClause(scope) ||
      ts.isDefaultClause(scope) ||
      ts.isFunctionLike(scope) ||
      ts.isCatchClause(scope) ||
      ts.isForStatement(scope) ||
      ts.isForInStatement(scope) ||
      ts.isForOfStatement(scope) ||
      ts.isClassLike(scope)
    );
  }

  function lookup(name, from) {
    const cacheable = ts.isIdentifier(from) && name === from.text;
    if (cacheable && identifierLookups.has(from)) return identifierLookups.get(from);
    let result = null;
    for (let scope = from; scope; scope = scope.parent) {
      if (!isBindingScope(scope)) continue;
      const found = scopeBindings(scope).get(name);
      if (found) {
        result = found;
        break;
      }
      if (ts.isSourceFile(scope)) {
        const file = fileOf(scope),
          imported = modules.get(file)?.imports.get(name);
        result = imported ? { kind: "import", file, ...imported } : null;
        break;
      }
    }
    if (cacheable) identifierLookups.set(from, result);
    return result;
  }

  function importTarget(binding) {
    const cacheKey = `${binding.file}\u0000${binding.from}`;
    const cached = importTargets.get(cacheKey);
    if (cached) return cached;
    const resolved = ts.resolveModuleName(
      binding.from,
      path.join(rootDir, binding.file),
      program.getCompilerOptions(),
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    const file = resolved
      ? path.relative(rootDir, resolved).split(path.sep).join("/")
      : path.posix.normalize(path.posix.join(path.posix.dirname(binding.file), binding.from));
    let result;
    if (modules.has(file)) result = { file };
    else if (!binding.from.startsWith(".")) result = { external: true };
    // A sibling package outside the traced roots is an external boundary, not a broken edge.
    else
      result = fs.existsSync(path.join(rootDir, file))
        ? { external: true }
        : { broken: `${binding.file}: import ${binding.from} is missing` };
    importTargets.set(cacheKey, result);
    return result;
  }

  /** Only a real export qualifies: a same-named private function does not answer an import. */
  function exportedBinding(file, exported, seen = new Set()) {
    const topLevel = seen.size === 0;
    const cacheKey = topLevel ? `${file}\u0000${exported}` : null;
    if (cacheKey && exportedBindings.has(cacheKey)) return exportedBindings.get(cacheKey);
    if (seen.has(file)) return null;
    seen.add(file);
    const { sourceFile } = modules.get(file);
    let result = null;
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause))
        continue;
      const entry = statement.exportClause.elements.find((element) => element.name.text === exported);
      if (!entry) continue;
      const local = entry.propertyName?.text ?? entry.name.text;
      result = statement.moduleSpecifier
        ? { kind: "import", file, from: statement.moduleSpecifier.text, exported: local }
        : lookup(local, sourceFile);
      break;
    }
    if (!result) {
      const bindings = scopeBindings(sourceFile),
        binding = bindings.get(exported);
      if (!binding) {
        for (const statement of sourceFile.statements) {
          if (!ts.isExportDeclaration(statement) || statement.exportClause || !statement.moduleSpecifier) continue;
          const target = importTarget({ file, from: statement.moduleSpecifier.text, exported });
          const inherited = target.file && exportedBinding(target.file, exported, seen);
          if (inherited) {
            result = inherited;
            break;
          }
        }
      } else {
        const declared = binding.kind === "var" ? binding.declaration.parent.parent : binding.node;
        result = declared.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ? binding : null;
      }
    }
    if (cacheKey) exportedBindings.set(cacheKey, result);
    return result;
  }
}

// Member/type candidates and return syntax depend only on this immutable source index.
const evaluatorGraphScopes = new WeakMap();
// Fact folds remain keyed by the individual audit, never by the shared member index.
const evaluatorFactScopes = new WeakMap();
const EMPTY_SCOPE_MAP = Object.freeze({});
const UNSET_QUERY = Symbol("unset");

function getEvaluatorScope(graph, facts) {
  let graphScope = evaluatorGraphScopes.get(graph.members);
  if (!graphScope) {
    const promiseThenEntries = graph.members.get("then") ?? [];
    graphScope = {
      typedMemberCandidates: new WeakMap(),
      canonicalSignatures: new Map(),
      expressionIds: new WeakMap(),
      returnExpressionCache: new WeakMap(),
      nextExpressionId: 0,
      onlyExternalPromiseThen: promiseThenEntries.every((entry) => !/\.[cm]?[jt]sx?$/u.test(entry.file)),
    };
    evaluatorGraphScopes.set(graph.members, graphScope);
  }
  let factScopes = evaluatorFactScopes.get(graph);
  if (!factScopes) evaluatorFactScopes.set(graph, (factScopes = []));
  const strictMembers = Boolean(facts.strictMembers);
  const authorityModule = facts.authorityModule ?? "";
  const constants = facts.constants ?? EMPTY_SCOPE_MAP;
  const functions = facts.functions ?? EMPTY_SCOPE_MAP;
  const commandClass = facts.commandClass ?? "";
  const hasKind = Boolean(facts.kind);
  const hasMethod = facts.method !== undefined;
  const fieldKeys = facts.fields ? Object.keys(facts.fields).sort().join(",") : "";
  let factScope = factScopes.find(
    (entry) =>
      entry.strictMembers === strictMembers &&
      entry.authorityModule === authorityModule &&
      entry.constants === constants &&
      entry.functions === functions &&
      entry.commandClass === commandClass &&
      entry.hasKind === hasKind &&
      entry.hasMethod === hasMethod &&
      entry.fieldKeys === fieldKeys,
  );
  if (!factScope) {
    factScope = {
      strictMembers,
      authorityModule,
      constants,
      functions,
      commandClass,
      hasKind,
      hasMethod,
      fieldKeys,
      memberCache: new Map(),
      emptyValueQueries: new WeakMap(),
      emptyFoldQueries: new WeakMap(),
    };
    factScopes.push(factScope);
  }
  return { graphScope, factScope };
}

export function makeEvaluator(graph, facts) {
  const bindFrame = (fn, args, env) => bindArguments(fn, args, env, fn.env, graph.internEnv);
  const { graphScope, factScope } = getEvaluatorScope(graph, facts);
  const { typedMemberCandidates, canonicalSignatures, expressionIds, returnExpressionCache } = graphScope;
  const { memberCache, emptyValueQueries, emptyFoldQueries } = factScope;
  const unknown = { unknown: true },
    moduleEnv = EMPTY_ENV,
    lexicalEnv = graph.internEnv ? graph.internEnv.lexicalEnvironment : lexicalEnvironment,
    valueQueries = new WeakMap(),
    assignments = new Map(),
    writeReferences = new WeakMap(),
    provenanceCache = new WeakMap(),
    objectQueries = new WeakMap(),
    foldQueries = new WeakMap(),
    factFlagsByArray = new WeakMap();
  let queryFrame = null;

  function markDescriptorFact() {
    if (queryFrame) queryFrame.usedDescriptorFact = true;
  }

  function descriptorAllowsKind(parts) {
    if (facts.kind !== undefined) markDescriptorFact();
    return parts.every((part) => graph.propertyAllowsLiteral(part, "kind", facts.kind) !== false);
  }

  // Like provenance, these pure queries use immutable argument frames. A shared field
  // expression is one subproblem per frame and remaining depth, not a fresh receiver walk.
  const canInternEnv = graph.internEnv?.isCanonical;
  function cachedQuery(cache, expression, env, depth, calculate, pending = null, emptyCache = null) {
    let slot = cache.get(expression);
    if (!slot) {
      slot = {
        closed: graph.freeParameters ? graph.freeParameters(expression).size === 0 : false,
        empty: null,
        pendingDepths: null,
        rawEnv: null,
        rawCanonEnv: null,
        rawDepths: null,
        canonEnv: null,
        canonDepths: null,
        more: null,
      };
      cache.set(expression, slot);
    }
    let depths;
    let resolvedEnv;
    if (slot.closed || env.size === 0) {
      resolvedEnv = EMPTY_ENV;
      depths = slot.empty;
      if (!depths) slot.empty = depths = [];
    } else if (slot.rawEnv === env) {
      depths = slot.rawDepths;
      resolvedEnv = slot.rawCanonEnv;
    } else {
      resolvedEnv = lexicalEnv(expression, env);
      if (resolvedEnv.size === 0) {
        depths = slot.empty;
        if (!depths) slot.empty = depths = [];
      } else if (slot.canonEnv === null) {
        slot.canonEnv = resolvedEnv;
        slot.canonDepths = depths = [];
      } else if (slot.canonEnv === resolvedEnv) {
        depths = slot.canonDepths;
      } else {
        let more = slot.more;
        if (!more) slot.more = more = new WeakMap();
        depths = more.get(resolvedEnv);
        if (!depths) {
          depths = [];
          more.set(resolvedEnv, depths);
        }
      }
      if (!canInternEnv || canInternEnv(env)) {
        slot.rawEnv = env;
        slot.rawCanonEnv = resolvedEnv;
        slot.rawDepths = depths;
      }
    }
    if (resolvedEnv === EMPTY_ENV && emptyCache) {
      const sharedDepths = emptyCache.get(expression);
      if (sharedDepths && depth < sharedDepths.length && sharedDepths[depth] !== UNSET_QUERY) {
        return sharedDepths[depth];
      }
    }
    if (depth < depths.length && depths[depth] !== UNSET_QUERY) {
      if (queryFrame) {
        const cachedFlags = factFlagsByArray.get(depths)?.[depth] ?? 0;
        if (slot.pendingDepths?.includes(depth) || cachedFlags & 2) queryFrame.hitInFlight = true;
        if (cachedFlags & 1) queryFrame.usedDescriptorFact = true;
      }
      return depths[depth];
    }
    while (depths.length <= depth) depths.push(UNSET_QUERY);
    depths[depth] = pending;
    if (!slot.pendingDepths) slot.pendingDepths = [];
    slot.pendingDepths.push(depth);
    const parentFrame = queryFrame;
    const frame = { hitInFlight: false, usedDescriptorFact: false };
    queryFrame = frame;
    let result;
    try {
      result = calculate(expression, resolvedEnv, depth);
    } finally {
      queryFrame = parentFrame;
      slot.pendingDepths.pop();
    }
    if (parentFrame) {
      if (frame.hitInFlight) parentFrame.hitInFlight = true;
      if (frame.usedDescriptorFact) parentFrame.usedDescriptorFact = true;
    }
    depths[depth] = result;
    const storeFlags = (frame.usedDescriptorFact ? 1 : 0) | (frame.hitInFlight ? 2 : 0);
    if (storeFlags) {
      let flags = factFlagsByArray.get(depths);
      if (!flags) factFlagsByArray.set(depths, (flags = []));
      flags[depth] = storeFlags;
    }
    if (resolvedEnv === EMPTY_ENV && emptyCache && !frame.hitInFlight && !frame.usedDescriptorFact) {
      let sharedDepths = emptyCache.get(expression);
      if (!sharedDepths) emptyCache.set(expression, (sharedDepths = []));
      while (sharedDepths.length <= depth) sharedDepths.push(UNSET_QUERY);
      sharedDepths[depth] = result;
    }
    return result;
  }

  function evaluateBinding(binding, name, env, depth) {
    // A nested declaration closes over its enclosing frame; a module-level one over nothing.
    if (binding.kind === "fn")
      return [
        {
          fn: true,
          node: binding.node,
          env: ts.isSourceFile(binding.node.parent) ? moduleEnv : lexicalEnv(binding.node, env),
        },
      ];
    if (binding.kind === "class") return [{ classNode: binding.node, env }];
    if (binding.kind === "opaque") return [unknown];
    if (binding.kind === "import") {
      const target = graph.importTarget(binding);
      if (target.external) return [{ external: binding.exported }];
      if (target.broken) return [{ broken: target.broken }];
      const exported = graph.exportedBinding(target.file, binding.exported);
      return exported
        ? evaluateBinding(exported, binding.exported, EMPTY_ENV, depth + 1)
        : [{ broken: `${target.file}: ${binding.exported} is not exported` }];
    }
    const trail = binding.trail ?? [];
    if (binding.kind === "param") {
      const bound = env.get(binding.parameter);
      if (!bound) return [unknown];
      if (bound.rest) return [{ rest: true, arguments: bound.rest, env: bound.env }];
      // Following the caller's parameter frame is not another nested expression.
      return bound.root ? [bound] : project(evaluate(bound.expression, bound.env, depth), trail, depth);
    }
    const initializer = binding.declaration.initializer;
    return initializer
      ? project(evaluate(initializer, binding.moduleScoped ? moduleEnv : env, depth + 1), trail, depth)
      : [unknown];
  }

  function project(values, trail, depth) {
    return trail.reduce((current, key) => current.flatMap((value) => memberOf(value, key, depth)), values);
  }

  function memberOf(value, key, depth) {
    if (value.module) {
      const exported = graph.exportedBinding(value.module, key);
      return exported
        ? evaluateBinding(exported, key, EMPTY_ENV, depth + 1)
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
        if (property.name && graph.memberKey(property.name) === key) {
          if (ts.isPropertyAssignment(property)) return evaluate(property.initializer, value.env, depth + 1);
          if (ts.isShorthandPropertyAssignment(property)) return evaluate(property.name, value.env, depth + 1);
          if (facts.strictMembers && ts.isGetAccessorDeclaration(property) && property.body?.statements.length === 1) {
            const stmt = property.body.statements[0];
            if (stmt && ts.isReturnStatement(stmt) && stmt.expression && ts.isCallExpression(stmt.expression)) {
              const resolved = evaluate(stmt.expression, lexicalEnv(property, value.env), depth + 1).filter(
                (entry) => !entry.unknown,
              );
              if (resolved.length > 0) return resolved;
            }
          }
          return [{ fn: true, node: property, env: value.env }];
        }
      }
      return [unknown];
    }
    if (value.classNode) {
      const member = value.classNode.members.find((entry) => entry.name && graph.memberKey(entry.name) === key);
      if (member && ts.isMethodDeclaration(member) && member.body) return [{ fn: true, node: member, env: value.env }];
      if (member && ts.isPropertyDeclaration(member) && member.initializer)
        return evaluate(member.initializer, value.env, depth + 1);
    }
    return [unknown];
  }

  /** A dynamic key on a closed object can reach every authored member of that object. */
  function allMembersOf(value, depth) {
    if (!value.object) return [unknown];
    const members = [];
    for (const property of value.object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = evaluate(property.expression, value.env, depth + 1);
        for (const entry of spread) members.push(...(entry.object ? allMembersOf(entry, depth + 1) : [unknown]));
        continue;
      }
      if (!property.name) {
        members.push(unknown);
        continue;
      }
      if (ts.isPropertyAssignment(property)) members.push(...evaluate(property.initializer, value.env, depth + 1));
      else if (ts.isShorthandPropertyAssignment(property))
        members.push(...evaluate(property.name, value.env, depth + 1));
      else members.push({ fn: true, node: property, env: value.env });
    }
    return members.length > 0 ? distinct(members) : [unknown];
  }

  /** Name-indexed fallback for injected context objects; every candidate must itself resolve. */
  function canonicalSignatureToken(signatures, key) {
    if (signatures.size === 1) return signatures.values().next().value;
    if (signatures.size === 0) {
      const emptyKey = `empty:${key}`;
      let token = canonicalSignatures.get(emptyKey);
      if (!token) canonicalSignatures.set(emptyKey, (token = {}));
      return token;
    }
    const ids = [];
    for (const decl of signatures) {
      let id = expressionIds.get(decl);
      if (!id) expressionIds.set(decl, (id = ++graphScope.nextExpressionId));
      ids.push(id);
    }
    ids.sort((a, b) => a - b);
    const joined = ids.join(",");
    let token = canonicalSignatures.get(joined);
    if (!token) canonicalSignatures.set(joined, (token = {}));
    return token;
  }

  function memberCandidates(key, depth, access) {
    const signatures = access ? graph.memberSignature(access) : null;
    if (facts.strictMembers && !signatures) return [unknown];
    const sigToken = signatures ? canonicalSignatureToken(signatures, key) : null,
      cacheKey = sigToken ?? key;
    let byDepth = memberCache.get(cacheKey);
    if (byDepth) {
      if (byDepth.constValues) return byDepth.constValues;
      if (byDepth.has(depth)) return byDepth.get(depth);
    } else memberCache.set(cacheKey, (byDepth = new Map()));
    const all = graph.members.get(key) ?? [];
    if (all.length === 0) return [{ external: key }];
    // A typed receiver reaches only the implementations of its own interface member; an
    // untyped one keeps every same-named candidate, so a narrowing can never hide an effect.
    let entries;
    if (sigToken) {
      let byKey = typedMemberCandidates.get(sigToken);
      entries = byKey?.get(key);
      if (!entries) {
        if (!byKey) typedMemberCandidates.set(sigToken, (byKey = new Map()));
        entries = all.filter(
          (entry) => signatures.has(entry.declaration) || graph.implementsMember(entry.declaration, key, signatures),
        );
        byKey.set(key, entries);
      }
    } else entries = all;
    // A typed member whose implementation lives outside the traced packages is an external call.
    if (entries.length === 0) return [{ external: key }];
    let allFunctions = true;
    for (let i = 0; i < entries.length; i++) {
      if (!isFunctionNode(entries[i].value)) {
        allFunctions = false;
        break;
      }
    }
    if (allFunctions) {
      const values = distinct(entries.map(({ value }) => ({ fn: true, node: value, env: EMPTY_ENV })));
      byDepth.constValues = values;
      return values;
    }
    byDepth.set(depth, [unknown]);
    const values = distinct(
      entries.flatMap(({ value }) =>
        isFunctionNode(value)
          ? [{ fn: true, node: value, env: EMPTY_ENV }]
          : evaluate(value, EMPTY_ENV, depth + 1).filter((entry) => entry.fn || entry.broken),
      ),
    );
    byDepth.set(depth, values);
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
    const node = unwrap(expression);
    if (!node || literal(node) || ts.isRegularExpressionLiteral(node)) return [unknown];
    // The remaining nesting budget is an input: a deep unknown cannot answer a shallow query.
    return cachedQuery(valueQueries, node, env, depth, evaluateNode, [unknown], emptyValueQueries);
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
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      return [{ fn: true, node, env: lexicalEnv(node, env) }];
    if (ts.isObjectLiteralExpression(node)) return [{ object: node, env: lexicalEnv(node, env) }];
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
    ) {
      const left = evaluate(node.left, env, depth + 1);
      if (definitelyTruthyReference(node.left, env, depth + 1)) return left;
      return [...left, ...evaluate(node.right, env, depth + 1)];
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? memberName(node.name)
        : (() => {
            const argument = node.argumentExpression,
              folded = argument && fold(argument, env, depth + 1);
            return (
              graph.uniqueSymbolKey(argument) ??
              (folded && (typeof folded.value === "string" || typeof folded.value === "number")
                ? String(folded.value)
                : null)
            );
          })();
      // Policy dispatch must select the request's actual member. Only source reachability
      // may conservatively enumerate the authored alternatives of an unknown key.
      if (key === null && !facts.strictMembers) return [unknown];
      const receivers = evaluate(node.expression, env, depth + 1),
        direct = receivers.flatMap((value) =>
          value.object || value.classNode || value.module
            ? key === null && value.object
              ? allMembersOf(value, depth + 1)
              : memberOf(value, key, depth + 1)
            : [],
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
    const argumentsForBinding = expandArguments(node.arguments, env, depth + 1);
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
        value.fn ? returnValues(value, bindFrame(value, [callee.expression], env), depth + 1) : [unknown],
      );
    }
    return distinct(
      evaluate(callee, env, depth + 1).flatMap((value) =>
        value.fn
          ? returnValues(value, bindFrame(value, argumentsForBinding, env), depth + 1)
          : value.broken
            ? [value]
            : [unknown],
      ),
    );
  }

  /** Expand a spread of a traced rest parameter while retaining each argument's source frame. */
  function expandArguments(args, env, depth = 0) {
    return args.flatMap((argument) => {
      if (!ts.isSpreadElement(argument)) return [{ flowArgument: true, expression: argument, env }];
      const values = evaluate(argument.expression, env, depth + 1),
        rest = values.filter((value) => value.rest);
      if (rest.length > 0 && rest.length === values.length) return rest.flatMap((value) => value.arguments);
      return [{ flowArgument: true, expression: argument, env }];
    });
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
    if (binding.kind === "fn") return { value: true };
    if (binding.kind === "param") {
      const bound = env.get(binding.parameter);
      if (!bound) return null;
      if (bound.root)
        return binding.trail.length === 1 && binding.trail[0] ? requestField(binding.trail[0], "request") : null;
      if (bound.rest) return null;
      if (binding.trail.length === 1 && binding.trail[0])
        return fieldOf(bound.expression, binding.trail[0], bound.env, depth);
      return binding.trail.length === 0 ? fold(bound.expression, bound.env, depth) : null;
    }
    if (binding.kind === "import") {
      if (binding.from === facts.authorityModule && Object.hasOwn(facts.constants, binding.exported))
        return { value: facts.constants[binding.exported] };
      const target = graph.importTarget(binding);
      if (!target.file) return null;
      const exported = graph.exportedBinding(target.file, binding.exported);
      return exported?.kind === "var" && exported.trail.length === 0 && exported.declaration.initializer
        ? fold(exported.declaration.initializer, EMPTY_ENV, depth + 1)
        : null;
    }
    if (binding.kind !== "var" || !binding.declaration.initializer) return null;
    if (binding.trail.length === 1 && binding.trail[0])
      return fieldOf(
        binding.declaration.initializer,
        binding.trail[0],
        binding.moduleScoped ? moduleEnv : env,
        depth + 1,
      );
    if (binding.trail.length > 0 || !(binding.declaration.parent.flags & ts.NodeFlags.Const)) return null;
    return fold(binding.declaration.initializer, binding.moduleScoped ? moduleEnv : env, depth + 1);
  }

  /**
   * Request provenance. `request` values carry the descriptor's RPC method; `action` values are
   * the command object built from the request (a call over request data), which carries its kind.
   * A plain sub-field of the request, such as a repository id, carries neither kind nor action.
   */
  function provenance(expression, env, depth = 0) {
    if (depth > maxProvenanceDepth) return null;
    const node = unwrap(expression);
    if (!node || literal(node) || ts.isRegularExpressionLiteral(node)) return null;
    return cachedQuery(provenanceCache, node, env, depth, provenanceOf);
  }

  function provenanceOf(node, env, depth) {
    if (ts.isIdentifier(node)) {
      const binding = graph.lookup(node.text, node);
      if (binding?.kind === "param") {
        const bound = env.get(binding.parameter);
        if (!bound) return null;
        if (bound.root) return "request";
        if (bound.rest) return null;
        return provenance(bound.expression, bound.env, depth + 1);
      }
      if (binding?.kind !== "var") return null;
      const values = binding.declaration.initializer
        ? [binding.declaration.initializer]
        : assignedValues(binding.declaration);
      const tags = values.map((value) => provenance(value, binding.moduleScoped ? moduleEnv : env, depth + 1));
      const tag = tags.includes("action") ? "action" : tags.includes("request") ? "request" : null;
      return tag;
    }
    // A resolved command may be exposed as `resolution.action`. Other fields carry request
    // data, not the command discriminant: `contract.target.kind` must not borrow action.kind.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const tag = provenance(node.expression, env, depth + 1);
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(unwrap(node.argumentExpression))
          ? unwrap(node.argumentExpression).text
          : null;
      return tag === "action" && key !== "action" ? "request" : tag;
    }
    if (ts.isCallExpression(node)) {
      if (node.arguments.some((argument) => provenance(argument, env, depth + 1))) return "action";
      // A 0-arg IIFE closing over action data retains action provenance through its returned values.
      if (node.arguments.length === 0) {
        const callee = unwrap(node.expression);
        if (isFunctionNode(callee) && callee.body) {
          const callEnv = lexicalEnv(callee, env),
            tags = returnExpressions(callee).map((result) => provenance(result, callEnv, depth + 1));
          if (tags.length > 0 && tags.every((tag) => tag === "action")) return "action";
          if (tags.some(Boolean)) return "request";
        }
      }
      return null;
    }
    if (ts.isConditionalExpression(node)) {
      const condition = fold(node.condition, env, depth + 1);
      if (condition) return provenance(condition.value ? node.whenTrue : node.whenFalse, env, depth + 1);
    }
    // Text and choices computed from request data are request data.
    const parts = ts.isTemplateExpression(node)
      ? node.templateSpans.map((span) => span.expression)
      : ts.isConditionalExpression(node)
        ? [node.whenTrue, node.whenFalse]
        : ts.isBinaryExpression(node)
          ? [node.left, node.right]
          : null;
    if (parts) {
      const tags = parts.map((part) => provenance(part, env, depth + 1)),
        choice =
          ts.isConditionalExpression(node) ||
          (ts.isBinaryExpression(node) &&
            [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind));
      // Choosing between actions retains their coordinate. A compiler's distinct kind
      // namespace can disprove that identity even when it consumed action data.
      if (choice && tags.every((tag) => tag === "action") && descriptorAllowsKind(parts)) return "action";
      return tags.some(Boolean) ? "request" : null;
    }
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

  // Object/function literals are truthy. Follow only immutable aliases and parameters with
  // no writes; unknown or reassigned inputs must retain both coalescing alternatives.
  function definitelyTruthyReference(expression, env, depth) {
    const node = unwrap(expression);
    if (!node || depth > maxEvaluationDepth) return false;
    if (
      ts.isObjectLiteralExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    )
      return true;
    if (!ts.isIdentifier(node)) return false;
    const binding = graph.lookup(node.text, node);
    if (binding?.kind === "param") {
      const bound = env.get(binding.parameter);
      return Boolean(
        bound?.expression &&
          !bound.rest &&
          !hasWrites(binding.parameter) &&
          definitelyTruthyReference(bound.expression, bound.env, depth + 1),
      );
    }
    if (binding?.kind === "var" && binding.trail.length === 0 && binding.declaration.parent.flags & ts.NodeFlags.Const)
      return definitelyTruthyReference(
        binding.declaration.initializer,
        binding.moduleScoped ? moduleEnv : env,
        depth + 1,
      );
    return binding?.kind === "fn" && !hasWrites(binding.node);
  }

  function hasWrites(declaration) {
    if (writeReferences.has(declaration)) return writeReferences.get(declaration);
    let scope = declaration.parent,
      found = false;
    while (scope && !isFunctionNode(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    if (scope)
      (function visit(node) {
        const target =
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            ? node.left
            : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
                [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
              ? node.operand
              : ts.isForOfStatement(node) || ts.isForInStatement(node)
                ? node.initializer
                : null;
        if (target)
          (function reference(node) {
            if (ts.isIdentifier(node)) {
              const binding = graph.lookup(node.text, node);
              if ((binding?.declaration ?? binding?.parameter ?? binding?.node) === declaration) found = true;
            }
            if (!found) ts.forEachChild(node, reference);
          })(target);
        if (!found) ts.forEachChild(node, visit);
      })(scope);
    writeReferences.set(declaration, found);
    return found;
  }

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
  const SK_OBJECT_LITERAL = ts.SyntaxKind.ObjectLiteralExpression;
  const SK_CONDITIONAL = ts.SyntaxKind.ConditionalExpression;
  const SK_PROPERTY_ACCESS = ts.SyntaxKind.PropertyAccessExpression;
  const SK_CALL = ts.SyntaxKind.CallExpression;
  const SK_IDENTIFIER = ts.SyntaxKind.Identifier;

  function objectLiteralsOf(expression, env, depth = 0) {
    const node = unwrap(expression);
    if (!node || depth > maxEvaluationDepth * 2) return null;
    const kind = node.kind;
    if (
      kind !== SK_IDENTIFIER &&
      kind !== SK_PROPERTY_ACCESS &&
      kind !== SK_CALL &&
      kind !== SK_OBJECT_LITERAL &&
      kind !== SK_CONDITIONAL
    )
      return null;
    return cachedQuery(objectQueries, node, env, depth, objectLiteralsQuery);
  }

  function objectLiteralsQuery(node, env, depth) {
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
      if (owners.length === 1) return fieldLiterals(owners[0], node.name.text, depth + 1);
      const fields = owners.map((owner) => fieldLiterals(owner, node.name.text, depth + 1));
      return fields.every(Boolean) ? fields.flat() : null;
    }
    if (ts.isCallExpression(node)) {
      const callees = evaluate(node.expression, env, depth + 1);
      if (callees.length === 0 || !callees.every((value) => value.fn && value.node.body)) return null;
      const results = callees.flatMap((value) => {
        const callEnv = bindFrame(value, expandArguments(node.arguments, env, depth + 1), env);
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
      if (!bound?.expression || bound.rest) return null;
      source = bound.expression;
      sourceEnv = bound.env;
    } else if (binding?.kind === "var" && binding.declaration.initializer) {
      source = binding.declaration.initializer;
      sourceEnv = binding.moduleScoped ? moduleEnv : env;
    }
    if (!source || trail.length > 1) return null;
    const owners = objectLiteralsOf(source, sourceEnv, depth + (binding?.kind === "param" ? 0 : 1));
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
    const cached = returnExpressionCache.get(fn);
    if (cached) return cached;
    let results;
    if (!ts.isBlock(fn.body)) results = [fn.body];
    else {
      results = [];
      (function collect(node) {
        if (node !== fn.body && (isFunctionNode(node) || ts.isClassLike(node))) return;
        if (ts.isReturnStatement(node) && node.expression) results.push(node.expression);
        ts.forEachChild(node, collect);
      })(fn.body);
    }
    returnExpressionCache.set(fn, results);
    return results;
  }

  /**
   * A kind spelled from request data (`runtime-handoff-${operation}`) is the kind the request
   * selected when the descriptor's kind fits the authored spelling.
   */
  function requestSelectedKind(key, initializer, env) {
    const node = unwrap(initializer);
    if (key !== "kind" || facts.kind === undefined || !ts.isTemplateExpression(node)) return null;
    if (queryFrame) queryFrame.usedDescriptorFact = true;
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
    if (key === "method" && facts.method !== undefined) {
      markDescriptorFact();
      return { value: facts.method };
    }
    if (facts.fields && Object.hasOwn(facts.fields, key)) {
      markDescriptorFact();
      return { value: facts.fields[key] };
    }
    if (key === "kind" && tag === "action" && facts.kind !== undefined) {
      markDescriptorFact();
      return { value: facts.kind };
    }
    return null;
  }

  function fieldOf(baseExpression, key, env, depth, optional = false, optionalChain = false) {
    // Protocol fields: a durable descriptor's class is fixed, and a dry-run preview is not this route.
    if (key === "commandClass" && facts.commandClass) {
      markDescriptorFact();
      return { value: facts.commandClass };
    }
    if (key === "dryRun" && facts.kind) {
      markDescriptorFact();
      return { value: false };
    }
    const literals = objectLiteralsOf(baseExpression, env, depth + 1);
    if (literals) {
      if (literals.length === 1) return literalField(literals[0], key, depth);
      const first = literalField(literals[0], key, depth);
      if (!first) return null;
      for (let index = 1; index < literals.length; index++) {
        const candidate = literalField(literals[index], key, depth);
        if (!candidate || candidate.value !== first.value) return null;
      }
      return first;
    }
    const mightBeRequestField =
      (key === "method" && facts.method !== undefined) ||
      (key === "kind" && facts.kind !== undefined) ||
      Boolean(facts.fields && Object.hasOwn(facts.fields, key));
    if (mightBeRequestField) {
      markDescriptorFact();
      const tag = provenance(baseExpression, env);
      if (tag) {
        const field = requestField(key, tag);
        if (field && (key !== "kind" || graph.propertyAllowsLiteral(baseExpression, key, field.value) !== false))
          return field;
      }
    }
    const base = fold(baseExpression, env, depth + 1);
    if (!base) return null;
    if (base.value === null || base.value === undefined)
      return optional || (optionalChain && base.optionalShortCircuit)
        ? { value: undefined, optionalShortCircuit: true }
        : null;
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
    return fieldOf(
      node.expression,
      node.name.text,
      env,
      depth,
      Boolean(node.questionDotToken),
      ts.isOptionalChain(node),
    );
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
    // Pure expression or multi-statement const/if/return guards fold through their body.
    const callees = evaluate(callee, env, depth + 1);
    if (callees.length === 0 || !callees.every((value) => value.fn && value.node.body)) return null;
    const expandedArgs = expandArguments(node.arguments, env, depth + 1),
      results = callees.map((value) => {
        const callEnv = bindFrame(value, expandedArgs, env),
          body = value.node.body;
        if (!ts.isBlock(body)) return fold(body, callEnv, depth + 1);
        const outcome = foldStatements(body.statements, callEnv, depth + 1);
        return outcome ? (outcome.returned ? outcome.result : { value: undefined }) : null;
      });
    return results.every((result) => result && result.value === results[0].value) ? results[0] : null;
  }

  function foldStatements(statements, env, depth) {
    for (const statement of statements) {
      const outcome = foldStatement(statement, env, depth);
      if (!outcome) return null;
      if (outcome.returned) return outcome;
    }
    return { returned: false };
  }

  function foldStatement(statement, env, depth) {
    if (ts.isBlock(statement)) return foldStatements(statement.statements, env, depth);
    if (ts.isReturnStatement(statement))
      return {
        returned: true,
        result: statement.expression ? fold(statement.expression, env, depth) : { value: undefined },
      };
    if (ts.isVariableStatement(statement)) {
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) return null;
      for (const declaration of statement.declarationList.declarations)
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return null;
      return { returned: false };
    }
    if (ts.isIfStatement(statement)) {
      const condition = fold(statement.expression, env, depth);
      if (!condition) return null;
      if (condition.value) return foldStatement(statement.thenStatement, env, depth);
      return statement.elseStatement ? foldStatement(statement.elseStatement, env, depth) : { returned: false };
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
    if (depth > maxEvaluationDepth * 2) return null;
    const node = unwrap(expression);
    if (!node) return null;
    const constant = literal(node);
    if (constant) return constant;
    return cachedQuery(foldQueries, node, env, depth, foldQuery, null, emptyFoldQueries);
  }

  function foldQuery(node, env, depth) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { value: true };
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
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Set" &&
      node.arguments?.[0]
    ) {
      const values = fold(node.arguments[0], env, depth + 1);
      return values && Array.isArray(values.value) ? { value: new Set(values.value) } : null;
    }
    if (ts.isCallExpression(node)) {
      const frozen = unwrap(node.expression);
      if (
        ts.isPropertyAccessExpression(frozen) &&
        ts.isIdentifier(frozen.expression) &&
        frozen.expression.text === "Object" &&
        frozen.name.text === "freeze" &&
        node.arguments[0]
      )
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
    if (operator === ts.SyntaxKind.PlusToken) return { value: left.value + right.value };
    return null;
  }

  const externalFold = (expression, env, depth = 0) =>
    depth >= maxEvaluationDepth ? (literal(unwrap(expression)) ?? null) : fold(expression, env, depth);

  return {
    evaluate,
    fold: externalFold,
    returnValues,
    fromRequest,
    provenance,
    expandArguments,
    staticScope: factScope,
  };
}
