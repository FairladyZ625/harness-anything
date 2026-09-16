// S-tier: statically constructed migration-source fixtures for shapes that cannot be
// produced by the pre-S1 CLI or have zero historical data (design doc §7).
// Currently X27: malformed / non-pass / non-ci-gate witnesses. The migrator must NOT
// silently repair them — dry-run reports unsupported (ready=false).
// Run from the worktree root: node tools/migration-fixtures/generate-s-tier.mjs
import { readFileSync } from "node:fs";
import path from "node:path";

import { appendManifestEntry, cleanFixtureDir, FIXTURE_OUT, freezeRows, sha256 } from "./lib.mjs";

// Seed from a real F-tier witness event so the fixture is byte-real except for the
// deliberately malformed witness subobject.
function seedWitnessEvent() {
  const file = path.join(FIXTURE_OUT, "f-lifecycle-suite", "events.jsonl");
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    const event = JSON.parse(row.event_json);
    if (event.type === "completion_gate_verified" && event.payload?.witness) return row;
  }
  throw new Error("no completion_gate_verified row in f-lifecycle-suite; run generate-f-tier.mjs first");
}

function emit(id, shape, oracle, mutate) {
  const row = seedWitnessEvent();
  const event = JSON.parse(row.event_json);
  mutate(event);
  const eventJson = JSON.stringify(event);
  const frozen = {
    revision: row.revision,
    op_id: row.op_id,
    digest: `sha256:${sha256(eventJson)}`,
    occurred_at: row.occurred_at,
    recorded_at: row.recorded_at,
    event_json: eventJson,
    source_digest: row.digest,
  };
  const dir = cleanFixtureDir(id);
  freezeRows([frozen], dir, {
    fixture: id,
    tier: "S",
    source: "static: mutated copy of a real F-tier completion_gate_verified row",
    seededFrom: "f-lifecycle-suite",
    shapes: [shape],
    oracle,
  });
  appendManifestEntry({ id, tier: "S", path: id, shapes: [shape], oracle, eventCount: 1 });
  console.log(`${id}: static fixture written`);
}

emit(
  "s-x27-witness-missing-fields",
  "X27 字段不全的 witness(缺 result/gateId)",
  "dry-run 报 unsupported(ready=false)，不静默修补",
  (event) => {
    delete event.payload.witness.result;
    delete event.payload.witness.gateId;
  },
);
emit(
  "s-x27-witness-non-pass",
  "X27 非 pass witness(result=fail 却被接受的历史形态)",
  "dry-run 报 unsupported(ready=false)，不静默修补；不得当作满足 gate",
  (event) => {
    event.payload.witness.result = "fail";
  },
);
emit(
  "s-x27-witness-non-ci-gate",
  "X27 非 ci gate 的 witness",
  "dry-run 报 unsupported(ready=false)，不静默修补",
  (event) => {
    event.payload.witness.gateId = "custom-gate";
  },
);
