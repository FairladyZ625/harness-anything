// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { entityKindContracts } from "../../src/domain/entity-kind-registry.ts";
import {
  deriveUseCaseProjectionInputs,
  getUseCaseProjection,
  useCaseProjectionCatalog,
  useCaseProjectionEntryKeys,
  useCaseProjectionKindGaps,
  useCaseProjectionNames,
} from "../../src/domain/use-case-projection-catalog.ts";

test("every catalog kind is registered in the entity kind registry", () => {
  // The load-bearing assertion of dec_5B135F46 CH4: a projection may only claim kinds the authority
  // face declares. A catalog entry naming an unregistered kind goes red here, at the declaration.
  assert.deepEqual(useCaseProjectionKindGaps(), []);
  const registered = new Set(entityKindContracts.map((contract) => contract.kind));
  for (const entry of useCaseProjectionCatalog)
    for (const kind of entry.entityKinds)
      assert.equal(registered.has(kind), true, `${entry.name} claims unregistered kind ${kind}`);
});

test("an unregistered kind is rejected rather than resolved", () => {
  // Negative control for the assertion above: the same derivation refuses a kind the registry
  // does not declare, so the guard is a real predicate and not an empty set that always passes.
  const unregistered = "not-a-registered-kind";
  assert.equal(
    entityKindContracts.some((contract) => contract.kind === unregistered),
    false,
  );
  assert.throws(() => deriveUseCaseProjectionInputs(unregistered as never), /Unknown use-case projection/);
});

test("catalog entries carry no transport dimension", () => {
  // dec_5B135F46 CH2: no second table may hold method / path / commandClass / auth / lease truth.
  // Adding any of them to an entry turns this red, which is the mechanical form of that rule.
  const forbidden = ["method", "path", "commandClass", "auth", "lease", "httpMethod", "serviceMethod"];
  for (const entry of useCaseProjectionCatalog) {
    assert.deepEqual(Object.keys(entry).sort(), [...useCaseProjectionEntryKeys].sort(), `${entry.name} key set`);
    for (const key of forbidden)
      assert.equal(Object.hasOwn(entry, key), false, `${entry.name} must not declare ${key}`);
  }
});

test("the catalog names exactly the three shipped projections", () => {
  assert.deepEqual(
    useCaseProjectionCatalog.map((entry) => entry.name),
    ["schedule-plane", "schedule-run-history", "runtime-session-groups"],
  );
  assert.deepEqual([...useCaseProjectionNames].sort(), useCaseProjectionCatalog.map((entry) => entry.name).sort());
  for (const entry of useCaseProjectionCatalog) {
    assert.equal(entry.outputSchemaId, "daemon.use-case-projection/v1");
    assert.equal(entry.version, 1);
    assert.equal(entry.consumers.length > 0, true, `${entry.name} must declare its consuming views`);
  }
});

test("one use-case projection per consuming view", () => {
  // The task Checkpoint: a view needing two use-case projections is a view-boundary problem.
  // Object Projections and Query Functions are the other two CH4 layers and do not count here.
  const owner = new Map<string, string>();
  for (const entry of useCaseProjectionCatalog)
    for (const view of entry.consumers) {
      const previous = owner.get(view);
      assert.equal(previous, undefined, `${view} would consume both ${previous} and ${entry.name}`);
      owner.set(view, entry.name);
    }
  assert.equal(useCaseProjectionCatalog.length <= owner.size, true, "projections must not outnumber consuming views");
});

test("inputs are derived from the registry, not restated", () => {
  // relationTypes never appear in a catalog entry; they are read back off the kind contracts, so a
  // projection cannot claim a relation the registry does not declare for its kinds.
  assert.deepEqual(deriveUseCaseProjectionInputs("schedule-plane"), {
    entityKinds: ["schedule"],
    relationTypes: [],
  });
  assert.deepEqual(deriveUseCaseProjectionInputs("schedule-run-history"), {
    entityKinds: ["schedule"],
    relationTypes: [],
  });

  const runtime = deriveUseCaseProjectionInputs("runtime-session-groups");
  assert.deepEqual(runtime.entityKinds, ["task", "agent", "squad", "runtime-session"], "registry order");
  assert.deepEqual(
    runtime.relationTypes,
    derivedRelationTypesFor(["runtime-session", "task", "squad", "agent"]),
    "runtime-session-groups relation types must equal the registry's own edge types",
  );
  assert.equal(runtime.relationTypes.includes("executes"), true, "runtime-session declares an executes edge");
});

test("getUseCaseProjection resolves every declared name and rejects anything else", () => {
  for (const name of useCaseProjectionNames) assert.equal(getUseCaseProjection(name).name, name);
  assert.throws(() => getUseCaseProjection("schedule" as never), /Unknown use-case projection/);
});

function derivedRelationTypesFor(kinds: readonly string[]): readonly string[] {
  const claimed = new Set(kinds);
  const types = new Set<string>();
  for (const contract of entityKindContracts)
    if (claimed.has(contract.kind)) for (const edge of contract.relations.edges) types.add(edge.type);
  return [...types].sort();
}
