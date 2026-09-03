// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { deriveUseCaseProjectionInputs, type UseCaseProjectionName } from "../../kernel/src/index.ts";
import { admitUseCaseProjectionSelector, useCaseProjectionFacets } from "../src/protocol/daemon-protocol-gui-types.ts";
import {
  rowDeliveredUseCaseProjections,
  useCaseProjectionFacetWords,
  useCaseProjectionNameWords,
} from "../src/protocol/daemon-protocol-vocabulary.ts";
import { daemonUseCaseProjectionPayloadShape } from "../src/protocol/daemon-protocol-schema-ids.ts";
import { daemonGuiReadMethods } from "../src/protocol/daemon-protocol.contract.ts";
import { validateDaemonUseCaseProjection } from "../src/protocol/daemon-protocol-use-case-projection.ts";

test("the transport name mirror equals the kernel catalog", () => {
  // The daemon transport path may not import the kernel barrel at runtime (check-cli-structure),
  // so the wire enum is a mirror. `useCaseProjectionNameWordsAreServed` and
  // `useCaseProjectionDeliveryIsTotal` pin it at compile time: a selector name the catalog does not
  // carry, or a catalog name with no delivery channel at all, fails to compile. What those cannot
  // see is whether each mirrored name resolves to a real catalog entry, so every name is resolved
  // through the kernel derivation here, and the row-delivered names are checked the same way.
  for (const name of useCaseProjectionNameWords) assert.ok(deriveUseCaseProjectionInputs(name).entityKinds.length > 0);
  for (const name of Object.keys(rowDeliveredUseCaseProjections) as UseCaseProjectionName[])
    assert.ok(deriveUseCaseProjectionInputs(name).entityKinds.length > 0);
  // A row-delivered projection is deliberately not selectable on repo.projection.read: its fields
  // ride on the read named here, and offering a second way to ask for them is CH2's second table.
  assert.deepEqual(rowDeliveredUseCaseProjections, {
    "task-board-rows": "repo.tasks.list",
    "decision-pool-rows": "repo.decisions.list:full",
  });
  for (const name of Object.keys(rowDeliveredUseCaseProjections))
    assert.equal((useCaseProjectionNameWords as readonly string[]).includes(name), false);
  assert.deepEqual(Object.keys(useCaseProjectionFacets), [...useCaseProjectionNameWords]);
  for (const facets of Object.values(useCaseProjectionFacets))
    for (const facet of facets)
      assert.equal(
        (useCaseProjectionFacetWords as readonly string[]).includes(facet),
        true,
        `${facet} must be declared in the transport facet vocabulary`,
      );
});

test("the unified read declares exactly the catalog names in its param shape", () => {
  const nameRule = daemonUseCaseProjectionPayloadShape.fields.name as { readonly values: readonly string[] };
  assert.deepEqual([...nameRule.values], [...useCaseProjectionNameWords]);
  const read = daemonGuiReadMethods.find(({ method }) => method === "repo.projection.read");
  assert.ok(read, "repo.projection.read must be registered");
  assert.equal(read.outputSchemaId, "daemon.use-case-projection/v1");
  // Every catalog entry must be reachable through this one transport row — no second read may
  // carry a projection, which is what keeps CH2's "one combination table" condition true.
  assert.equal(
    daemonGuiReadMethods.filter(({ outputSchemaId }) => outputSchemaId === "daemon.use-case-projection/v1").length,
    1,
  );
});

test("the folded per-store reads are gone and the net read count fell", () => {
  const folded = ["repo.schedules.list", "repo.schedules.runs", "repo.agentRuntime.sessionGroups"];
  for (const method of folded)
    assert.equal(
      daemonGuiReadMethods.some((read) => read.method === method),
      false,
      `${method} must be replaced by a use-case projection`,
    );
  // Baseline at 4221c3148 was 30 named reads plus observeTail; three folded, one unified endpoint.
  assert.equal(daemonGuiReadMethods.length, 29, "31 array entries minus 3 folded plus 1 unified");
});

test("the selector boundary admits and rejects identically for every projection", () => {
  assert.deepEqual(admitUseCaseProjectionSelector({ name: "schedule-plane" }), {
    name: "schedule-plane",
    facet: "plane",
  });
  assert.deepEqual(admitUseCaseProjectionSelector({ name: "schedule-run-history", scheduleId: "s1", limit: 10 }), {
    name: "schedule-run-history",
    facet: "runs",
  });
  assert.deepEqual(admitUseCaseProjectionSelector({ name: "runtime-session-groups", groupBy: "squad" }), {
    name: "runtime-session-groups",
    facet: "groups",
  });
  assert.match(admitUseCaseProjectionSelector({ name: "repo.schedules.list" }) as string, /name is unknown/u);
  assert.match(admitUseCaseProjectionSelector({ name: "schedule-plane", facet: "runs" }) as string, /has no facet/u);
  // A selector that belongs to another projection is refused rather than quietly dropped.
  assert.match(
    admitUseCaseProjectionSelector({ name: "schedule-plane", scheduleId: "s1" }) as string,
    /does not accept scheduleId/u,
  );
  assert.match(
    admitUseCaseProjectionSelector({ name: "runtime-session-groups", scheduleId: "s1" }) as string,
    /does not accept scheduleId/u,
  );
});

test("the envelope is rejected at the envelope, before the inner projection is even looked at", () => {
  // The positive case (a real `readSchedulesGui` result inside a valid envelope) is asserted in
  // schedules-gui.contract.test.ts, which owns the fixture context. What matters here is that each
  // envelope rule short-circuits on its own, so a bad envelope never reaches an inner validator.
  const envelope = {
    schema: "daemon.use-case-projection/v1" as const,
    ok: true as const,
    name: "schedule-plane" as const,
    facet: "plane" as const,
    version: 1,
    inputs: deriveUseCaseProjectionInputs("schedule-plane"),
    projection: neverReached(),
  };
  const only = (value: unknown) => {
    const errors = validateDaemonUseCaseProjection(value);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    return errors[0]!;
  };
  assert.match(only({ ...envelope, schema: "daemon.schedules-list/v1" }), /schema/u);
  assert.match(only({ ...envelope, ok: false }), /ok/u);
  assert.match(only({ ...envelope, name: "repo.schedules.list" }), /name/u);
  assert.match(only({ ...envelope, facet: "groups" }), /facet/u);
  assert.match(only({ ...envelope, version: 0 }), /version/u);
  assert.match(only({ ...envelope, extra: true }), /unexpected fields/u);
  // The load-bearing one: inputs are derived from the kind registry, so an envelope that restates
  // them by hand — even plausibly — is refused rather than believed.
  assert.match(only({ ...envelope, inputs: { entityKinds: ["task"], relationTypes: [] } }), /inputs.entityKinds/u);
  assert.match(
    only({ ...envelope, inputs: { entityKinds: ["schedule"], relationTypes: ["executes"] } }),
    /inputs.relationTypes/u,
  );
});

/** No envelope assertion above is allowed to reach the inner validator; this proves it if one does. */
function neverReached(): never {
  return { thisShapeIsNotAValidSchedulePlane: true } as never;
}
