#!/usr/bin/env node
/**
 * G-IRONLAW1 task_* event construction-site ratchet (blueprint 铁律一 · slice 2).
 *
 * Authorization: dec_399F48E3547D831F1199F51E84 CH1. Existing construction
 * sites are tolerated at their current counts; a new site or an extra event
 * constructor at an allowed site is refused.
 *
 * The same scan covers authored_document_* events (dec_6B912A63D279A922FA1288536D
 * CH1): only the AuthoredDocument aggregate may construct them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { listWorktreeFiles } from "./gates/git.mjs";
import {
  AUTHORED_DOCUMENT_EVENT_CONSTRUCTION_ALLOWLIST,
  TASK_EVENT_CONSTRUCTION_ALLOWLIST,
} from "./gate-allowlists/task-event-aggregate-entry.mjs";

export { AUTHORED_DOCUMENT_EVENT_CONSTRUCTION_ALLOWLIST, TASK_EVENT_CONSTRUCTION_ALLOWLIST };

const EVENT_CONSTRUCTION_ALLOWLIST = Object.freeze({
  ...TASK_EVENT_CONSTRUCTION_ALLOWLIST,
  ...AUTHORED_DOCUMENT_EVENT_CONSTRUCTION_ALLOWLIST,
});

// Each aggregate's event family: its type prefix, envelope schema, and envelope constructor name.
const EVENT_FAMILIES = Object.freeze([
  { prefix: "task_", schema: "task-event/v1", constructor: "envelope" },
  { prefix: "authored_document_", schema: "authored-document-event/v1", constructor: "authoredDocumentEnvelope" },
]);

const SOURCE_FILE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/u;

export function scanTaskEventConstructionSites(root = process.cwd()) {
  const sites = [];
  const files = listWorktreeFiles(root, ["packages"]).filter(
    (rel) => SOURCE_FILE.test(rel) && /(?:^|\/)src\//u.test(rel) && !isTestOrFixturePath(rel),
  );
  if (files.length === 0)
    throw new Error("Task event aggregate-entry: required scan root packages has no source files");
  for (const rel of files) {
    const body = readFileSync(path.join(root, rel), "utf8"),
      source = ts.createSourceFile(rel, body, ts.ScriptTarget.Latest, true, scriptKind(rel));
    const add = (node, form, eventType) => {
      const point = source.getLineAndCharacterOfPosition(node.getStart(source));
      sites.push({ path: rel, form, eventType, line: point.line + 1, column: point.character + 1 });
    };
    const visit = (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node.name) === "type" &&
        ts.isStringLiteralLike(node.initializer) &&
        familyOfType(node.initializer.text)
      ) {
        add(node, "literal-type", node.initializer.text);
      }
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node.name) === "schema" &&
        ts.isStringLiteralLike(node.initializer) &&
        EVENT_FAMILIES.some((family) => family.schema === node.initializer.text) &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const typeProperty = node.parent.properties.find(
          (candidate) =>
            (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
            propertyName(candidate.name) === "type",
        );
        if (
          typeProperty &&
          (!ts.isPropertyAssignment(typeProperty) || !ts.isStringLiteralLike(typeProperty.initializer))
        )
          add(node, "dynamic-task-event", "<dynamic>");
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const eventType = node.arguments[1];
        if (
          eventType &&
          ts.isStringLiteralLike(eventType) &&
          familyOfType(eventType.text)?.constructor === node.expression.text
        )
          add(node, "envelope-call", eventType.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

export function checkTaskEventConstructionSites(sites, allowlist = EVENT_CONSTRUCTION_ALLOWLIST) {
  const grouped = new Map();
  for (const site of sites) {
    const key = siteKey(site);
    const values = grouped.get(key) ?? [];
    values.push(site);
    grouped.set(key, values);
  }
  const findings = [];
  for (const [key, values] of grouped) {
    const ceiling = allowlist[key];
    if (ceiling === undefined)
      findings.push(
        `${key}: aggregate event construction is outside the aggregate-entry allowlist at ${locations(values)}`,
      );
    else if (values.length > ceiling)
      findings.push(
        `${key}: found ${values.length} construction sites, allowlist ceiling is ${ceiling} (${locations(values)})`,
      );
  }
  return findings;
}

async function main() {
  const sites = scanTaskEventConstructionSites(),
    findings = checkTaskEventConstructionSites(sites);
  if (findings.length) {
    console.error("Task event aggregate-entry check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Task event aggregate-entry check passed (${sites.length} allowlisted task_* and authored_document_* construction sites).`,
  );
}

function familyOfType(eventType) {
  return EVENT_FAMILIES.find((family) => eventType.startsWith(family.prefix));
}
function siteKey(site) {
  return `${site.path}|${site.form}|${site.eventType}`;
}
function locations(sites) {
  return sites.map((site) => `${site.path}:${site.line}:${site.column}`).join(", ");
}
function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
}
function scriptKind(file) {
  return file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : file.endsWith(".js") || file.endsWith(".mjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
}
function isTestOrFixturePath(rel) {
  return (
    /(?:^|\/)(?:__fixtures__|fixtures|test|tests|e2e)\//u.test(rel) ||
    /\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(rel)
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
