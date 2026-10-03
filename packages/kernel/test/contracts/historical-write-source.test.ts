// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  canonicalEventSchemas,
  parseCanonicalEvent,
  serializeCanonicalEventUnchecked,
  validateCurrentCanonicalEvent,
} from "../../src/domain/doc-sync-canonical-events.ts";
import {
  normalizeCommandEnvelope,
  sameWriteSource,
  serializeEventEnvelope,
  validateWriteSource,
} from "../../src/domain/write-chain.contract.ts";

const source = { kind: "assignment", assignmentId: "assignment-one", nodeId: "node-one" };

// Only replace write identities, retaining unrelated payload fields named source.
function historicalSources(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(historicalSources);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "source" && validateWriteSource(child, true).length === 0 ? source : historicalSources(child),
    ]),
  );
}

test("immutable canonical event families retain historical assignment identities and reject current writes", () => {
  const root = path.resolve(import.meta.dirname, "../../fixtures/canonical-events");
  let probes = 0;
  for (const entry of canonicalEventSchemas) {
    const directory = path.join(root, entry.schema.replaceAll("/", "-"));
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
      const original = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
      // Import events have a fixed migration provenance, independent of node identities.
      if (original.source === "migration-import/v1") continue;
      const historical = historicalSources(original) as typeof original;
      const body = serializeCanonicalEventUnchecked(historical);
      assert.deepEqual(parseCanonicalEvent(body), historical, `${entry.schema}:${name}`);
      assert.ok(validateCurrentCanonicalEvent(historical).length > 0, `${entry.schema}:${name}: current write`);
      assert.throws(() => serializeEventEnvelope(historical), /identity is invalid/u);
      probes += 1;
    }
  }
  assert.ok(probes > canonicalEventSchemas.length);
});

test("historical source requires both identity axes without making assignment a live source", () => {
  assert.deepEqual(validateWriteSource(source, true), []);
  assert.ok(validateWriteSource(source).length > 0);
  for (const invalid of [
    { kind: "assignment", nodeId: "node-one" },
    { kind: "assignment", assignmentId: "assignment-one" },
    { ...source, assignmentId: "" },
    { ...source, nodeId: 7 },
    { ...source, kind: "other" },
  ]) {
    assert.ok(validateWriteSource(invalid, true).length > 0);
    assert.equal(sameWriteSource(invalid, invalid), false);
  }
  assert.equal(sameWriteSource(source, { ...source, futureField: true }), true);
  assert.equal(sameWriteSource(source, { ...source, assignmentId: "assignment-two" }), false);
  assert.equal(sameWriteSource(source, { ...source, nodeId: "node-two" }), false);
  assert.equal(sameWriteSource(source, { kind: "node", nodeId: source.nodeId }), false);
  assert.equal(sameWriteSource({ kind: "node", nodeId: source.nodeId }, source), false);
  assert.throws(
    () =>
      normalizeCommandEnvelope({
        workspaceId: "workspace-one",
        actor: { principal: { personId: "person-one" }, executor: null },
        source: source as never,
        expectedRevision: 1,
        command: { type: "ClaimTask" },
      }),
    /source/u,
  );
});

test("historical completion receipts remain bound to both assignment identity axes", () => {
  const original = JSON.parse(
    readFileSync(
      new URL(
        "../../fixtures/canonical-events/task-event-v1/accepted-completion-gate-verified-0187036fd590.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const event = historicalSources(original) as typeof original;
  assert.deepEqual(parseCanonicalEvent(serializeCanonicalEventUnchecked(event)), event);
  for (const different of [
    { ...source, assignmentId: "assignment-two" },
    { ...source, nodeId: "node-two" },
    { kind: "node", nodeId: source.nodeId },
  ]) {
    const mismatch = {
      ...event,
      payload: { ...event.payload, witness: { ...event.payload.witness, source: different } },
    };
    assert.throws(
      () => parseCanonicalEvent(serializeCanonicalEventUnchecked(mismatch)),
      /pinned to its canonical event receipt/u,
    );
  }
  for (const invalid of [
    { kind: "assignment", nodeId: "node-one" },
    { ...source, nodeId: null },
  ]) {
    assert.throws(
      () => parseCanonicalEvent(serializeCanonicalEventUnchecked({ ...event, source: invalid })),
      /source is invalid/u,
    );
  }
});
