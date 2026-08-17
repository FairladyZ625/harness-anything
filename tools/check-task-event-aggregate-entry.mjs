#!/usr/bin/env node
/**
 * G-IRONLAW1 task_* event construction-site ratchet (blueprint 铁律一 · slice 2).
 *
 * Authorization: dec_399F48E3547D831F1199F51E84 CH1. Existing construction
 * sites are tolerated at their current counts; a new site or an extra event
 * constructor at an allowed site is refused.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { TASK_EVENT_CONSTRUCTION_ALLOWLIST } from "./gate-allowlists/task-event-aggregate-entry.mjs";

export { TASK_EVENT_CONSTRUCTION_ALLOWLIST };

const SOURCE_FILE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/u;

export function scanTaskEventConstructionSites(root = process.cwd()) {
  const sites = [];
  for (const file of walk(path.join(root, "packages"))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (!/(?:^|\/)src\//u.test(rel) || isTestOrFixturePath(rel)) continue;
    const body = readFileSync(file, "utf8"), source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true, scriptKind(file));
    const add = (node, form, eventType) => { const point = source.getLineAndCharacterOfPosition(node.getStart(source)); sites.push({ path: rel, form, eventType, line: point.line + 1, column: point.character + 1 }); };
    const visit = (node) => {
      if (ts.isPropertyAssignment(node) && propertyName(node.name) === "type" && ts.isStringLiteralLike(node.initializer) && node.initializer.text.startsWith("task_")) {
        add(node, "literal-type", node.initializer.text);
      }
      if (ts.isPropertyAssignment(node) && propertyName(node.name) === "schema" && ts.isStringLiteralLike(node.initializer) && node.initializer.text === "task-event/v1" && ts.isObjectLiteralExpression(node.parent)) {
        const typeProperty = node.parent.properties.find((candidate) => (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) && propertyName(candidate.name) === "type");
        if (typeProperty && (!ts.isPropertyAssignment(typeProperty) || !ts.isStringLiteralLike(typeProperty.initializer))) add(node, "dynamic-task-event", "<dynamic>");
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "envelope") {
        const eventType = node.arguments[1];
        if (eventType && ts.isStringLiteralLike(eventType) && eventType.text.startsWith("task_")) add(node, "envelope-call", eventType.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

export function checkTaskEventConstructionSites(sites, allowlist = TASK_EVENT_CONSTRUCTION_ALLOWLIST) {
  const grouped = new Map();
  for (const site of sites) { const key = siteKey(site); const values = grouped.get(key) ?? []; values.push(site); grouped.set(key, values); }
  const findings = [];
  for (const [key, values] of grouped) {
    const ceiling = allowlist[key];
    if (ceiling === undefined) findings.push(`${key}: task_* event construction is outside the aggregate-entry allowlist at ${locations(values)}`);
    else if (values.length > ceiling) findings.push(`${key}: found ${values.length} construction sites, allowlist ceiling is ${ceiling} (${locations(values)})`);
  }
  return findings;
}

async function main() {
  const sites = scanTaskEventConstructionSites(), findings = checkTaskEventConstructionSites(sites);
  if (findings.length) {
    console.error("Task event aggregate-entry check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Task event aggregate-entry check passed (${sites.length} allowlisted task_* construction sites).`);
}

function siteKey(site) { return `${site.path}|${site.form}|${site.eventType}`; }
function locations(sites) { return sites.map((site) => `${site.path}:${site.line}:${site.column}`).join(", "); }
function propertyName(node) { return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null; }
function scriptKind(file) { return file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : file.endsWith(".js") || file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS; }
function isTestOrFixturePath(rel) { return /(?:^|\/)(?:__fixtures__|fixtures|test|tests|e2e)\//u.test(rel) || /\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(rel); }
function walk(dir) { const files = []; let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } for (const entry of entries) { const full = path.join(dir, entry.name); if (entry.isDirectory()) { if (!["node_modules", "dist", "out"].includes(entry.name)) files.push(...walk(full)); } else if (SOURCE_FILE.test(entry.name)) files.push(full); } return files; }

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
