// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { decodeVerticalDefinition } from "@harness-anything/kernel";
import { runVerticalDeclarationAction } from "../src/vertical-declaration-action.ts";

/**
 * A kind may be governed by any accepted decision, not just a kernel built-in. The accept path
 * compiles once with the decision authority resolved from the declaration; a second compile that
 * drops that authority would fail after the event was appended and the projection applied (F4).
 */
test("accepting a kind governed by a non-builtin decision keeps its authority", async () => {
  const base = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, "../../kernel/fixtures/schemas/vertical-definition/valid.json"),
        "utf8",
      ),
    ) as { entityKinds: Record<string, unknown>[]; projectionSchemas: Record<string, unknown>[] },
    pin = `sha256:${"b".repeat(64)}`,
    kind = {
      kindId: "KND-11111111111111111111111111111111",
      id: "architecture-decision-record",
      entityType: "artifact",
      schemaVersions: [{ version: 1, attributes: {} }],
      revision: 1,
      idPrefix: "ADR",
      display: { singular: "ADR", plural: "ADRs" },
      descriptorSchemaRef: "schema://artifact-descriptor",
      store: { pathTemplate: "entities/adrs/{id}.json" },
      locatorKinds: ["repository-path"],
      relations: [
        {
          type: "relates",
          sourceKind: "architecture-decision-record",
          targetKind: "decision",
          reads: "ADR relates to decision",
          strength: "weak",
          decisionClaimRef: "decision/dec_OTHER/CH1",
          decisionContentPin: pin,
        },
      ],
    },
    definition = decodeVerticalDefinition({
      ...base,
      id: "custom/engineering",
      version: "1.0.0",
      entityKinds: [...base.entityKinds, kind],
      projectionSchemas: [
        ...base.projectionSchemas,
        { id: "artifact-descriptor", schemaRef: "schema://artifact-descriptor" },
      ],
    }),
    events: string[] = [];
  let applied = false,
    settled = false;
  const receipt = await runVerticalDeclarationAction({
    action: {
      kind: "vertical-kind-upsert",
      kindId: "architecture-decision-record",
      declaration: { ...kind, display: { singular: "Updated ADR", plural: "ADRs" } },
      expectedVersion: 1,
    },
    binding: { actor: { principal: { personId: "person-accept" }, executor: null }, source: "local" },
    store: {
      readHead: () => ({ revision: 1 }),
      append: (bundle) => {
        events.push(bundle.event.type);
        return { revision: 2 } as never;
      },
      settlePendingMaterialization: async () => {
        settled = true;
      },
    },
    projection: {
      readDocument: () => ({
        document: {
          body: JSON.stringify({
            schema: "repository-vertical-declaration/v1",
            revision: 1,
            definition,
          }),
        },
      }),
      readDecisionDocumentState: () => ({
        decisionId: "dec_OTHER",
        state: "in_effect",
        chosen: [{ id: "CH1", text: "chosen" }],
        contentPins: [{ digest: pin, state: "in_effect", pinnedAt: "2026-10-29T00:00:00.000Z" }],
      }),
      apply: () => {
        applied = true;
      },
    } as never,
    now: () => "2026-11-01T06:00:00.000Z",
    mintKindId: () => "KND-22222222222222222222222222222222",
  });
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  assert.deepEqual(events, ["vertical_kind_upserted"]);
  assert.equal(applied, true);
  assert.equal(settled, true);
});
