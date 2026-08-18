#!/usr/bin/env node
/**
 * Full SQLite projection rebuild for the rename drill: replays every canonical
 * event through the kernel's real projection reducer against the real event
 * store. This exercises the complete read path over the new generation
 * (event parsing under the new vocabulary, claim/blob readback, reducer
 * admission rules) — note that live-write digest assertions
 * (assertDecisionJudgmentConsent / assertDecisionContentPin) run on the
 * daemon's apply path, NOT inside this batch reducer; digest verification is
 * covered by the replayer's source proofs and decision-digest-pair.mjs.
 *
 * Fails non-zero when the rebuild throws or when the rebuilt watermark does
 * not reach the ledger head revision.
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
const expectedRevision = store.readHead()?.revision ?? 0;
const projection = makeTaskProjection({ rootDir: args.workspace, eventStore: store, projectionPath });
const started = Date.now();
let receipt;
try { receipt = projection.rebuild(); } catch (error) { console.error(`projection rebuild failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
if (receipt.watermark !== expectedRevision) { console.error(`projection watermark ${receipt.watermark} does not match ledger head revision ${expectedRevision}`); process.exit(1); }
console.log(JSON.stringify({ receipt, expectedRevision, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
