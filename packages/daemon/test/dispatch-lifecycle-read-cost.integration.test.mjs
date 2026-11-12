// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { evaluateReadMeasurements, measureReadCosts } from "../../../tools/gates/cost-budget-reads.mjs";
import { READ_PROBES } from "./fixtures/g38-read-cost.mjs";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url)),
  probeIds = [
    "cli-schedule-reckon",
    "dispatch-point",
    "runtime-overview-default",
    "task-dispatches-page",
    "projection:runtime-session-groups",
    "repo.reckoning.signals.read",
    "in-flight-work",
  ],
  probes = Object.fromEntries(probeIds.map((id) => [id, READ_PROBES[id]])),
  reads = [...new Set(probeIds.flatMap((id) => probes[id].reads))],
  section = {
    ...JSON.parse(readFileSync(new URL("../../../tools/gates/cost-budget.json", import.meta.url))).readCostScaling,
    readCoverage: {
      measured: Object.fromEntries(
        reads.map((id) => [id, { measurements: probeIds.filter((probe) => probes[probe].reads.includes(id)) }]),
      ),
      notApplicable: [],
    },
  };
section.knownScaling = section.knownScaling.filter((entry) => probeIds.includes(entry.probe));

for (const backend of ["pglite", "sqlite"])
  test(
    `G38 ${backend} lifecycle consumers exclude settled dispatch and session history`,
    {
      skip:
        backend === "pglite" && Number(process.versions.node.split(".")[0]) < 26
          ? "G38 PGlite measurement requires Node 26; the dual-backend CI lane fails closed on older Node"
          : false,
    },
    async (t) => {
      const options = { dimensions: ["runtime-sessions", "dispatches"], backends: [backend] },
        { measured } = await measureReadCosts(rootDir, { ...options, probeIds, section }),
        result = evaluateReadMeasurements({
          section,
          inventory: reads.map((id) => ({ id })),
          probes,
          measured,
          ...options,
        });
      for (const dimension of options.dimensions)
        for (const pair of Object.values(measured[backend][dimension]["task-dispatches-page"])) {
          assert.equal(pair.resultSize, 1, "the selected history task must actually populate the page");
          assert.equal(pair.firstResultSize, 1);
        }
      t.diagnostic(JSON.stringify({ backend, errors: result.errors }));
      assert.equal(result.ok, true, result.errors.join("\n"));
    },
  );
