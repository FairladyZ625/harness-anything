// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  aggregateEventFamiliesFromSnapshot,
  checkAggregateEventConstructionSites,
  scanAggregateEventConstructionSites,
} from "../../check-task-event-aggregate-entry.mjs";
import { makeRepo } from "./helpers.mjs";

// The schema→owner judgment added by dec_499E4E98A3D4754132B3BCA1E6 CH1: a
// construction site resolves through canonicalEventSchemas.owner and that kind's
// declared state-store writers. The fixture holds the positive (non-owner refused)
// and negative (declared writer accepted) cases.
const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "fixtures/aggregate-event-construction-owner.json"), "utf8"),
);

const families = aggregateEventFamiliesFromSnapshot(
  {
    stateStores: [
      {
        kind: fixture.family.owner,
        stateStores: [
          {
            id: fixture.family.storeId,
            role: "authority",
            medium: {
              kind: "canonical-event",
              schema: fixture.family.schema,
              types: ["*"],
              writers: fixture.family.writers,
            },
          },
        ],
      },
    ],
    canonicalEvents: [{ schema: fixture.family.schema, owner: fixture.family.owner }],
  },
  [],
);

for (const fixtureCase of fixture.cases) {
  test(fixtureCase.name, () => {
    const source =
      `export const event = { schema: "${fixture.family.schema}", ` +
      `type: "${fixtureCase.eventType}", payload: {} };\n`;
    const { rootDir } = makeRepo({ [fixtureCase.path]: source });
    const findings = checkAggregateEventConstructionSites(scanAggregateEventConstructionSites(rootDir, families), {
      families,
      baseline: {},
    });
    if (fixtureCase.finding === null) {
      assert.deepEqual(findings, []);
      return;
    }
    assert.ok(
      findings.some((finding) => finding.includes(fixtureCase.path) && finding.includes(fixtureCase.finding)),
      findings.join("\n"),
    );
  });
}
