import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localesRoot = path.join(packageRoot, "src/renderer/i18n/locales");
const rendererRoot = path.join(packageRoot, "src/renderer");
const localeNames = ["en-US", "zh-CN"];
const errors = [];

function readLocale(locale) {
  const directory = path.join(localesRoot, locale);
  const files = readdirSync(directory).filter((file) => file.endsWith(".json")).sort();
  const messages = new Map();
  for (const file of files) {
    const catalog = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
    for (const [key, value] of Object.entries(catalog)) {
      if (messages.has(key)) errors.push(`${locale}: duplicate key ${key}`);
      if (!/^(components|graph|model|renderer|terminal|views)\.[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(key)) {
        errors.push(`${locale}: key is not a semantic domain identifier: ${key}`);
      }
      if (typeof value !== "string" || value.trim().length === 0) errors.push(`${locale}: empty message ${key}`);
      messages.set(key, value);
    }
  }
  return messages;
}

const locales = Object.fromEntries(localeNames.map((locale) => [locale, readLocale(locale)]));
const fallbackKeys = [...locales["en-US"].keys()].sort();

for (const locale of localeNames) {
  const keys = [...locales[locale].keys()].sort();
  for (const key of fallbackKeys.filter((key) => !locales[locale].has(key))) {
    errors.push(`${locale}: missing key ${key}`);
  }
  for (const key of keys.filter((key) => !locales["en-US"].has(key))) {
    errors.push(`${locale}: extra key ${key}`);
  }
}

for (const key of fallbackKeys) {
  const en = locales["en-US"].get(key) ?? "";
  const zh = locales["zh-CN"].get(key) ?? "";
  const enPlaceholders = placeholders(en);
  const zhPlaceholders = placeholders(zh);
  if (enPlaceholders.join("\0") !== zhPlaceholders.join("\0")) {
    errors.push(`${key}: placeholder mismatch en-US=[${enPlaceholders}] zh-CN=[${zhPlaceholders}]`);
  }
  if (/[一-龥]/.test(en)) errors.push(`en-US: CJK text remains in ${key}`);
}

for (const file of sourceFiles(rendererRoot)) {
  const sourceText = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node) => {
    let text;
    if (
      ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
      || ts.isJsxText(node)
    ) text = node.text;
    if (text && /[一-龥]/u.test(text)) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      errors.push(
        `renderer: CJK runtime literal ${path.relative(rendererRoot, file)}:${line + 1}:${character + 1}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function placeholders(message) {
  return [...message.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]).sort();
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.tsx?$/u.test(entry.name) ? [absolute] : [];
  });
}

if (errors.length > 0) {
  console.error("GUI locale coverage check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`GUI locale coverage check passed: ${fallbackKeys.length} keys across ${localeNames.join(" / ")}.`);
