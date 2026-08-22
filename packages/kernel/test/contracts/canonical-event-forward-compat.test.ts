// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import { canonicalEventSchemas, parseCanonicalEvent, validateCurrentCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { sameActorIdentity, sameWriteSource, serializeEventEnvelope } from "../../src/domain/write-chain.contract.ts";

const actor = { principal: { personId: "person-fixture" }, executor: { kind: "agent" as const, id: "codex" } };
const taskCreated = {
  schema: "task-event/v1" as const,
  eventId: "event-forward-compat",
  workspaceRevision: 1,
  opId: "op-forward-compat",
  taskId: "task-forward-compat",
  type: "task_created" as const,
  actor,
  source: "local" as const,
  occurredAt: "2026-08-21T00:00:00.000Z",
  payload: {
    task: {
      schema: "task/v1" as const,
      taskId: "task-forward-compat",
      title: "Forward compatible task",
      taskClass: "standard" as const,
      status: "planned" as const,
      graph: REPLAY_TASK_GRAPH,
      currentNode: "implementation" as const,
      iteration: 0 as const,
      createdBy: actor,
      completionGateIds: ["ci"],
      presetSnapshotDigest: null
    }
  }
};

test("Task/v1 readers ignore a field that current writers do not know", () => {
  const future = {
    ...taskCreated,
    payload: { task: { ...taskCreated.payload.task, futureOptionalField: true } }
  };
  const bytes = serializeEventEnvelope(future);

  assert.deepEqual(parseCanonicalEvent(bytes), future);
  assert.match(validateCurrentCanonicalEvent(future).join("\n"), /unknown/u);
});

test("semantic actor and source equality ignores additions but not known-axis changes", () => {
  assert.equal(sameActorIdentity({ ...actor, futureOptionalField: true }, actor), true);
  assert.equal(sameActorIdentity({ ...actor, principal: { personId: "someone-else" } }, actor), false);
  // watch_session remains readable only as immutable historical event identity;
  // current command normalization rejects it after automatic ingestion retired.
  const source = { kind: "watch_session" as const, sessionId: "session-1", path: "context/input.md", fingerprint: "a".repeat(64) };
  assert.equal(sameWriteSource({ ...source, futureOptionalField: true }, source), true);
  assert.equal(sameWriteSource({ ...source, path: "context/other.md" }, source), false);
});

test("every canonical reader ignores an unknown field at every frozen object boundary", () => {
  const fixtureRoot = path.resolve(import.meta.dirname, "../../fixtures/canonical-events");
  let probes = 0;
  for (const entry of canonicalEventSchemas) {
    const directory = path.join(fixtureRoot, entry.schema.replaceAll("/", "-"));
    for (const name of readdirSync(directory).filter((candidate) => candidate.endsWith(".json"))) {
      const original: unknown = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
      for (const objectPath of objectPaths(original)) {
        const candidate = structuredClone(original);
        objectAt(candidate, objectPath).__fixtureFutureField = true;
        assert.deepEqual(entry.validate(candidate), [], `${entry.schema}:${name}:$.${objectPath.join(".")}`);
        probes += 1;
      }
    }
  }
  assert.ok(probes > canonicalEventSchemas.length, "the probe must reach nested object fields");
});

type ObjectPath = readonly (string | number)[];

function objectPaths(value: unknown, current: ObjectPath = [], found: ObjectPath[] = []): ObjectPath[] {
  if (Array.isArray(value)) value.forEach((child, index) => objectPaths(child, [...current, index], found));
  else if (value !== null && typeof value === "object") {
    found.push(current);
    for (const [key, child] of Object.entries(value)) objectPaths(child, [...current, key], found);
  }
  return found;
}

function objectAt(value: unknown, objectPath: ObjectPath): Record<string, unknown> {
  let current = value;
  for (const segment of objectPath) {
    if (Array.isArray(current) && typeof segment === "number") current = current[segment];
    else if (current !== null && typeof current === "object" && typeof segment === "string") current = (current as Record<string, unknown>)[segment];
    else throw new Error(`fixture path does not resolve to an object: ${objectPath.join(".")}`);
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) throw new Error(`fixture path is not an object: ${objectPath.join(".")}`);
  return current as Record<string, unknown>;
}
