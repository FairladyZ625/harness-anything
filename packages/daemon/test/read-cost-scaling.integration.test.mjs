// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { main } from "../../../tools/gates/cost-budget.mjs";
import { READ_MARGINS } from "../../../tools/gates/cost-budget-reads.mjs";
import { measureReadScale } from "./fixtures/g38-read-cost.mjs";

if (process.env.FLEET_STRESS_G38_LEGACY_BENCH === "1") {
  test("G38 existing lane runs unchanged before read-scale integration", async (t) => {
    const started = performance.now();
    assert.equal(await main([]), 0);
    t.diagnostic(JSON.stringify({ legacyGateDurationMs: performance.now() - started, node: process.versions.node }));
  });
} else {
  const full = process.env.FLEET_STRESS_G38_READ_SCALES === "1";
  for (const backend of process.env.FLEET_STRESS_G38_BACKEND
    ? [process.env.FLEET_STRESS_G38_BACKEND]
    : ["sqlite", "pglite"])
    test(
      `G38 ${backend} read fixtures execute actual readers with fixed selected results`,
      {
        skip:
          backend === "pglite" && Number(process.versions.node.split(".")[0]) < 26
            ? "PGlite requires Node 26 (native WASM runtime boundary); G38's dual-backend lane must run Node 26"
            : false,
      },
      async (t) => {
        assert.ok(["sqlite", "pglite"].includes(backend));
        const started = performance.now();
        const failures = [];
        for (const dimension of ["runtime-sessions", "dispatches", "task-outputs", "relations", "event-bytes"]) {
          let previous;
          for (const size of full ? [200, 2000] : [2]) {
            let result;
            try {
              result = await measureReadScale(backend, dimension, size);
            } catch (error) {
              if (!full || !error.measurements) throw error;
              failures.push(error.message);
              result = error.measurements;
              t.diagnostic(JSON.stringify({ backend, dimension, size, errors: error.message }));
            }
            for (const [id, measurement] of Object.entries(result)) {
              assert.ok(Number.isSafeInteger(measurement.resultSize), `${id} result size`);
              assert.equal(measurement.firstResultSize, measurement.resultSize, `${id} warm-up result changed`);
              if (previous)
                assert.equal(
                  measurement.resultSize,
                  previous[id].resultSize,
                  `${backend}/${dimension}/${id} history changed selected result size k`,
                );
            }
            t.diagnostic(
              JSON.stringify(
                full
                  ? { backend, dimension, size, result }
                  : { backend, dimension, probeCount: Object.keys(result).length },
              ),
            );
            previous = result;
          }
        }
        if (full) {
          const small = (
              await measureReadScale(backend, "task-outputs", 200, {
                probeIds: ["document-point"],
                wholeClassControl: true,
              })
            )["document-point"],
            large = (
              await measureReadScale(backend, "task-outputs", 2000, {
                probeIds: ["document-point"],
                wholeClassControl: true,
              })
            )["document-point"];
          assert.equal(small.resultSize, large.resultSize);
          assert.ok(large.counts.sqlRowsRead > small.counts.sqlRowsRead + READ_MARGINS.sqlRowsRead);
          t.diagnostic(
            JSON.stringify({ positiveControl: "whole-class document read", backend, small, large, red: true }),
          );
        }
        t.diagnostic(JSON.stringify({ backend, durationMs: performance.now() - started, node: process.versions.node }));
        assert.deepEqual(
          failures,
          [],
          "All registered probes must execute successfully; partial profiling output is not a pass",
        );
      },
    );
}
