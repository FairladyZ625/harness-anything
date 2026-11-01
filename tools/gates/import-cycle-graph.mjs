import ts from "typescript";

// Runtime import-cycle graph for the import-boundary gate.
//
// The graph only contains edges that survive TypeScript's type erasure: an import is an
// edge when at least one of its bindings is referenced in a value position, a re-export is
// an edge when the target module actually exports that name as a value, and side-effect /
// dynamic / require imports are always edges. Type-only imports and type-only re-exports
// are not runtime edges; treating them as cycles would demand refactors the compiled
// program does not need.

const scriptKind = (file) => (/\.(?:tsx|jsx)$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function declarationNames(statement) {
  if (ts.isVariableStatement(statement)) {
    const names = [];
    for (const declaration of statement.declarationList.declarations)
      if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
    return names;
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    return statement.name && ts.isIdentifier(statement.name) ? [statement.name.text] : [];
  }
  return [];
}

function isValueDeclaration(statement) {
  if (ts.isVariableStatement(statement)) return true;
  return (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  );
}

function isTypePosition(node, sourceFile) {
  let current = node;
  while (current && current !== sourceFile) {
    if (ts.isTypeNode(current)) {
      // `class A extends B` evaluates B at runtime even though the heritage clause is a TypeNode.
      if (ts.isExpressionWithTypeArguments(current)) {
        const heritage = current.parent;
        if (heritage && ts.isHeritageClause(heritage) && heritage.token === ts.SyntaxKind.ExtendsKeyword) return false;
      }
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isMemberNamePosition(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  return false;
}

function moduleInfo(sourceFile, resolveImport) {
  const file = sourceFile.fileName;
  const valueDeclarations = new Set();
  const directValueExports = new Set();
  const localExportRefs = [];
  const reexports = [];
  const namespaceExports = [];
  const starTargets = [];
  const imports = [];

  const addValueDeclaration = (statement) => {
    if (!isValueDeclaration(statement) || hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return;
    const names = declarationNames(statement);
    for (const name of names) {
      valueDeclarations.add(name);
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) directValueExports.add(name);
    }
    if (
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword) &&
      names.length === 0
    )
      directValueExports.add("default");
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = resolveImport(file, statement.moduleSpecifier.text);
      if (!target) continue;
      const clause = statement.importClause;
      if (!clause) {
        imports.push({ target, sideEffect: true, bindings: [], namespace: false });
        continue;
      }
      if (clause.isTypeOnly) continue;
      const bindings = [];
      if (clause.name) bindings.push({ local: clause.name.text, imported: "default" });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          bindings.push({
            local: element.name.text,
            imported: element.propertyName?.text ?? element.name.text,
          });
        }
      const namespace = Boolean(clause.namedBindings && ts.isNamespaceImport(clause.namedBindings));
      if (namespace)
        bindings.push({
          local: clause.namedBindings.name.text,
          imported: "*",
        });
      if (bindings.length > 0) imports.push({ target, sideEffect: false, bindings, namespace });
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement)) continue;
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveImport(file, statement.moduleSpecifier.text);
        if (!target) continue;
        if (!statement.exportClause) {
          starTargets.push(target);
          continue;
        }
        if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            if (element.isTypeOnly) continue;
            reexports.push({
              target,
              imported: element.propertyName?.text ?? element.name.text,
              exported: element.name.text,
            });
          }
          continue;
        }
        if (ts.isNamespaceExport(statement.exportClause)) {
          namespaceExports.push({ target, exported: statement.exportClause.name.text });
          continue;
        }
      }
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          localExportRefs.push({
            local: element.propertyName?.text ?? element.name.text,
            exported: element.name.text,
          });
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      directValueExports.add("default");
      continue;
    }
    addValueDeclaration(statement);
  }

  return {
    file,
    sourceFile,
    valueDeclarations,
    directValueExports,
    localExportRefs,
    reexports,
    namespaceExports,
    starTargets,
    imports,
  };
}

function collectImportBindingUsage(sourceFile) {
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) bindings.add(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) bindings.add(element.name.text);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      bindings.add(clause.namedBindings.name.text);
  }
  const used = new Set();
  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      bindings.has(node.text) &&
      !isMemberNamePosition(node) &&
      !isTypePosition(node, sourceFile)
    )
      used.add(node.text);
    ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isExportDeclaration(statement)
    )
      continue;
    visit(statement);
  }
  return used;
}

function collectDynamicEdges(sourceFile, resolveImport) {
  const targets = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
        const target = resolveImport(sourceFile.fileName, node.arguments[0].text);
        if (target) targets.push(target);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return targets;
}

export function stronglyConnectedComponents(nodes, adjacency) {
  let index = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  const strongConnect = (node) => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
      } else if (onStack.has(next)) lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(next)));
    }
    if (lowLinks.get(node) === indices.get(node)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      components.push(component);
    }
  };
  for (const node of nodes) if (!indices.has(node)) strongConnect(node);
  return components;
}

