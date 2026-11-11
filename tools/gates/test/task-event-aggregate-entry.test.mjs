// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  aggregateEventFamiliesFromSnapshot,
  checkAggregateEventConstructionSites,
  loadAggregateEventFamilies,
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
      baseline: { [`${fixture.family.schema}|${fixtureCase.path}|literal-type|${fixtureCase.eventType}`]: 1 },
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

// A schema carried by a base spread must not hide the newly selected event type.
for (const fixtureCase of fixture.spreadCases) {
  test(`${fixtureCase.eventType ?? fixtureCase.parameterTypes.join("/")} spread construction outside its aggregate is refused`, () => {
    const families = loadAggregateEventFamilies(path.resolve(import.meta.dirname, "../../.."));
    const sources = fixtureCase.parameterTypes
      ? ["type", "type: type"].map(
          (property) =>
            `function build(type: ${fixtureCase.parameterTypes.map((type) => JSON.stringify(type)).join(" | ")}) { ` +
            `return { ...base, ${property}, payload: {} }; }\n`,
        )
      : [`export const event = { ...base, type: "${fixtureCase.eventType}", payload: {} };\n`];
    for (const source of sources) {
      const { rootDir } = makeRepo({ "packages/rogue/src/rogue.ts": source });
      const sites = scanAggregateEventConstructionSites(rootDir, families);
      assert.equal(sites.length, 1, "the canonical event vocabulary must expose a bare spread discriminator");
      assert.equal(sites[0].schema, fixtureCase.schema);
      assert.match(
        checkAggregateEventConstructionSites(sites, { families }).join("\n"),
        new RegExp(`outside the declared writers of ${fixtureCase.owner}`),
      );
      const family = families.find(({ schema }) => schema === fixtureCase.schema);
      const owner = makeRepo({ [family.writers[0]]: source });
      assert.deepEqual(
        checkAggregateEventConstructionSites(scanAggregateEventConstructionSites(owner.rootDir, families), {
          families,
        }),
        [],
      );
    }
  });
}
