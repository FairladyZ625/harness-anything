#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const legacyProductionPath = /^(?:packages\/kernel\/src\/(?:ports\/(?:artifact-store-writer|current-session-probe|lifecycle-engine|lock-registry|write-coordinator)\.ts|store\/(?:content-addressed-blob-store|daemon-runtime(?:-queue)?|ledger-materializer|local-lock-registry|write-journal[^/]*)\.ts|write-coordination\/)|packages\/cli\/src\/daemon\/(?:command-service|doc-sync-service|queued-write-coordinator)\.ts|packages\/application\/src\/(?:current-session-probe|decision-write-service|doc-sync|fact-write-service|provenance-binding|provenance-session-exporter|runtime-event-ledger-service|runtime-session-logs|session-entity-reader|task-write-route-policy)\.ts)$/u;

export function findW3WriteAuthorityViolations(rootDir = process.cwd()) {
  const violations = [], files = walk(path.join(rootDir, "packages"), rootDir);
  for (const file of files.filter((candidate) => legacyProductionPath.test(candidate))) violations.push(`${file}: W3-retired production write path must not exist`);
  const cellPath = "packages/daemon/src/repo-cell.ts", storePath = "packages/kernel/src/store/task-event-store.ts", servicePath = "packages/application/src/task-lifecycle-service.ts";
  const cell = source(rootDir, cellPath, violations), store = source(rootDir, storePath, violations), service = source(rootDir, servicePath, violations);
  for (const token of ["makeTaskEventStore", "makeTaskLifecycleService", "eventStore: store", "tail.then"]) if (!cell.includes(token)) violations.push(`${cellPath}: missing RepoCell authority token ${token}`);
  for (const token of ["CANONICAL_EVENT_REF", "prepareCommit", "finalizeRefs"]) if (!store.includes(token)) violations.push(`${storePath}: missing object/ref publication token ${token}`);
  for (const token of ["update-index", "checkout", "reset", "restore"]) if (store.includes(token)) violations.push(`${storePath}: object/ref publisher must not expose ${token}`);
  if (!service.includes("eventStore.append")) violations.push(`${servicePath}: lifecycle service must publish only through its eventStore port`);
  const consumers = files.filter((file) => file.endsWith(".ts") && !file.includes("/test/")).filter((file) => {
    const body = readFileSync(path.join(rootDir, file), "utf8"); return /(?<!function\s)\bmakeTaskEventStore\s*\(/u.test(body);
  });
  if (consumers.length !== 1 || consumers[0] !== cellPath) violations.push(`makeTaskEventStore production consumers must be exactly ${cellPath}; found ${consumers.join(", ") || "none"}`);
  for (const file of files.filter((candidate) => candidate.startsWith("packages/cli/src/") && candidate.endsWith(".ts"))) {
    const body = readFileSync(path.join(rootDir, file), "utf8");
    if (/from\s+["'][^"']*(?:kernel|application)\/src/u.test(body)) violations.push(`${file}: thin CLI must not import kernel/application domain modules`);
    if (/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|renameSync|mkdirSync)\s*\(/u.test(body)) violations.push(`${file}: thin CLI must not perform local writes`);
  }
  return violations;
}

function source(rootDir, relative, violations) { const file = path.join(rootDir, relative); if (!existsSync(file)) { violations.push(`${relative}: required W3 authority file is missing`); return ""; } return readFileSync(file, "utf8"); }
function walk(directory, rootDir) { if (!existsSync(directory)) return []; const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) { const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, rootDir)); else files.push(path.relative(rootDir, absolute).split(path.sep).join("/")); } return files; }
function main() { const violations = findW3WriteAuthorityViolations(); if (violations.length > 0) { console.error("W3 write authority boundary check failed:"); for (const violation of violations) console.error(`- ${violation}`); process.exitCode = 1; }
  else console.log("W3 write authority boundary check passed: RepoCell -> event store is the sole production write road."); }
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