function witnessFor(component, adjacency) {
  const members = new Set(component);
  let best = null;
  for (const start of component) {
    const previous = new Map([[start, null]]);
    const queue = [start];
    let closed = null;
    while (queue.length > 0 && closed === null) {
      const node = queue.shift();
      for (const next of adjacency.get(node) ?? []) {
        if (next === start) {
          closed = node;
          break;
        }
        if (!members.has(next) || previous.has(next)) continue;
        previous.set(next, node);
        queue.push(next);
      }
    }
    if (closed === null) continue;
    const path = [];
    let cursor = closed;
    while (cursor !== null) {
      path.push(cursor);
      cursor = previous.get(cursor);
    }
    path.reverse();
    path.push(start);
    if (best === null || path.length < best.length) best = path;
  }
  return best ?? [...component, component[0]];
}

/**
 * Finds runtime import cycles among `files`.
 *
 * @param {{files: string[], readSource: (file: string) => string, resolveImport: (importer: string, specifier: string) => string | null}} input
 * @returns {{cycles: {files: string[], witness: string[]}[], edges: {importer: string, target: string, kind: string, names: string[]}[]}}
 */
export function analyzeRuntimeImportCycles({ files, readSource, resolveImport }) {
  const known = new Set(files);
  const sourceFiles = new Map();
  const sourceFileFor = (file) => {
    let sourceFile = sourceFiles.get(file);
    if (!sourceFile) {
      sourceFile = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true, scriptKind(file));
      sourceFiles.set(file, sourceFile);
    }
    return sourceFile;
  };

  const modules = new Map();
  for (const file of files) modules.set(file, moduleInfo(sourceFileFor(file), resolveImport));

  // Value exports need a fixpoint: local `export { x }` and `export * from` make a name a
  // value export depending on another module's value exports, and barrels may be mutually
  // recursive. Iterate until the sets stop growing.
  const valueExports = new Map(files.map((file) => [file, new Set(modules.get(file).directValueExports)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const module of modules.values()) {
      const exported = valueExports.get(module.file);
      const grow = (name) => {
        if (name === "default" || exported.has(name)) return;
        exported.add(name);
        changed = true;
      };
      for (const reference of module.localExportRefs) {
        if (module.valueDeclarations.has(reference.local)) grow(reference.exported);
        else {
          for (const imported of module.imports) {
            if (imported.sideEffect) continue;
            const binding = imported.bindings.find((candidate) => candidate.local === reference.local);
            if (!binding) continue;
            if (valueExports.get(imported.target)?.has(binding.imported)) grow(reference.exported);
          }
        }
      }
      for (const reexport of module.reexports)
        if (valueExports.get(reexport.target)?.has(reexport.imported)) grow(reexport.exported);
      for (const target of module.starTargets) for (const name of valueExports.get(target) ?? []) grow(name);
      for (const namespaceExport of module.namespaceExports) grow(namespaceExport.exported);
    }
  }

  const edges = [];
  const adjacency = new Map(files.map((file) => [file, []]));
  const addEdge = (importer, target, kind, names) => {
    if (!known.has(target)) return;
    adjacency.get(importer).push(target);
    edges.push({ importer, target, kind, names: names.filter(Boolean) });
  };

  for (const module of modules.values()) {
    const { file, sourceFile } = module;
    const used = collectImportBindingUsage(sourceFile);
    for (const imported of module.imports) {
      if (imported.sideEffect) {
        addEdge(file, imported.target, "side-effect", []);
        continue;
      }
      const names = [];
      for (const binding of imported.bindings) {
        if (used.has(binding.local)) {
          names.push(binding.local);
          continue;
        }
        const exportedAsValue =
          module.localExportRefs.some((reference) => reference.local === binding.local) &&
          (binding.imported === "*" || valueExports.get(imported.target)?.has(binding.imported) === true);
        if (exportedAsValue) names.push(binding.local);
      }
      if (names.length > 0) addEdge(file, imported.target, "import", names);
    }
    for (const reexport of module.reexports)
      if (valueExports.get(reexport.target)?.has(reexport.imported))
        addEdge(file, reexport.target, "reexport", [reexport.imported]);
    for (const target of module.starTargets) {
      const names = [...(valueExports.get(target) ?? [])].filter((name) => name !== "default");
      if (names.length > 0) addEdge(file, target, "reexport-star", names);
    }
    for (const namespaceExport of module.namespaceExports)
      addEdge(file, namespaceExport.target, "reexport-namespace", [namespaceExport.exported]);
    for (const target of collectDynamicEdges(sourceFile, resolveImport)) addEdge(file, target, "dynamic", []);
  }

  const cycles = [];
  for (const component of stronglyConnectedComponents(files, adjacency)) {
    const selfLoop =
      component.length === 1 && (adjacency.get(component[0]) ?? []).some((target) => target === component[0]);
    if (component.length < 2 && !selfLoop) continue;
    cycles.push({ files: component.sort(), witness: witnessFor(component, adjacency) });
  }
  cycles.sort((left, right) => right.files.length - left.files.length || left.files[0].localeCompare(right.files[0]));
  return { cycles, edges };
}

/** Renders one cycle as a readable `a -> b -> a` witness. */
export function formatCycleWitness(witness) {
  return witness.join(" -> ");
}
