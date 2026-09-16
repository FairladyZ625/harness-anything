// Validates the frozen migration-source fixtures: manifest completeness, per-scenario
// revision ordering, event-row digest integrity, and de-identification residue checks.
// Run from the worktree root: node tools/migration-fixtures/validate-fixtures.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { FIXTURE_OUT, readJsonLines, sha256 } from "./lib.mjs";

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const manifest = JSON.parse(readFileSync(path.join(FIXTURE_OUT, "manifest.json"), "utf8"));
check(manifest.schema === "migration-source-fixtures/v1", "manifest schema mismatch");

const REQUIRED_ORACLE = /^s-/u;
const covered = new Set();
for (const entry of manifest.fixtures) {
  check(entry.id && entry.tier && entry.path, `manifest entry missing id/tier/path: ${JSON.stringify(entry)}`);
  check(Array.isArray(entry.shapes) && entry.shapes.length > 0, `${entry.id}: no shapes recorded`);
  if (REQUIRED_ORACLE.test(entry.id)) check(Boolean(entry.oracle), `${entry.id}: S-tier fixture missing oracle`);
  for (const shape of entry.shapes ?? []) {
    const label = typeof shape === "string" ? shape : shape?.shape;
    const match = /X(\d+)/iu.exec(label ?? "");
    if (match) covered.add(Number(match[1]));
  }
  const dir = path.join(FIXTURE_OUT, entry.path);
  check(existsSync(dir), `${entry.id}: fixture dir missing`);
  if (!existsSync(dir)) continue;

  const meta = existsSync(path.join(dir, "meta.json"))
    ? JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"))
    : {};
  const rows = readJsonLines(path.join(dir, "events.jsonl"));
  const expectedCount = entry.eventCount ?? meta.eventCount;
  check(rows.length === expectedCount, `${entry.id}: eventCount ${expectedCount} != ${rows.length}`);
  check(rows.length > 0, `${entry.id}: empty events.jsonl`);

  let previous = 0;
  for (const row of rows) {
    check(row.revision > previous, `${entry.id}: revisions not strictly increasing at ${row.revision}`);
    previous = row.revision;
    check(`sha256:${sha256(row.event_json)}` === row.digest, `${entry.id}: row ${row.revision} digest mismatch`);
    const event = JSON.parse(row.event_json);
    check(
      typeof event.eventId === "string" && typeof event.opId === "string",
      `${entry.id}: row ${row.revision} missing eventId/opId`,
    );
  }
  if (entry.tier === "F") {
    check(meta.contiguous === true, `${entry.id}: F-tier ledger not contiguous`);
    check(existsSync(path.join(dir, "command-outcomes.jsonl")), `${entry.id}: missing command outcomes`);
  }
  if (entry.tier === "H" && entry.sourceTaskId) {
    // A few chain rows only referenced the task inside free-text fields that the
    // de-identifier rewrites; require the strong majority to still name the task.
    const named = rows.filter((row) => row.event_json.includes(entry.sourceTaskId)).length;
    check(
      named >= Math.ceil(rows.length * 0.8),
      `${entry.id}: only ${named}/${rows.length} rows name ${entry.sourceTaskId}`,
    );
  }

  // De-identification residue: no local user paths or real person ids in any frozen file.
  const scan = (sub) => {
    for (const file of readdirSync(path.join(dir, sub))) {
      const full = path.join(dir, sub, file);
      if (statSync(full).isDirectory()) {
        scan(path.join(sub, file));
        continue;
      }
      const text = readFileSync(full, "utf8");
      check(!/\/Users\/lizeyu/u.test(text), `${entry.id}/${sub}/${file}: local path leaked`);
      check(!/person_?zeyu|person_?lizeyu/u.test(text), `${entry.id}/${sub}/${file}: real personId leaked`);
    }
  };
  scan("");
}

// Coverage map against design §7: X29/X30 are R-tier (real-repo/full-scale runs), not fixtures.
for (const x of Array.from({ length: 28 }, (_, i) => i + 1)) {
  check(covered.has(x), `design §7 X${x} has no fixture`);
}

if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`OK: ${manifest.fixtures.length} fixtures, X1–X28 covered (X29/X30 are R-tier, not fixtures)`);
