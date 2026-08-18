#!/usr/bin/env node
/**
 * Freeze-cut census for the CH3 rename drill: one command, five groups of
 * stored-stock numbers, plus the typed-path classification proof that the
 * replayer shares (same module, same rule table, fail-closed on unknown paths).
 *
 * Usage: node scripts/rename-drill/census.mjs --repo <ledger-git-dir> [--ref refs/ha/canonical] [--workspace <ws>] [--json]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { classifyStatusPath, git, readAllEvents, streamTreeBlobs, walkStatusFields, WORD_MAP } from "./ledger-walk.mjs";

const args = parseArgs(process.argv.slice(2));
const repo = args.repo, ref = args.ref ?? "refs/ha/canonical";
if (!repo) { console.error("usage: census.mjs --repo <ledger-git-dir> [--ref <ref>] [--workspace <ws>] [--json]"); process.exit(2); }

const cut = (await git(repo, ["rev-parse", ref])).trim();
const head = JSON.parse(await git(repo, ["show", `${ref}:events/head.json`]));
const events = await readAllEvents(repo, ref);
const unclassified = new Set();

const inventory = new Map(); // "schema|type|path" -> { count, values, bucket }
const docs = { facts: { files: 0, liveDocs: 0, liveLines: 0, retiredDocs: 0, retiredLines: 0 }, decisions: { files: 0, activeDocs: 0, retiredDocs: 0, stateDistribution: {} }, relationRetired: { decisionDocs: 0, taskIndexDocs: 0, lines: 0 } };
const groups = {
  leaseActive: { uniqueEvents: 0, leasePhase: 0, releasedLeasePhase: 0 },
  factLive: { eventDirect: 0, docs: 0, lines: 0 },
  decisionActive: { uniqueEvents: 0, migrationSnapshots: 0, consentTargets: 0, contentPins: 0, docs: 0 },
  retired: { decisionUniqueEvents: 0, decisionDocs: 0, relationEvents: 0, relationObjects: 0, factEventDirect: 0, factDocs: 0, factLines: 0 },
  operation: { eventOutcomeRejected: 0, eventOutcomeDeferred: 0 },
};

for (const event of events) {
  const touched = { lease: false, decisionActive: false, decisionRetired: false, relation: false };
  walkStatusFields(event, event.schema, event.type, (schema, type, template, value) => {
    const bucket = classifyStatusPath(schema, type, template);
    const row = `${schema}|${type}|${template}`;
    if (!inventory.has(row)) inventory.set(row, { count: 0, values: new Map(), bucket });
    const entry = inventory.get(row);
    entry.count += 1;
    entry.values.set(String(value), (entry.values.get(String(value)) ?? 0) + 1);
    if (bucket === null) unclassified.add(row);
    if (bucket === null || bucket === "out-of-scope") return;
    const map = WORD_MAP[bucket];
    if (!Object.hasOwn(map, String(value))) return;
    if (bucket === "leasePhase") { touched.lease = true; groups.leaseActive[template === "payload.lease.phase" ? "leasePhase" : "releasedLeasePhase"] += 1; }
    if (bucket === "decisionState" && String(value) === "active") {
      touched.decisionActive = true;
      if (template === "payload.entity.decision.state") groups.decisionActive.migrationSnapshots += 1;
      if (template.endsWith("targetState")) groups.decisionActive.consentTargets += 1;
      if (template.endsWith("contentPin.state") || template.endsWith("contentPins[].state")) groups.decisionActive.contentPins += 1;
    }
    if (bucket === "decisionState" && String(value) === "retired") touched.decisionRetired = true;
    if (bucket === "relationState" && String(value) === "retired") { touched.relation = true; groups.retired.relationObjects += 1; }
    if (bucket === "factState" && String(value) === "live") groups.factLive.eventDirect += 1;
    if (bucket === "factState" && String(value) === "retired") groups.retired.factEventDirect += 1;
  });
  if (touched.relation) groups.retired.relationEvents += 1;
  if (touched.lease) groups.leaseActive.uniqueEvents += 1;
  if (touched.decisionActive) groups.decisionActive.uniqueEvents += 1;
  if (touched.decisionRetired) groups.retired.decisionUniqueEvents += 1;
  if (event.payload?.outcome === "rejected") groups.operation.eventOutcomeRejected += 1;
  if (event.payload?.outcome === "deferred") groups.operation.eventOutcomeDeferred += 1;
}

for await (const { path: file, body } of streamTreeBlobs(repo, ref, "tasks")) {
  if (file.endsWith("/facts.md")) {
    docs.facts.files += 1;
    let live = 0, retired = 0;
    for (const line of body.split("\n")) { if (line === "- State: live") live += 1; if (line === "- State: retired") retired += 1; }
    if (live) { docs.facts.liveDocs += 1; docs.facts.liveLines += live; }
    if (retired) { docs.facts.retiredDocs += 1; docs.facts.retiredLines += retired; }
  }
  if (file.endsWith("/INDEX.md")) { const hits = countRetiredRelationLines(body); if (hits) { docs.relationRetired.taskIndexDocs += 1; docs.relationRetired.lines += hits; } }
}
for await (const { path: file, body } of streamTreeBlobs(repo, ref, "decisions")) {
  if (file.endsWith("/decision.md")) {
    docs.decisions.files += 1;
    const state = /^state: (.+)$/mu.exec(body)?.[1];
    docs.decisions.stateDistribution[state ?? "missing"] = (docs.decisions.stateDistribution[state ?? "missing"] ?? 0) + 1;
    if (state === "active") docs.decisions.activeDocs += 1;
    if (state === "retired") docs.decisions.retiredDocs += 1;
    const hits = countRetiredRelationLines(body);
    if (hits) { docs.relationRetired.decisionDocs += 1; docs.relationRetired.lines += hits; }
  }
}

groups.factLive.docs = docs.facts.liveDocs; groups.factLive.lines = docs.facts.liveLines;
groups.decisionActive.docs = docs.decisions.activeDocs;
groups.retired.decisionDocs = docs.decisions.retiredDocs;
groups.retired.factDocs = docs.facts.retiredDocs; groups.retired.factLines = docs.facts.retiredLines;

const objectCount = Number((await git(repo, ["ls-tree", "-r", "--name-only", ref, "--", "objects"])).trim().split("\n").filter(Boolean).length);
const runtime = args.workspace ? censusRuntimeEvents(args.workspace) : null;
const report = {
  cut: { ref, sha: cut, revision: head.revision, eventCount: events.length, headEventDigest: head.eventDigest, objectCount, factsDocuments: docs.facts.files, decisionDocuments: docs.decisions.files },
  groups: { ...groups, operation: { ...groups.operation, ...(runtime ?? {}) } },
  documents: docs,
  typedPathInventory: Object.fromEntries(Object.entries(Object.fromEntries([...inventory.entries()].map(([row, { count, values, bucket }]) => [row, { count, bucket, values: Object.fromEntries([...values.entries()]) }]))).sort((a, b) => a[0].localeCompare(b[0]))),
};
if (unclassified.size > 0) report.unclassifiedTypedPaths = [...unclassified].sort();

if (args.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`cut ${cut} revision ${head.revision} events ${events.length} objects ${objectCount}`);
  for (const [name, group] of Object.entries(groups)) console.log(`${name.padEnd(20)} ${JSON.stringify(group)}`);
  console.log(`documents            ${JSON.stringify(docs)}`);
  console.log(`runtime              ${JSON.stringify(runtime ?? { skipped: true })}`);
  console.log(`unclassifiedTypedPaths ${unclassified.size}`);
  for (const [row, entry] of Object.entries(report.typedPathInventory)) console.log(`  ${String(entry.bucket).padEnd(14)} ${row} -> ${JSON.stringify(entry.values)}`);
}
if (unclassified.size > 0) { console.error(`FAIL-CLOSED: ${unclassified.size} unclassified typed status paths:\n${[...unclassified].sort().join("\n")}`); process.exit(1); }

function countRetiredRelationLines(body) {
  const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(body)?.[1] ?? "";
  let hits = 0;
  for (const line of frontmatter.split("\n")) {
    if (/^state:\s/u.test(line)) continue; // top-level decision/task state, counted separately
    if (/state["']?\s*:\s*["']?retired\b/u.test(line)) hits += 1;
  }
  return hits;
}
function censusRuntimeEvents(workspace) {
  const dir = path.join(workspace, ".harness", "generated", "runtime-events");
  let files = 0, rejected = 0, deferred = 0;
  const walk = (entry) => {
    for (const name of readdirSync(entry)) {
      const child = path.join(entry, name);
      if (statSync(child).isDirectory()) walk(child);
      else {
        files += 1;
        let body;
        try { body = readFileSync(child, "utf8"); } catch { continue; }
        if (/"(?:outcome|phase)"\s*:\s*"rejected"/u.test(body)) rejected += 1;
        if (/"(?:outcome|phase)"\s*:\s*"deferred"/u.test(body)) deferred += 1;
      }
    }
  };
  try { walk(dir); } catch { return { runtimeEventFiles: 0, runtimeRejectedFiles: 0, runtimeDeferredFiles: 0, runtimeEventsPresent: false }; }
  return { runtimeEventFiles: files, runtimeRejectedFiles: rejected, runtimeDeferredFiles: deferred, runtimeEventsPresent: true };
}
function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (index + 1 < argv.length && !String(argv[index + 1]).startsWith("--")) { out[key] = argv[index + 1]; index += 1; }
    else out[key] = true;
  }
  return out;
}
