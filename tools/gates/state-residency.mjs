import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { readSourceIdentity } from "../gate-allowlists/source-identity.mjs";
import { listWorktreeFiles } from "./git.mjs";

// This catalog is also consumed by the import boundary. New drivers require
// scanner and import-boundary positive/negative controls in the same change.
export const cacheDriverCatalog = Object.freeze({
  redis: ["createClient"],
  ioredis: ["Redis", "default"],
  "@keyv/redis": ["KeyvRedis", "default"],
  "@upstash/redis": ["Redis"],
});
const fsWriteApis = new Set([
  "appendFile",
  "appendFileSync",
  "closeSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createWriteStream",
  "fsyncSync",
  "link",
  "linkSync",
  "mkdir",
  "mkdirSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync",
]);

export function scanBypassWriteCalls(root = process.cwd()) {
  const sources = listWorktreeFiles(root, ["packages"])
    .filter(
      (rel) =>
        /^packages\/[^/]+\/src\//u.test(rel) &&
        /\.[cm]?[jt]sx?$/u.test(rel) &&
        !/\.d\.[cm]?ts$/u.test(rel) &&
        !/(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__)(?:\/|\.)|\.(?:test|spec)\./u.test(rel),
    )
    .map((rel) => ({
      rel,
      source: ts.createSourceFile(rel, readFileSync(path.join(root, rel), "utf8"), ts.ScriptTarget.Latest, true),
    }));
  const localAdapters = new Set();
  for (const { rel, source } of sources) {
    visit(source, (node) => {
      if (
        ts.isClassDeclaration(node) &&
        node.name &&
        node.heritageClauses?.some(
          (clause) =>
            clause.token === ts.SyntaxKind.ImplementsKeyword &&
            clause.types.some((type) => /(?:^|\.)CrossProcessCachePort$/u.test(type.expression.getText(source))),
        )
      )
        localAdapters.add(`${rel}#${node.name.text}`);
    });
  }
  return sources.flatMap(({ rel, source }) => inspectSource(root, rel, source, localAdapters));
}

function inspectSource(root, rel, source, localAdapters) {
  const imports = importBindings(source);
  const sqlite = [...imports.values()].some(({ module }) => module === "node:sqlite");
  const opens = [];
  visit(source, (node) => {
    if (ts.isNewExpression(node) && importedSymbol(node.expression, imports)?.identity === "node:sqlite#DatabaseSync")
      opens.push(node);
  });
  // A type-only DatabaseSync import still describes a SQLite writer helper.
  // A file that opens only explicitly read-only databases has no writable API.
  const sqliteGoverned = sqlite && (opens.length === 0 || opens.some((node) => !readOnlySqliteOpen(node)));
  const findings = [];
  visit(source, (node) => {
    if (
      ts.isClassDeclaration(node) &&
      node.heritageClauses?.some(
        (clause) =>
          clause.token === ts.SyntaxKind.ImplementsKeyword &&
          clause.types.some((type) => /(?:^|\.)CrossProcessCachePort$/u.test(type.expression.getText(source))),
      )
    ) {
      const exported = node.name?.text ?? "default";
      const adapter = `${rel}#${exported}`;
      findings.push({ ...finding(source, rel, node, "cache", adapter), adapter });
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const symbol = importedSymbol(node.expression, imports);
      const api =
        symbol &&
        ["node:fs", "node:fs/promises", "fs", "fs/promises"].includes(symbol.module) &&
        fsWriteApis.has(symbol.export)
          ? symbol.export
          : ts.isNewExpression(node) && symbol?.identity === "node:sqlite#DatabaseSync" && !readOnlySqliteOpen(node)
            ? "DatabaseSync"
            : ts.isCallExpression(node) &&
                sqliteGoverned &&
                ts.isPropertyAccessExpression(node.expression) &&
                ["exec", "prepare"].includes(node.expression.name.text)
              ? `sqlite.${node.expression.name.text}`
              : undefined;
      if (api) findings.push(finding(source, rel, node, "write", api));
      let adapter = symbol && cacheDriverCatalog[symbol.module]?.includes(symbol.export) ? symbol.identity : undefined;
      if (!adapter && symbol) {
        const module = resolveLocalModule(root, rel, symbol.module);
        if (localAdapters.has(`${module}#${symbol.export}`)) adapter = `${module}#${symbol.export}`;
      }
      if (!adapter && ts.isIdentifier(node.expression) && localAdapters.has(`${rel}#${node.expression.text}`))
        adapter = `${rel}#${node.expression.text}`;
      if (adapter) findings.push({ ...finding(source, rel, node, "cache", adapter), adapter });
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      // Template text is reconstructed without evaluating source. Interpolated
      // const identifiers are resolved; unresolved names stay visible and fail closed.
      const sql = sqlText(node, source);
      const scanSql = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//gu, (comment) => " ".repeat(comment.length));
      const pattern =
        /\bCREATE\s+(?:(?:VIRTUAL|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+|\$\{[^}]+\})(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+))?)/giu;
      for (const match of scanSql.matchAll(pattern)) {
        const table = match[1]
          .replaceAll(/["`\s]/gu, "")
          .replaceAll("[", "")
          .replaceAll("]", "");
        const inline = /\/\*\s*@gate-identity\s+state-store\/([a-z][a-z0-9_.-]*)\s*\*\/\s*$/u.exec(
          sql.slice(0, match.index),
        );
        const item = finding(source, rel, node, "table", `CREATE TABLE ${table}`);
        // Each table in a multi-table literal has independent identity/debt.
        findings.push({
          ...item,
          medium: tableMedium(rel),
          identity: inline?.[1] ?? item.identity,
          table,
          key: `${item.key}#${table}`,
        });
      }
    }
  });
  return findings;
}

