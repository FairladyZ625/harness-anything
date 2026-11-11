// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { EventStreamPort } from "@harness-anything/kernel";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection-factory.ts";

/** An empty canonical stream: enough for the projection to open, catch up and discard itself. */
function emptyEventStore(): EventStreamPort {
  return {
    readHead: () => null,
    read: () => ({ schema: "canonical-event-stream/v1", revision: 0, events: [] }),
    readEvent: () => null,
    readBatch: (cursor: string | null) => ({
      sourceRevision: 0,
      events: [],
      cursor,
      done: true,
      accessedItems: 0,
    }),
    queryEvents: () => [],
    append: () => ({}),
  } as unknown as EventStreamPort;
}

function captureDiscards(run: () => void): string[] {
  const logged: string[] = [],
    original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    run();
  } finally {
    console.error = original;
  }
  return logged.filter((line) => line.includes("projection_discard_started"));
}

function withProjectionRoot(body: (root: string, projectionPath: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "ha-explicit-rebuild-")),
    projectionPath = path.join(root, "task-projection.db");
  try {
    body(root, projectionPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an event-shape migration discards the warm projection instead of keeping the rows it reduced", () => {
  withProjectionRoot((root, projectionPath) => {
    const eventStore = emptyEventStore(),
      warm = makeTaskProjection({ rootDir: root, projectionPath, eventStore });
    warm.catchUp();
    warm.close();
    assert.equal(existsSync(projectionPath), true, "the warm projection exists before the rebuild");

    const discards = captureDiscards(() => {
      const rebuilt = makeTaskProjection({ rootDir: root, projectionPath, eventStore, discardExisting: true });
      rebuilt.catchUp();
      rebuilt.close();
    });
    assert.equal(discards.length, 1, "a migration that applies at attach discards the warm projection once");
    assert.match(discards[0]!, /"reason":"explicit_rebuild"/u);
    assert.equal(existsSync(projectionPath), true, "the projection is rebuilt from zero after the discard");
  });
});

test("a projection without a pending migration keeps its warm database", () => {
  withProjectionRoot((root, projectionPath) => {
    const eventStore = emptyEventStore(),
      warm = makeTaskProjection({ rootDir: root, projectionPath, eventStore });
    warm.catchUp();
    warm.close();

    const discards = captureDiscards(() => {
      const reused = makeTaskProjection({ rootDir: root, projectionPath, eventStore });
      reused.catchUp();
      reused.close();
    });
    assert.deepEqual(discards, [], "no migration means no discard");
  });
});
