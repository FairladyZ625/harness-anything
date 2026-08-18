#!/usr/bin/env node
/**
 * Full SQLite projection rebuild for the rename drill: replays every canonical
 * event through the kernel's real projection reducer, which re-derives and
 * asserts judgment-consent machineDigest and content-pin digest per decision
 * event — the strongest check that the replayer's recomputed digests are the
 * ones the current generation of code derives.
 *
 * Usage: node scripts/rename-drill/projection-rebuild.mjs --workspace <ws-root>
 */
import path from "node:path";
import { rmSync } from "node:fs";
import { makeTaskEventStore } from "../../packages/kernel/src/store/task-event-store.ts";
import { makeTaskProjection } from "../../packages/kernel/src/projection/rebuildable-task-projection.ts";

const args = Object.fromEntries(process.argv.slice(2).map((token, index, all) => token.startsWith("--") ? [token.slice(2), all[index + 1]] : []).filter((pair) => pair.length));
if (!args.workspace) { console.error("usage: projection-rebuild.mjs --workspace <workspace-root>"); process.exit(2); }
const projectionPath = path.join(args.workspace, ".harness/cache/task.sqlite");
rmSync(projectionPath, { force: true });
const store = makeTaskEventStore({ repoId: "canonical", rootInput: args.workspace });
const projection = makeTaskProjection({ rootDir: args.workspace, eventStore: store, projectionPath });
const started = Date.now();
const receipt = projection.rebuild();
console.log(JSON.stringify({ receipt, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
