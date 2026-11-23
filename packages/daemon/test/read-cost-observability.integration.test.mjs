// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { makeTaskEventReader, makeTaskEventStore } from "@harness-anything/storage";
import { eventAt, initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { installReadProbe, resetReadProbe, snapshotReadProbe } from "./fixtures/g38-read-probe.mjs";
import { openReadBackend } from "./fixtures/g38-read-backend.mjs";
import { READ_PROBES, measureReadScale } from "./fixtures/g38-read-cost.mjs";
import { evaluateReadMeasurements } from "../../../tools/gates/cost-budget-reads.mjs";
import { sqliteWorkProbeUnavailableReason } from "./fixtures/g38-sqlite-work.mjs";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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

test(
  "G38 DM-03 sparse date-window audit export cost stays bounded as non-matching revision gap grows 10x (full-day, narrow intra-day, and >32-day wide)",
  platform,
  async (t) => {
    installReadProbe();
    const scenarios = [
      {
        name: "full-day",
        after: "2026-11-05T00:00:00.000Z",
        before: "2026-11-05T23:59:59.999Z",
        matchAt: () => "2026-11-05T12:00:00.000Z",
        gapAt: () => "2026-11-06T12:00:00.000Z",
      },
      {
        name: "narrow-intraday",
        after: "2026-11-05T10:00:00.000Z",
        before: "2026-11-05T10:59:59.999Z",
        matchAt: (idx) => new Date(Date.parse("2026-11-05T10:00:00.000Z") + idx * 1_000).toISOString(),
        gapAt: () => "2026-11-05T18:00:00.000Z",
      },
      {
        name: "wide-40-days",
        after: "2026-09-01T00:00:00.000Z",
        before: "2026-10-10T23:59:59.999Z",
        matchAt: (idx) =>
          new Date(
            Date.parse("2026-09-01T06:00:00.000Z") + Math.floor(idx / 5) * 86_400_000 + (idx % 5) * 1_000,
          ).toISOString(),
        gapAt: () => "2026-11-15T12:00:00.000Z",
      },
    ];
    scenarios.push({
      name: "descending-timestamps",
      after: "2026-11-05T10:00:00.000Z",
      before: "2026-11-05T10:59:59.999Z",
      matchAt: (idx) => new Date(Date.parse("2026-11-05T10:40:00.000Z") - idx * 1_000).toISOString(),
      gapAt: () => "2026-11-05T18:00:00.000Z",
    });
    for (const scenario of scenarios) {
      const descending = scenario.name === "descending-timestamps";
      const measured = {};
      for (const scale of ["small", "large"]) {
        const gapSize = descending ? 17 : scale === "small" ? 200 : 2000;
        const matchesPerSide = descending && scale === "large" ? 400 : 100;
        const rootDir = mkdtempSync(path.join(tmpdir(), `ha-g38-sparse-${scenario.name}-`));
        try {
          initRepo(rootDir);
          const repoId = `g38-sparse-${scenario.name}-${scale}`;
          let store = makeTaskEventStore({ rootDir, repoId });
          const matchingBefore = matchesPerSide;
          const matchingAfter = matchesPerSide;
          const total = matchingBefore + gapSize + matchingAfter;
          let matchIdx = 0;
          for (let offset = 0; offset < total; offset += 100) {
            const end = Math.min(total, offset + 100);
            const bundles = [];
            for (let rev = offset + 1; rev <= end; rev += 1) {
              const inWindow = rev <= matchingBefore || rev > matchingBefore + gapSize;
              const ev = {
                ...eventAt(rev),
                occurredAt: inWindow ? scenario.matchAt(matchIdx++) : scenario.gapAt(),
              };
              bundles.push({ event: ev, plan: taskLifecycleWritePlan(ev), blobs: [] });
            }
            const terminal = bundles.pop();
            store.append({ ...terminal, preceding: bundles });
          }
          await store.drain();
          store = makeTaskEventReader({ rootDir, repoId });
          try {
            resetReadProbe();
            let afterRevision = 0;
            let maxRevision;
            let continuation;
            let totalMatched = 0;
            let pages = 0;
            for (;;) {
              const page = store.readEventWindow({
                afterRevision,
                ...(maxRevision === undefined ? {} : { maxRevision }),
                ...(continuation === undefined ? {} : { continuation }),
                after: scenario.after,
                before: scenario.before,
                limit: 50,
              });
              pages += 1;
              for (const event of page.events) {
                totalMatched += 1;
                assert.equal(event.workspaceRevision, totalMatched + (totalMatched > matchingBefore ? gapSize : 0));
              }
              maxRevision = page.windowMaxRevision;
              continuation = page.continuation;
              if (page.done) break;
              afterRevision = page.lastScannedRevision;
            }
            const counts = snapshotReadProbe();
            assert.equal(totalMatched, matchingBefore + matchingAfter, scenario.name);
            assert.equal(pages, (matchingBefore + matchingAfter) / 50, scenario.name);
            measured[scale] = counts;
          } finally {
            await store.drain();
          }
        } finally {
          removeTempRepository(rootDir);
        }
      }
      t.diagnostic(JSON.stringify({ dm03Scenario: scenario.name, measured }));
      if (descending) {
        assert.ok(
          measured.large.sqliteVmSteps <= measured.small.sqliteVmSteps * 5,
          `4x matching events amplified SQLite VM steps: ${JSON.stringify(measured)}`,
        );
        assert.ok(
          measured.large.fileReadBytes <= measured.small.fileReadBytes * 4.4,
          `4x matching events amplified temporary file reads: ${JSON.stringify(measured)}`,
        );
        continue;
      }
      // Gap grew 10x (200 -> 2,000 non-matching rows) with fixed 200 matching rows: row reads and VM steps MUST stay identical!
      assert.equal(
        measured.large.sqlRowsRead,
        measured.small.sqlRowsRead,
        `${scenario.name}: sqlRowsRead grew with gap`,
      );
      assert.ok(
        measured.large.sqliteVmSteps <= measured.small.sqliteVmSteps * 1.25 + 1000,
        `${scenario.name}: expected constant VM steps across 10x gap growth: small=${measured.small.sqliteVmSteps}, large=${measured.large.sqliteVmSteps}`,
      );
      assert.ok(
        measured.large.sqliteScanPages <= measured.small.sqliteScanPages * 1.25 + 16,
        `${scenario.name}: expected constant scan pages across 10x gap growth: small=${measured.small.sqliteScanPages}, large=${measured.large.sqliteScanPages}`,
      );
    }
  },
);
