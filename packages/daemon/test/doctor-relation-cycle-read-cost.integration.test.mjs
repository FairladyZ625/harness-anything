// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReadMeasurements, measureReadCosts } from "../../../tools/gates/cost-budget-reads.mjs";
import { READ_PROBES } from "./fixtures/g38-read-cost.mjs";

if (process.env.FLEET_STRESS_G38_READ_SCALES === "1")
  test("doctor's completed cycle audit stays flat at the original 200 and 2000 scales", async () => {
    assert.ok(
      Number(process.versions.node.split(".")[0]) >= 26,
      "G38 PGlite requires Node 26; no database measurement ran",
    );
    const id = "cli-doctor-health",
      probe = READ_PROBES[id],
      dimensions = ["relations", "runtime-sessions", "dispatches"],
      section = {
        schema: "read-cost-scaling-budget/v1",
        knownScaling: [],
        readCoverage: {
          measured: Object.fromEntries(probe.reads.map((read) => [read, { measurements: [id] }])),
          notApplicable: [],
        },
      },
      { measured } = await measureReadCosts(process.cwd(), { probeIds: [id], backends: ["pglite"], dimensions }),
      result = evaluateReadMeasurements({
        section,
        inventory: probe.reads.map((read) => ({ id: read })),
        probes: { [id]: probe },
        measured,
        backends: ["pglite"],
        dimensions,
      });
    assert.deepEqual(result.errors, []);
  });
else
  test(
    "original-scale doctor measurement is opt-in",
    { skip: "requires FLEET_STRESS_G38_READ_SCALES=1 (Node 26 PGlite lane)" },
    () => {},
  );