function tableMedium(rel) {
  // SQL emitted by the pg adapter and PostgreSQL schema/migration modules is
  // a different physical store from the embedded SQLite projection. The one
  // pg module that creates FTS helper tables explicitly opens node:sqlite.
  if (rel.startsWith("packages/storage/src/pg/") && !rel.endsWith("/pg-text-search.ts")) return "postgres-table";
  if (rel.startsWith("packages/storage/src/postgres/") || rel.startsWith("packages/storage/src/migration/postgres-"))
    return "postgres-table";
  return "sqlite-table";
}

function finding(source, rel, node, kind, api) {
  const identity =
    readSourceIdentity(node, source, "state-store") ??
    (node.expression ? readSourceIdentity(node.expression, source, "state-store") : null);
  const nonStateIdentity =
    readSourceIdentity(node, source, "non-state") ??
    (node.expression ? readSourceIdentity(node.expression, source, "non-state") : null);
  const medium =
    kind === "table"
      ? "sqlite-table"
      : kind === "cache"
        ? "shared-cache"
        : api === "DatabaseSync" || api.startsWith("sqlite.")
          ? "sqlite"
          : "filesystem";
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  const digest = createHash("sha256")
    .update(tokenText(node.getText(source)))
    .digest("hex")
    .slice(0, 16);
  return {
    kind,
    api,
    medium,
    path: rel,
    line: line + 1,
    column: character + 1,
    start: node.getStart(source),
    scope: scopeName(node, source),
    identity,
    nonStateIdentity,
    key: identity ?? `${rel}#${scopeName(node, source)}#${api}#${digest}`,
  };
}

function tokenText(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tokens = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    tokens.push(scanner.getTokenText());
  return tokens.join(" ");
}
function scopeName(node, source) {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (
      (ts.isFunctionDeclaration(cursor) || ts.isMethodDeclaration(cursor) || ts.isVariableDeclaration(cursor)) &&
      cursor.name
    )
      return cursor.name.getText(source);
  }
  return "<module>";
}
function importBindings(source) {
  const bindings = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) bindings.set(clause.name.text, { module, export: "default" });
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, { module, export: "*" });
    if (named && ts.isNamedImports(named))
      for (const element of named.elements)
        bindings.set(element.name.text, { module, export: (element.propertyName ?? element.name).text });
  }
  return bindings;
}
function importedSymbol(expression, bindings) {
  let symbol;
  if (ts.isIdentifier(expression)) symbol = bindings.get(expression.text);
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const namespace = bindings.get(expression.expression.text);
    if (namespace && ["*", "default"].includes(namespace.export)) {
      symbol = { module: namespace.module, export: expression.name.text };
      if (namespace.module === "node:fs" || namespace.module === "node:fs/promises") symbol.module = namespace.module;
    }
  }
  return symbol ? { ...symbol, identity: `${symbol.module}#${symbol.export}` } : undefined;
}
function resolveLocalModule(root, rel, module) {
  if (!module.startsWith(".")) return module;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), module));
  return /\.[cm]?[jt]sx?$/u.test(resolved) ? resolved : `${resolved}.ts`;
}
function readOnlySqliteOpen(node) {
  const options = node.arguments?.[1];
  return (
    options &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText() === "readOnly" &&
        property.initializer.kind === ts.SyntaxKind.TrueKeyword,
    )
  );
}
function sqlText(node, source) {
  if (!ts.isTemplateExpression(node)) return node.text;
  let result = node.head.text;
  for (const span of node.templateSpans) {
    let value = `\${${span.expression.getText(source)}}`;
    if (ts.isIdentifier(span.expression)) {
      const name = span.expression.text;
      visit(source, (candidate) => {
        if (
          ts.isVariableDeclaration(candidate) &&
          ts.isIdentifier(candidate.name) &&
          candidate.name.text === name &&
          candidate.initializer &&
          ts.isStringLiteral(candidate.initializer)
        )
          value = candidate.initializer.text;
      });
    }
    result += value + span.literal.text;
  }
  return result;
}
function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}
