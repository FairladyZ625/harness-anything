// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../../../tools/gates/cost-budget.mjs";
import {
  READ_MARGINS,
  READ_DIMENSIONS,
  READ_SCALES,
  evaluateReadMeasurements,
} from "../../../tools/gates/cost-budget-reads.mjs";
import { READ_PROBES, measureReadScale } from "./fixtures/g38-read-cost.mjs";

if (process.env.FLEET_STRESS_G38_LEGACY_BENCH === "1") {
  test("G38 existing lane runs unchanged before read-scale integration", async () => {
    assert.equal(await main(["--phase", "legacy"]), 0);
  });
} else if (process.env.FLEET_STRESS_G38_CONTROL_ONLY !== "1") {
  const full = process.env.FLEET_STRESS_G38_READ_SCALES === "1";
  const dimensions = process.env.FLEET_STRESS_G38_DIMENSION
    ? process.env.FLEET_STRESS_G38_DIMENSION.split(",")
    : READ_DIMENSIONS;
  for (const backend of process.env.FLEET_STRESS_G38_BACKEND
    ? [process.env.FLEET_STRESS_G38_BACKEND]
    : ["sqlite", "pglite"])
    test(
      `G38 ${backend} executes all production read probes`,
      {
        skip:
          !full && backend === "pglite" && Number(process.versions.node.split(".")[0]) < 26
            ? "G38 PGlite measurement is pinned to Node 26; the dual-backend CI lane fails closed on older Node"
            : false,
      },
      async (t) => {
        assert.ok(["sqlite", "pglite"].includes(backend));
        const started = performance.now();
        if (full) {
          assert.equal(
            await main([
              "--phase",
              "read",
              "--backend",
              backend,
              ...(process.env.FLEET_STRESS_G38_DIMENSION ? ["--dimension", dimensions.join(",")] : []),
            ]),
            0,
          );
        } else {
          for (const dimension of dimensions) {
            const probeIds = Object.keys(READ_PROBES).filter((id) =>
              READ_PROBES[id].sourceAudit ? dimension === "source-events" : dimension !== "source-events",
            );
            const result = await measureReadScale(backend, dimension, 2, { probeIds });
            for (const [id, value] of Object.entries(result)) {
              assert.ok(Number.isSafeInteger(value.resultSize), `${id} result size`);
              assert.equal(value.firstResultSize, value.resultSize, `${id} warm-up result changed`);
            }
            t.diagnostic(JSON.stringify({ backend, dimension, probeCount: Object.keys(result).length }));
          }
        }
        t.diagnostic(JSON.stringify({ backend, durationMs: performance.now() - started, node: process.versions.node }));
      },
    );
}

if (process.env.FLEET_STRESS_G38_POSITIVE_CONTROL === "1") {
  for (const backend of ["sqlite", "pglite"])
    test(`G38 ${backend} real whole-class SQL is red at fixed k`, async (t) => {
      const pair = {};
      for (const [scale, size] of Object.entries(READ_SCALES))
        pair[scale] = (
          await measureReadScale(backend, "runtime-sessions", size, {
            probeIds: ["document-point"],
            wholeClassControl: true,
          })
        )["document-point"];
      const id = "method:repo.tasks.document.read",
        section = {
          schema: "read-cost-scaling-budget/v1",
          knownScaling: [],
          readCoverage: { measured: { [id]: { measurements: ["document-point"] } }, notApplicable: [] },
        };
      const result = evaluateReadMeasurements({
        section,
        inventory: [{ id }],
        probes: { "document-point": READ_PROBES["document-point"] },
        backends: [backend],
        dimensions: ["runtime-sessions"],
        measured: { [backend]: { "runtime-sessions": { "document-point": pair } } },
      });
      assert.equal(pair.small.resultSize, pair.large.resultSize);
      assert.ok(pair.large.counts.sqlRowsRead > pair.small.counts.sqlRowsRead + READ_MARGINS.sqlRowsRead);
      assert.equal(result.ok, false);
      t.diagnostic(
        JSON.stringify({ positiveControl: "whole-class runtime-session SQL", backend, pair, errors: result.errors }),
      );
    });
}
