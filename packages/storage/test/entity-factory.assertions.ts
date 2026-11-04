import assert from "node:assert/strict";
import type { CanonicalEventStore, CanonicalEventV1 } from "@harness-anything/kernel";
import {
  compileEntityUpsert,
  compileEntityDeleted,
  compileAgentRetired,
} from "@harness-anything/kernel/internal/domain/entity-event-compile.ts";
import { createEntityStore, type OpenedEntityStore } from "../src/store/entity-store.ts";

export function assertEntityFactory(input: {
  readonly store: CanonicalEventStore;
  readonly open: () => OpenedEntityStore;
  readonly withReadSession?: (read: () => void) => void;
}) {
  const { store } = input,
    base = store.readHead()?.revision ?? 0,
    events: CanonicalEventV1[] = [],
    reader = input.open(),
    indexed = createEntityStore({
      readBatch: () => {
        throw new Error("Physical entity read replayed history");
      },
      readContentBlob: store.readContentBlob,
      readEntityDeclarations: store.readEntityDeclarations,
    });
  const envelope = (n: number) => ({
    eventId: `entity-factory-${n}`,
    opId: `entity-factory-${n}`,
    workspaceRevision: base + n,
    actor: { principal: { personId: "entity-factory" }, executor: null },
    source: "local" as const,
    occurredAt: "2026-11-04T00:00:00.000Z",
  });
  const upsert = (n: number) =>
    compileEntityUpsert({
      ...envelope(n),
      entityKind: "agent",
      entity: {
        schema: "agent-declaration/v1",
        id: "factory-agent",
        name: `Version ${n}`,
        instructions: "Same declaration interpreter",
        runtimes: [{ type: "codex" }],
      },
    });
  const compare = () => {
    const oracle = createEntityStore({
      readBatch: () => ({
        sourceRevision: store.readHead()!.revision,
        events,
        cursor: null,
        done: true,
        accessedItems: events.length,
      }),
      readContentBlob: store.readContentBlob,
    });
    assert.deepEqual(reader.get("agent", "factory-agent"), oracle.get("agent", "factory-agent"));
    assert.deepEqual(reader.list("agent"), oracle.list("agent"));
    assert.deepEqual(indexed.get("agent", "factory-agent"), oracle.get("agent", "factory-agent"));
    assert.deepEqual(indexed.list("agent"), oracle.list("agent"));
    assert.equal(reader.get("agent", "missing"), null);
  };
  const append = (candidate: Parameters<CanonicalEventStore["append"]>[0]) => {
    store.append(candidate);
    events.push(candidate.event);
    compare();
  };
  try {
    append(upsert(1));
    input.withReadSession?.(() => {
      assert.equal(reader.get("agent", "factory-agent")?.workspaceRevision, base + 1);
    });
    const newer = upsert(2);
    append(newer);
    append(
      compileAgentRetired({
        ...envelope(3),
        entityId: "factory-agent",
        priorVersion: base + 2,
        retiredAt: "2026-11-04T01:00:00.000Z",
        reason: "Retirement is independent of the declaration",
      }),
    );
    append(
      compileEntityDeleted({
        ...envelope(4),
        entityKind: "agent",
        entityId: "factory-agent",
        baseBlobSha256: newer.event.payload.declarationDocumentClaim.sha256,
        reason: "Delete the current entity",
      }),
    );
    assert.deepEqual(reader.list("agent"), []);
    append(upsert(5));
    assert.equal((reader.get("agent", "factory-agent")!.value as { lifecycleState: string }).lifecycleState, "retired");
  } finally {
    reader.close();
  }
}
