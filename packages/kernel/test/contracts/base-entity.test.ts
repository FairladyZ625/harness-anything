// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUniqueBaseEntityIdentities,
  baseEntityActionIds,
  projectBaseEntityAtCut,
  rebuildBaseEntityProjection,
  validateBaseEntity,
  type EntityTypeContract,
} from "../../src/domain/base-entity.ts";
import { entityKindContracts, isRelationEndpointKind, type EntityKind } from "../../src/domain/entity-kind-registry.ts";
import { formatEntityRef, parseEntityRef } from "../../src/domain/entity-ref.ts";

const actor = { principal: { personId: "person-base-entity" }, executor: null };
const identityByKind: Readonly<Record<EntityKind, string>> = {
  task: "task_01K7ZBASEENTITY",
  fact: "F-BASEENTITY",
  decision: "dec_BASEENTITY",
  agent: "agent-base",
  squad: "squad-base",
  policy: "policy-base",
  execution: "exe_BASEENTITY",
  review: "rev_BASEENTITY",
  "runtime-session": "runtime_baseentity",
  schedule: "schedule-base",
  settings: "repository",
  person: "person_baseentity",
};

test("all twelve registered kinds are referenceable relation endpoints from one type contract", () => {
  const registeredKinds = entityKindContracts.map(({ kind }) => kind).sort();
  const referenceableKinds: EntityKind[] = [];
  const endpointKinds: EntityKind[] = [];

  for (const contract of entityKindContracts) {
    const id = identityByKind[contract.kind];
    const ref = formatEntityRef(contract.kind, id);
    const parsed = parseEntityRef(ref);
    assert.equal(parsed?.kind, contract.kind, contract.kind);
    assert.equal(parsed?.id, id, contract.kind);
    referenceableKinds.push(parsed!.kind);
    assert.deepEqual(contract.baseActions, baseEntityActionIds, contract.kind);
    assert.equal(contract.relationEndpoint.eligible, true, contract.kind);
    if (isRelationEndpointKind(contract.kind)) endpointKinds.push(contract.kind);
  }

  assert.equal(registeredKinds.length, 12);
  assert.deepEqual(referenceableKinds.sort(), registeredKinds);
  assert.deepEqual(endpointKinds.sort(), registeredKinds);
  assert.equal(parseEntityRef("relation/rel_b75516c583945a52"), null);
  assert.equal(parseEntityRef("unknown/id"), null);
  assert.equal(parseEntityRef("agent/bad/id"), null);
  assert.throws(() => formatEntityRef("unknown", "id"), /no ref authority/u);
  assert.throws(() => formatEntityRef("agent", "bad/id"), /not a valid agent/u);
});

test("BaseEntity hot projection and cold rebuild produce the same canonical event cut", () => {
  for (const rawContract of entityKindContracts) {
    const contract: EntityTypeContract = rawContract;
    const firstCut = cut(rawContract.kind, identityByKind[rawContract.kind], 10, "2026-08-30T01:00:00.000Z");
    const secondCut = {
      ...firstCut,
      workspaceRevision: 12,
      occurredAt: "2026-08-30T02:00:00.000Z",
      pinned: true,
    };
    const first = projectBaseEntityAtCut(contract, firstCut);
    const hot = projectBaseEntityAtCut(contract, secondCut, first);
    const cold = rebuildBaseEntityProjection(contract, [firstCut, secondCut]);
    assert.deepEqual(hot, cold, rawContract.kind);
    assert.equal(hot.createdAt, firstCut.occurredAt, rawContract.kind);
    assert.equal(hot.updatedAt, secondCut.occurredAt, rawContract.kind);
    assert.equal(hot.revision, 12, rawContract.kind);
    assert.equal(hot.provenance.at, hot.updatedAt, rawContract.kind);
  }
});

test("BaseEntity projection rejects missing fields, duplicate identity, invalid time, and reversed revision", () => {
  const contract: EntityTypeContract = entityKindContracts.find(({ kind }) => kind === "agent")!;
  const firstCut = cut("agent", identityByKind.agent, 10, "2026-08-30T01:00:00.000Z");
  const first = projectBaseEntityAtCut(contract, firstCut);
  const { pinned: _pinned, ...missingPinned } = firstCut;
  assert.throws(() => projectBaseEntityAtCut(contract, missingPinned), /fields are incomplete/u);
  assert.throws(
    () => projectBaseEntityAtCut(contract, { ...firstCut, workspaceRevision: 9 }, first),
    /revision must increase monotonically/u,
  );
  assert.throws(
    () =>
      projectBaseEntityAtCut(
        contract,
        { ...firstCut, workspaceRevision: 11, occurredAt: "2026-08-30T00:00:00.000Z" },
        first,
      ),
    /updatedAt cannot precede/u,
  );
  assert.throws(() => assertUniqueBaseEntityIdentities([first, first]), /duplicate BaseEntity identity/u);
  assert.match(
    validateBaseEntity(contract, {
      ...first,
      createdAt: "2026-08-30T02:00:00.000Z",
      updatedAt: "2026-08-30T01:00:00.000Z",
    }).join("; "),
    /createdAt cannot follow updatedAt/u,
  );
  const { disposition: _disposition, ...missingDisposition } = first;
  assert.deepEqual(validateBaseEntity(contract, missingDisposition), ["BaseEntity projection fields are incomplete"]);
});

test("Agent and Policy expose no state vocabulary that is absent from their schemas", () => {
  for (const kind of ["agent", "policy"] as const) {
    const contract = entityKindContracts.find((candidate) => candidate.kind === kind)!;
    assert.equal(contract.statusVocabulary, undefined, kind);
    assert.equal(Object.hasOwn(contract.schema.properties, "state"), false, kind);
  }
});

function cut(kind: EntityKind, id: string, workspaceRevision: number, occurredAt: string) {
  return {
    kind,
    id,
    workspaceRevision,
    occurredAt,
    actor,
    source: "local" as const,
    pinned: false,
    disposition: "active" as const,
  };
}
