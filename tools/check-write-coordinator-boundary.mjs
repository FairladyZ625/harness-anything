#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const legacyProductionPath = /^(?:packages\/kernel\/src\/(?:ports\/(?:artifact-store-writer|current-session-probe|lifecycle-engine|lock-registry|write-coordinator)\.ts|store\/(?:content-addressed-blob-store|daemon-runtime(?:-queue)?|ledger-materializer|local-lock-registry|write-journal[^/]*)\.ts|write-coordination\/)|packages\/cli\/src\/daemon\/(?:command-service|doc-sync-service|queued-write-coordinator)\.ts|packages\/application\/src\/(?:current-session-probe|decision-write-service|doc-sync|fact-write-service|provenance-binding|provenance-session-exporter|runtime-event-ledger-service|runtime-session-logs|session-entity-reader|task-write-route-policy)\.ts)$/u;
const coordinatedCommitAuthorities = Object.freeze([
  Object.freeze({ functionName: "prepareCommit", primitive: "gitObjects.importCommit(" }),
  Object.freeze({ functionName: "finalizeRefs", primitive: "gitObjects.updateRefs(" })
]);

export function findW3WriteAuthorityViolations(rootDir = process.cwd()) {
  const violations = [], files = walk(path.join(rootDir, "packages"), rootDir);
  for (const file of files.filter((candidate) => legacyProductionPath.test(candidate))) violations.push(`${file}: W3-retired production write path must not exist`);
  const cellPath = "packages/daemon/src/repo-cell.ts",
    storePath = "packages/kernel/src/store/task-event-store.ts",
    publisherPath = "packages/kernel/src/store/task-event-store-git-refs.ts",
    servicePath = "packages/application/src/task-lifecycle-service.ts";
  const cell = source(rootDir, cellPath, violations),
    store = source(rootDir, storePath, violations),
    publisher = source(rootDir, publisherPath, violations),
    service = source(rootDir, servicePath, violations);
  for (const token of ["makeTaskEventStore", "makeTaskLifecycleService", "eventStore: store", "tail.then"]) if (!cell.includes(token)) violations.push(`${cellPath}: missing RepoCell authority token ${token}`);
  if (!store.includes("CANONICAL_EVENT_REF")) violations.push(`${storePath}: missing object/ref publication token CANONICAL_EVENT_REF`);
  for (const authority of coordinatedCommitAuthorities) {
    const declarations = files.filter((file) => file.endsWith(".ts") && declaresFunction(
      source(rootDir, file, []), authority.functionName
    ));
    if (declarations.length !== 1 || declarations[0] !== publisherPath) {
      violations.push(
        `${authority.functionName} coordinated-commit authority must be declared exactly in ${publisherPath}; found ${declarations.join(", ") || "none"}`
      );
      continue;
    }
    const body = functionBody(publisher, authority.functionName);
    if (body === null || occurrences(body, authority.primitive) !== 1) {
      violations.push(`${publisherPath}: ${authority.functionName} must execute ${authority.primitive} exactly once`);
    }
    const primitiveFiles = files.filter((file) => file.endsWith(".ts") && source(rootDir, file, []).includes(authority.primitive));
    const totalPrimitiveCalls = primitiveFiles.reduce(
      (total, file) => total + occurrences(source(rootDir, file, []), authority.primitive),
      0
    );
    if (primitiveFiles.length !== 1 || primitiveFiles[0] !== publisherPath || totalPrimitiveCalls !== 1) {
      violations.push(
        `${authority.primitive} coordinated-commit primitive must belong only to ${authority.functionName} in ${publisherPath}`
      );
    }
  }
  for (const token of ["update-index", "checkout", "reset", "restore"]) if (publisher.includes(token)) violations.push(`${publisherPath}: object/ref publisher must not expose ${token}`);
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

function declaresFunction(body, functionName) {
  return new RegExp(`(?:^|\\n)(?:export\\s+)?function\\s+${functionName}\\s*\\(`, "u").test(body);
}
function functionBody(body, functionName) {
  const declaration = new RegExp(`(?:^|\\n)(?:export\\s+)?function\\s+${functionName}\\s*\\(`, "u").exec(body);
  if (declaration === null) return null;
  const start = body.indexOf("{", declaration.index + declaration[0].length);
  if (start < 0) return null;
  let depth = 0;
  for (let index = start; index < body.length; index += 1) {
    if (body[index] === "{") depth += 1;
    else if (body[index] === "}" && --depth === 0) return body.slice(start, index + 1);
  }
  return null;
}
function occurrences(body, token) {
  return body.split(token).length - 1;
}
function source(rootDir, relative, violations) { const file = path.join(rootDir, relative); if (!existsSync(file)) { violations.push(`${relative}: required W3 authority file is missing`); return ""; } return readFileSync(file, "utf8"); }
function walk(directory, rootDir) { if (!existsSync(directory)) return []; const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) { const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, rootDir)); else files.push(path.relative(rootDir, absolute).split(path.sep).join("/")); } return files; }
function main() { const violations = findW3WriteAuthorityViolations(); if (violations.length > 0) { console.error("W3 write authority boundary check failed:"); for (const violation of violations) console.error(`- ${violation}`); process.exitCode = 1; }
  else console.log("W3 write authority boundary check passed: RepoCell -> event store is the sole production write road."); }
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
