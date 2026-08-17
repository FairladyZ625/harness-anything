#!/usr/bin/env node
/**
 * Cross-aggregate judgment single-definition ratchet (DDD slice 3).
 * Authority: dec_399F48E3547D831F1199F51E84 CH1 and the DDD blueprint.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const judgments = ["closeoutReadiness", "factLiveness", "coverageOf", "blockingOf"];
const canonical = new Map([
  ["closeoutReadiness", "packages/kernel/src/domain/closeout-readiness.ts"],
  ["factLiveness", "packages/kernel/src/domain/fact-liveness.ts"],
  ["coverageOf", "packages/kernel/src/domain/decision-coverage.ts"],
  ["blockingOf", "packages/kernel/src/domain/task-blocking.ts"]
]);
const requiredConsumers = new Map([
  ["packages/kernel/src/domain/task-lifecycle.contract.ts", "closeoutReadiness("],
  ["packages/kernel/src/domain/completion-readiness.ts", "closeoutReadiness("],
  ["packages/kernel/src/projection/sqlite-task-source.ts", "domainCloseoutReadiness("],
  ["packages/kernel/src/projection/fact-event-projection.ts", "factLiveness("],
  ["packages/kernel/src/projection/fact-event-projection.ts#coverage", "coverageOf("],
  ["packages/kernel/src/projection/cold-rebuild-source.ts#liveness", "factLiveness("],
  ["packages/kernel/src/projection/cold-rebuild-source.ts#coverage", "coverageOf("],
  ["packages/daemon/src/repo-cell.ts#closeout", "closeoutReadiness("],
  ["packages/daemon/src/repo-cell.ts#blocking", "blockingOf("]
]);

export function checkDomainJudgmentSingleDefinition(root = process.cwd()) {
  const findings = [], files = walk(root, path.join(root, "packages"));
  for (const name of judgments) {
    const definition = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`, "gu"), hits = [];
    for (const file of files) { const count = [...readFileSync(file, "utf8").matchAll(definition)].length; for (let index = 0; index < count; index += 1) hits.push(relative(root, file)); }
    const expected = canonical.get(name);
    if (hits.length !== 1 || hits[0] !== expected) findings.push(`${name}: expected one definition at ${expected}; found ${hits.length ? hits.join(", ") : "none"}`);
  }
  for (const [key, call] of requiredConsumers) {
    const file = key.split("#")[0], body = read(root, file);
    if (!body.includes(call)) findings.push(`${file}: must consume named domain judgment ${call.slice(0, -1)}`);
  }
  const projectionBodies = files.filter((file) => /packages\/kernel\/src\/projection\//u.test(relative(root, file))).map((file) => [relative(root, file), readFileSync(file, "utf8")]);
  for (const [file, body] of projectionBodies) {
    if (/(?:EXISTS|NOT\s+EXISTS)[\s\S]{0,240}supersedes-fact/iu.test(body)) findings.push(`${file}: SQL infers Fact liveness instead of calling factLiveness`);
    if (/function\s+(?:coveragePath|firstFact|standingPolicy)\s*\(/u.test(body)) findings.push(`${file}: carries a second Decision coverage algorithm`);
  }
  const taskAdapter = read(root, "packages/gui/src/renderer/task-adapter.ts"), triadic = read(root, "packages/gui/src/renderer/triadic-data.ts"), guiTriadic = read(root, "packages/gui/src/renderer/model/triadic.ts");
  if (/function\s+(?:deriveBlocking|closeoutReadiness|gateResults)\s*\(/u.test(taskAdapter)) findings.push("packages/gui/src/renderer/task-adapter.ts: recomputes closeout or blocking judgment");
  if (!triadic.includes('invalidated: row.liveness === "retired"')) findings.push("packages/gui/src/renderer/triadic-data.ts: must consume projected fact liveness");
  if (/function\s+coverageOf\s*\(/u.test(guiTriadic)) findings.push("packages/gui/src/renderer/model/triadic.ts: carries a renderer coverage algorithm");
  return findings;
}

function read(root, rel) { try { return readFileSync(path.join(root, rel), "utf8"); } catch { return ""; } }
function relative(root, file) { return path.relative(root, file).split(path.sep).join("/"); }
function walk(root, dir) { const files = []; let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return files; } for (const entry of entries) { const full = path.join(dir, entry.name); if (entry.isDirectory()) { if (!["node_modules", "dist", "out"].includes(entry.name)) files.push(...walk(root, full)); } else if (/\.(?:ts|tsx|mts|js|jsx|mjs)$/u.test(entry.name) && !/(?:^|\/)(?:test|tests|fixtures)\//u.test(relative(root, full)) && !/\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(full); } return files; }

async function main() { const findings = checkDomainJudgmentSingleDefinition(); if (findings.length) { console.error("Domain judgment single-definition check failed:"); for (const finding of findings) console.error(`- ${finding}`); process.exit(1); } console.log("Domain judgment single-definition check passed (four judgments resolve to kernel domain services)." ); }
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
