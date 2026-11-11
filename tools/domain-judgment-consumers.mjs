import ts from "typescript";
import { createSourceImportResolver } from "./affected-tests.mjs";

/** Follow runtime exports, so renderer consumers can use the enforced browser/API boundary. */
export function judgmentImportResolver(root, sources) {
  const resolveImport = createSourceImportResolver(root, new Set(sources.keys()));
  const parsed = new Map();
  function source(file) {
    if (!parsed.has(file))
      parsed.set(file, ts.createSourceFile(file, sources.get(file) ?? "", ts.ScriptTarget.Latest, true));
    return parsed.get(file);
  }
  function exported(file, name, canonical, symbol, seen = new Set()) {
    const key = `${file}#${name}`;
    if (seen.has(key)) return false;
    const visited = seen;
    visited.add(key);
    const statements = source(file).statements;
    for (const statement of statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const clause = statement.exportClause;
        if (clause && !ts.isNamedExports(clause)) continue;
        const entry = clause?.elements.find((item) => !item.isTypeOnly && item.name.text === name);
        if (clause && !entry) continue;
        const original = entry ? (entry.propertyName ?? entry.name).text : name;
        if (statement.moduleSpecifier) {
          const target = resolveImport(file, statement.moduleSpecifier.text);
          if (target && exported(target, original, canonical, symbol, visited)) return true;
        } else if (file === canonical && original === symbol) return true;
        else if (imported(file, original, canonical, symbol, visited)) return true;
      }
      if (
        file === canonical &&
        name === symbol &&
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        statement.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === symbol &&
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)),
        )
      )
        return true;
      if (
        file === canonical &&
        name === symbol &&
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === symbol &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
        return true;
    }
    return false;
  }
  function imported(file, local, canonical, symbol, seen) {
    for (const statement of source(file).statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const entry = bindings.elements.find((item) => !item.isTypeOnly && item.name.text === local);
      if (!entry) continue;
      const target = resolveImport(file, statement.moduleSpecifier.text);
      if (target && exported(target, (entry.propertyName ?? entry.name).text, canonical, symbol, seen)) return true;
    }
    return false;
  }
  return (file, local, canonical, symbol) => imported(file, local, canonical, symbol, new Set());
}
