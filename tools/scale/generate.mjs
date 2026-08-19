#!/usr/bin/env node

/**
 * Generate a deterministic, file-backed Harness-like scale fixture.
 *
 * The --entities value is the primary task count. Facts and decisions are
 * derived from the canonical task/decision ratio; event files are kept at a
 * configurable density so a 100k-task fixture remains runnable on a laptop.
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_SEED = "plt-scale-w1";
const DEFAULT_OUTPUT = "tmp/scale-fixtures/fixture";
const EVENT_DIRS = 256;

function usage() {
  console.error(`Usage: node tools/scale/generate.mjs --entities <N> [options]

Options:
  --entities N             Primary task count (recommended: 10000 or 100000)
  --seed VALUE             Deterministic seed (default: ${DEFAULT_SEED})
  --output PATH            Fixture directory (default: ${DEFAULT_OUTPUT})
  --events-per-task N      Event-file density (default: 2.5; accepts decimals)
  --force                  Remove an existing output directory
  --help                   Show this help`);
}

function args(argv) {
  const result = { entities: null, seed: DEFAULT_SEED, output: DEFAULT_OUTPUT, eventsPerTask: 2.5, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--help" || value === "-h") { usage(); process.exit(0); }
    if (value === "--force") { result.force = true; continue; }
    const next = argv[++i];
    if (value === "--entities") result.entities = Number(next);
    else if (value === "--seed") result.seed = next;
    else if (value === "--output") result.output = next;
    else if (value === "--events-per-task") result.eventsPerTask = Number(next);
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!Number.isInteger(result.entities) || result.entities < 1) throw new Error("--entities must be a positive integer");
  if (!Number.isFinite(result.eventsPerTask) || result.eventsPerTask < 0) throw new Error("--events-per-task must be non-negative");
  return result;
}

function hashSeed(input) {
  let hash = 2166136261;
  for (const char of String(input)) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function rng(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state = (Math.imul(state ^ state >>> 15, 1 | state) + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ state >>> 7, 61 | state) ^ state;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function int(random, min, max) { return min + Math.floor(random() * (max - min + 1)); }
function pick(random, values) { return values[Math.floor(random() * values.length)]; }
function pad(value, width = 6) { return String(value).padStart(width, "0"); }
function iso(index) { return new Date(Date.UTC(2024, 0, 1) + index * 3600_000).toISOString(); }
function body(random, label, targetBytes) {
  const seed = `${label} ${"The synthetic record preserves realistic prose length, metadata, and cross-entity context. "}`;
  let text = seed;
  while (Buffer.byteLength(text) < targetBytes) text += ` ${seed}`;
  return text.slice(0, targetBytes);
}

function write(path, content) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); }

function taskPackage(root, index, random, decisionId, factId) {
  const id = `task_scale_${pad(index)}`;
  const packageRoot = join(root, "harness", "tasks", id);
  const title = `${pick(random, ["Index", "Reconcile", "Measure", "Ship", "Review"])} synthetic workload ${pad(index)}`;
  const status = pick(random, ["planned", "active", "active", "done", "blocked"]);
  const docSize = int(random, 700, 2600);
  const frontmatter = `---\nschema: task-package/v2\ntask_id: ${id}\ntitle: "${title}"\nlifecycle:\n  status: ${status}\nvertical: software/coding\nprofile: baseline\n---\n`;
  write(join(packageRoot, "INDEX.md"), frontmatter + `\n# ${title}\n\n${body(random, title, docSize)}\n`);
  write(join(packageRoot, "task_plan.md"), `# ${title}\n\n## Brief\n${body(random, `${id} brief`, int(random, 180, 500))}\n\n## Goal\n${body(random, `${id} goal`, int(random, 350, 900))}\n\n## Verification\n- generated deterministic fixture\n`);
  write(join(packageRoot, "progress.md"), `# Progress\n\n## Log\n\n- ${iso(index)} generated\n- ${body(random, `${id} progress`, int(random, 180, 720))}\n`);
  write(join(packageRoot, "facts.md"), `# Facts\n\n## Records\n\n- fact/${factId}: ${body(random, `${id} fact`, int(random, 220, 1000))}\n`);
  write(join(packageRoot, "closeout.md"), `# Closeout\n\n## Summary\n${body(random, `${id} closeout`, int(random, 300, 900))}\n\n## Verification\nFixture record ${id} was generated with seed-controlled content.\n`);
  write(join(packageRoot, "review.md"), `# Review\n\nStatus: ${status === "done" ? "PASS" : "not-started"}\n\n${body(random, `${id} review`, int(random, 180, 650))}\n`);
  write(join(packageRoot, "task-contract.json"), JSON.stringify({ schema: "task-contract/v1", taskId: id, title, metadata: { parentTaskId: index ? `task_scale_${pad(Math.max(0, index - int(random, 1, Math.min(index, 20))))}` : null }, relations: [{ target: `decision/${decisionId}`, type: "derives" }, { target: `fact/${factId}`, type: "evidenced-by" }] }) + "\n");
  write(join(packageRoot, "artifacts", "summary.md"), `# ${title} artifact\n\n${body(random, `${id} artifact`, int(random, 200, 1400))}\n`);
  return { id, title, status, decisionId, factId };
}

function decisionPackage(root, index, random, task) {
  const id = `dec_scale_${pad(index)}`;
  const path = join(root, "harness", "decisions", `decision-${id}`, "decision.md");
  const title = `${pick(random, ["Projection", "Storage", "Query", "Writer"])} decision ${pad(index)}`;
  const size = int(random, 2600, 10500);
  const bodyText = `---\nschema: decision-package/v1\ndecision_id: ${id}\ntitle: "${title}"\nstate: ${pick(random, ["in_effect", "proposed", "superseded"])}\nriskTier: ${pick(random, ["low", "medium", "high"])}\nurgency: ${pick(random, ["low", "medium", "high"])}\nquestion: "How should synthetic workload ${pad(index)} be handled?"\nchosen: [{"id":"CH1","text":"${body(random, `${id} chosen`, Math.floor(size / 3)).replaceAll('"', "'")}"}]\nrelations: [{"target":"task/${task.id}","type":"derives"}]\n---\n\n# ${title}\n\n${body(random, `${id} rationale`, size)}\n`;
  write(path, bodyText);
  return id;
}

function factPackage(root, index, random, taskId) {
  const id = `fact_scale_${pad(index)}`;
  const path = join(root, "harness", "facts", id, "fact.md");
  const title = `${pick(random, ["observed", "measured", "confirmed", "reported"])} fixture fact ${pad(index)}`;
  write(path, `---\nschema: fact-package/v1\nfact_id: ${id}\nhost: ${taskId}\ncategory: observation\n---\n\n# ${title}\n\n${body(random, `${id} observation`, int(random, 300, 2200))}\n`);
  return id;
}

function eventFile(root, sequence, event, random) {
  const bucket = (sequence % EVENT_DIRS).toString(16).padStart(2, "0");
  const path = join(root, "harness", "events", bucket, `op_${pad(sequence, 10)}.json`);
  write(path, JSON.stringify({ schema: "task-event/v1", eventId: `evt_scale_${pad(sequence, 10)}`, workspaceRevision: sequence + 1, occurredAt: iso(sequence), type: event.type, taskId: event.taskId, payload: { ...event.payload, note: body(random, event.type, int(random, 80, 440)) } }) + "\n");
}

function main() {
  const options = args(process.argv.slice(2));
  const output = resolve(options.output);
  if (existsSync(output)) {
    if (!options.force) throw new Error(`Output exists: ${output} (use --force to replace it)`);
    rmSync(output, { recursive: true, force: true });
  }
  const random = rng(options.seed);
  const facts = Math.max(1, Math.round(options.entities * 0.45));
  const decisions = Math.max(1, Math.round(options.entities * 0.48));
  const events = Math.round(options.entities * options.eventsPerTask);
  mkdirSync(output, { recursive: true });
  const tasks = [];
  for (let index = 0; index < options.entities; index += 1) {
    const decisionId = `dec_scale_${pad(index % decisions)}`;
    const factId = `fact_scale_${pad(index % facts)}`;
    tasks.push(taskPackage(output, index, random, decisionId, factId));
  }
  for (let index = 0; index < facts; index += 1) factPackage(output, index, random, tasks[index % tasks.length].id);
  for (let index = 0; index < decisions; index += 1) decisionPackage(output, index, random, tasks[index % tasks.length]);
  const eventTypes = ["task_created", "task_progress", "fact_recorded", "decision_proposed", "relation_recorded", "task_completed"];
  for (let sequence = 0; sequence < events; sequence += 1) {
    const task = tasks[sequence % tasks.length];
    eventFile(output, sequence, { type: eventTypes[sequence % eventTypes.length], taskId: task.id, payload: { decisionId: task.decisionId, factId: task.factId, relation: sequence % 3 === 0 ? `decision/${task.decisionId}` : null } }, random);
  }
  // Keep metadata deterministic too: a fixture generated twice with the same
  // arguments must have identical bytes, not merely equivalent entities.
  const metadata = { schema: "scale-fixture/v1", seed: options.seed, primaryTaskCount: options.entities, factCount: facts, decisionCount: decisions, eventCount: events, eventsPerTask: options.eventsPerTask, eventDirectoryCount: EVENT_DIRS, model: { taskRatio: 1, factRatio: 0.45, decisionRatio: 0.48, docsPerTaskPackage: 8 } };
  write(join(output, "fixture-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  console.log(JSON.stringify({ output, ...metadata }, null, 2));
}

try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
