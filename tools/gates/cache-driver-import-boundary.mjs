import ts from "typescript";
import { cacheDriverCatalog } from "./state-residency.mjs";

export function auditCacheDriverImports(sources, registeredAdapterModules) {
  const registered = new Set(registeredAdapterModules);
  const findings = [];
  for (const { path, text } of sources) {
    if (/(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__)(?:\/|\.)|\.(?:test|spec)\./u.test(path)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text;
      if (!Object.hasOwn(cacheDriverCatalog, module)) continue;
      const adapter =
        /\/\*\s*@gate-identity\s+state-store\/[^\s*]+\s*\*\//u.test(text) &&
        /\bimplements\s+(?:[\w$.]+\.)?CrossProcessCachePort\b/u.test(text);
      if (!path.startsWith("packages/storage/src/") || !registered.has(path) || !adapter)
        findings.push({
          path,
          module,
          message: `cache driver ${module} must be imported by a registered storage CrossProcessCachePort adapter`,
        });
    }
  }
  return findings;
}

export function cacheDriverAdapterCandidates(sources) {
  const candidates = [];
  for (const { path, text } of sources) {
    if (
      !path.startsWith("packages/storage/src/") ||
      /(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__)(?:\/|\.)|\.(?:test|spec)\./u.test(path)
    )
      continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const importsDriver = source.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        Object.hasOwn(cacheDriverCatalog, statement.moduleSpecifier.text),
    );
    const implementsPort = source.statements.some(
      (statement) =>
        ts.isClassDeclaration(statement) &&
        statement.heritageClauses?.some(
          (clause) =>
            clause.token === ts.SyntaxKind.ImplementsKeyword &&
            clause.types.some((type) => /(?:^|\.)CrossProcessCachePort$/u.test(type.expression.getText(source))),
        ),
    );
    if (importsDriver && implementsPort) candidates.push(path);
  }
  return candidates;
}
