// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { compileEntityUpsert } from "@harness-anything/kernel/internal/domain/entity-event-compile.ts";
import { createEntityStore } from "../../src/store/entity-store.ts";

test("current declaration intent avoids canonical history replay", () => {
  const candidate = compileEntityUpsert({
    eventId: "current",
    opId: "current",
    workspaceRevision: 100001,
    actor: { principal: { personId: "current" }, executor: null },
    source: "local",
    occurredAt: "2026-11-04T00:00:00.000Z",
    entityKind: "agent",
    entity: {
      schema: "agent-declaration/v1",
      id: "current",
      name: "Current",
      instructions: "Only this declaration",
      runtimes: [{ type: "codex" }],
    },
  });
  const reader = createEntityStore({
    readBatch: () => {
      throw new Error("unreturned canonical history was read");
    },
    readEntityDeclarations: (query) =>
      query.id === "missing" ? [] : [{ declaration: candidate.event, retirement: null }],
    readContentBlob: (sha) => {
      const body = candidate.blobs.find((blob) => blob.sha256 === sha)?.body;
      return body === undefined ? null : new TextEncoder().encode(body);
    },
  });
  assert.equal(reader.get("agent", "current")?.workspaceRevision, 100001);
  assert.equal(reader.get("agent", "missing"), null);
  assert.deepEqual(
    reader.list("agent").map((row) => row.id),
    ["current"],
  );
});
