// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installReadProbe, resetReadProbe, snapshotReadProbe } from "./fixtures/g38-read-probe.mjs";
import { openReadBackend } from "./fixtures/g38-read-backend.mjs";
import { READ_PROBES, measureReadScale } from "./fixtures/g38-read-cost.mjs";
import { evaluateReadMeasurements } from "../../../tools/gates/cost-budget-reads.mjs";
import { sqliteWorkProbeUnavailableReason } from "./fixtures/g38-sqlite-work.mjs";

const platform = { skip: sqliteWorkProbeUnavailableReason() ?? false };

test("G38 excludes observer SQL after the legacy G1 probe is already installed", platform, () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { installCostProbe } from './packages/daemon/test/fixtures/g1-cost-probe.mjs';
    import { DatabaseSync } from 'node:sqlite';
    installCostProbe();
    const { installReadProbe, resetReadProbe, snapshotReadProbe } =
      await import('./packages/daemon/test/fixtures/g38-read-probe.mjs');
    installReadProbe();
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE selected(id INTEGER PRIMARY KEY); INSERT INTO selected VALUES(1)');
    resetReadProbe();
    db.prepare('SELECT count(*) AS total FROM selected').get();
    const result = snapshotReadProbe();
    db.close();
    console.log(JSON.stringify(result));
  `,
    ],
    { encoding: "utf8" },
  );
  const counts = JSON.parse(output.trim().split("\n").at(-1));
  assert.equal(counts.sqlRowsRead, 1, "EXPLAIN and observer-function rows must never enter the budget");
  assert.ok(counts.sqliteVmSteps > 0);
});

test("G38 observes SQLite internal filtered and aggregate scans at constant result k", platform, (t) => {
  installReadProbe();
  const modes = {
      filtered: "SELECT 1 AS present FROM history WHERE opaque = 'absent'",
      aggregate: "SELECT count(*) > 0 AS present FROM history WHERE id >= 0",
      "optimized-count": "SELECT count(*) AS present FROM history",
      indexed: "SELECT opaque FROM history WHERE id = 0",
    },
    measured = Object.fromEntries(Object.keys(modes).map((id) => [id, {}]));
  for (const [scale, size] of Object.entries({ small: 200, large: 2000 })) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE history(id INTEGER PRIMARY KEY, opaque TEXT)");
      const insert = db.prepare("INSERT INTO history VALUES (?, ?)");
      for (let id = 0; id < size; id++) insert.run(id, "p".repeat(512));
      for (const [id, sql] of Object.entries(modes)) {
        const statement = db.prepare(sql);
        resetReadProbe();
        const value = statement.get(),
          counts = snapshotReadProbe();
        measured[id][scale] = {
          size,
          resultSize: Number(value !== undefined),
          firstResultSize: Number(value !== undefined),
          counts,
          firstCall: counts,
        };
      }
    } finally {
      db.close();
    }
  }
  const entry = "method:fixture.internal.read";
  for (const [id, pair] of Object.entries(measured)) {
    const result = evaluateReadMeasurements({
      section: {
        schema: "read-cost-scaling-budget/v1",
        knownScaling: [],
        readCoverage: { measured: { [entry]: { measurements: [id] } }, notApplicable: [] },
      },
      inventory: [{ id: entry }],
      probes: { [id]: { reads: [entry] } },
      measured: { sqlite: { "runtime-sessions": { [id]: pair } } },
      backends: ["sqlite"],
      dimensions: ["runtime-sessions"],
    });
    t.diagnostic(JSON.stringify({ control: id, pair, errors: result.errors }));
    assert.equal(pair.small.resultSize, pair.large.resultSize);
    assert.equal(pair.small.counts.sqlRowsRead, pair.large.counts.sqlRowsRead);
    if (id === "optimized-count") {
      // The count gains one digit, within the unchanged byte allowance. OP_Count
      // can still execute a constant-size VM program while visiting every leaf page.
      assert.ok(pair.large.counts.sqlResultBytes - pair.small.counts.sqlResultBytes < 512);
      assert.match(result.errors.join("\n"), /sqliteScanPages/u);
    } else assert.equal(pair.small.counts.sqlResultBytes, pair.large.counts.sqlResultBytes);
    assert.equal(result.ok, id === "indexed", `${id}: internal work must determine the verdict`);
    if (id !== "indexed") assert.match(result.errors.join("\n"), /sqliteVmSteps|sqliteScanPages/u);
  }
});

test("G38 archive maintenance executes every deferred compaction reader", platform, async () => {
  const fixture = await openReadBackend("sqlite", "source-events", 2);
  try {
    const probe = READ_PROBES["archive-maintenance"];
    await probe.prepare(fixture, "source-events", 2);
    await probe.run(fixture);
    const archive = path.join(fixture.rootDir, ".harness/runtime/dispatches/archive"),
      files = readdirSync(archive);
    assert.equal(files.length, 2, "recent source streams must reach the real compactor");
    for (const file of files) {
      const lines = readFileSync(path.join(archive, file), "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(lines[0].transcriptCompactionVersion, 1, "deferred callback must rewrite the stream");
      assert.ok(
        lines.some((line) => line.transcriptCompactionResult),
        "real provider deltas must reach the planner",
      );
    }
  } finally {
    await fixture.close();
  }
});

test("G38 deferred compaction audit rejects quadratic whole-stream revisits", platform, async (t) => {
  const id = "archive-compaction-volume",
    entry = "background:archive-maintenance",
    pair = {};
  for (const [scale, size] of Object.entries({ small: 200, large: 2000 }))
    pair[scale] = (
      await measureReadScale("sqlite", "source-events", size, {
        probeIds: [id],
        quadraticArchiveControl: true,
      })
    )[id];
  const result = evaluateReadMeasurements({
    section: {
      schema: "read-cost-scaling-budget/v1",
      knownScaling: [],
      readCoverage: { measured: { [entry]: { measurements: [id] } }, notApplicable: [] },
    },
    inventory: [{ id: entry }],
    probes: { [id]: READ_PROBES[id] },
    measured: { sqlite: { "source-events": { [id]: pair } } },
    backends: ["sqlite"],
    dimensions: ["source-events"],
  });
  t.diagnostic(JSON.stringify({ control: "deferred compaction quadratic reads", pair, errors: result.errors }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /fileReadBytes.*source audit.*linear slope/u);
});
