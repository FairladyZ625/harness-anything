// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { measureReadCosts, evaluateReadMeasurements } from "../../../tools/gates/cost-budget-reads.mjs";
import { READ_PROBES } from "./fixtures/g38-read-cost.mjs";
import { pgliteIntegrationSuite } from "../../storage/test/pglite/pglite-runtime.fixture.ts";

pgliteIntegrationSuite("PG task point read costs", () => {
  test("PG task point reads stay flat at 200 and 2000 historical tasks", async () => {
    const probeIds = [
        "document-point",
        "document-prefix",
        "output-point-same-task",
        "cli-task-show",
        "cli-task-read-set",
        "cli-task-review",
      ],
      probes = Object.fromEntries(probeIds.map((id) => [id, READ_PROBES[id]])),
      reads = [...new Set(probeIds.flatMap((id) => probes[id].reads))],
      section = {
        schema: "read-cost-scaling-budget/v1",
        knownScaling: [],
        readCoverage: {
          measured: Object.fromEntries(
            reads.map((id) => [id, { measurements: probeIds.filter((probe) => probes[probe].reads.includes(id)) }]),
          ),
          notApplicable: [],
        },
      },
      { measured } = await measureReadCosts(process.cwd(), {
        probeIds,
        backends: ["pglite"],
        dimensions: ["task-history"],
      }),
      result = evaluateReadMeasurements({
        section,
        inventory: reads.map((id) => ({ id })),
        probes,
        measured,
        backends: ["pglite"],
        dimensions: ["task-history"],
      });
    assert.deepEqual(result.errors, []);
  });
});
