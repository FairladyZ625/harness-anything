// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { DaemonLogEntryV1 } from "../src/daemon-log-contract.ts";
import { makeDaemonLogService, type DaemonLogStorePort } from "../src/daemon-log-service.ts";

test("daemon log service persists a canonical entry and returns a typed page", async () => {
  const memory = makeMemoryStore();
  const service = makeDaemonLogService({
    store: memory.store,
    now: () => "2026-07-16T12:00:00.000Z"
  });
  await service.append({
    level: "info",
    source: "daemon",
    component: "protocol.json-rpc",
    event: "repo.tasks.list",
    message: "completed repo.tasks.list"
  }, { repo: { repoId: "canonical", canonicalRoot: "/tmp/canonical" } });

  const page = await service.list({ since: "2026-07-16T12:00:00Z" }, {
    repo: { repoId: "canonical", canonicalRoot: "/tmp/canonical" }
  });

  assert.equal(page.schema, "daemon-log-page/v1");
  assert.equal(page.entries.length, 1);
  assert.deepEqual(page.entries[0], {
    schema: "daemon-log-entry/v1",
    timestamp: "2026-07-16T12:00:00.000Z",
    sequence: 0,
    level: "info",
    source: "daemon",
    component: "protocol.json-rpc",
    event: "repo.tasks.list",
    message: "completed repo.tasks.list",
    repoId: "canonical",
    redaction: {
      policy: "runtime-log-redaction/v1",
      fieldsRemoved: [],
      truncated: false
    }
  });
  assert.equal(page.nextCursor, null);
  assert.equal(page.truncated, false);
  assert.equal(page.droppedCount, 0);
  assert.deepEqual(memory.records, page.entries);
});

test("daemon log service redacts before append and independently on read", async () => {
  const memory = makeMemoryStore();
  const service = makeDaemonLogService({ store: memory.store, now: () => "2026-07-16T12:00:00.000Z" });
  const context = { repo: { repoId: "canonical", canonicalRoot: "/srv/team/repo" } };
  const appended = await service.append({
    level: "error",
    source: "cli",
    component: "command.executor",
    event: "command.failed",
    message: "failed at /srv/team/repo/private.txt token=top-secret HOME=/Users/alice",
    hint: "retry from /srv/team/repo"
  }, context);
  assert.equal(appended.message.includes("top-secret"), false);
  assert.equal(appended.message.includes("/Users/alice"), false);
  assert.equal(appended.message.includes("/srv/team/repo"), false);
  assert.equal(appended.hint?.includes("/srv/team/repo"), false);
  assert.deepEqual(appended.redaction.fieldsRemoved, [
    "message.canonicalRoot",
    "message",
    "hint.canonicalRoot"
  ]);

  memory.records.push({
    ...appended,
    sequence: 1,
    message: "authorization: Bearer second-secret",
    redaction: { policy: "runtime-log-redaction/v1", fieldsRemoved: [], truncated: false }
  });
  const page = await service.list({ errorOnly: true }, context);
  assert.equal(JSON.stringify(page).includes("second-secret"), false);
  assert.equal(page.entries[0]?.redaction.fieldsRemoved.includes("message"), true);
});

test("daemon log cursor is bound to repo and filters", async () => {
  let tick = 0;
  const service = makeDaemonLogService({
    store: makeMemoryStore().store,
    now: () => `2026-07-16T12:00:0${tick++}.000Z`
  });
  const canonical = { repo: { repoId: "canonical", canonicalRoot: "/tmp/canonical" } };
  await service.append({ level: "info", source: "daemon", component: "protocol", event: "first", message: "first" }, canonical);
  await service.append({ level: "error", source: "daemon", component: "protocol", event: "second", message: "second" }, canonical);

  const first = await service.list({ limit: 1 }, canonical);
  assert.equal(first.entries[0]?.event, "second");
  assert.notEqual(first.nextCursor, null);
  const second = await service.list({ limit: 1, cursor: first.nextCursor }, canonical);
  assert.equal(second.entries[0]?.event, "first");
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    service.list({ limit: 2, cursor: first.nextCursor }, canonical),
    { code: "invalid_daemon_log_cursor" }
  );
  await assert.rejects(
    service.list({ limit: 1, cursor: first.nextCursor }, { repo: { repoId: "other", canonicalRoot: "/tmp/other" } }),
    { code: "invalid_daemon_log_cursor" }
  );
  const cursor = first.nextCursor ?? "";
  const tampered = `${cursor.startsWith("A") ? "B" : "A"}${cursor.slice(1)}`;
  await assert.rejects(service.list({ limit: 1, cursor: tampered }, canonical), { code: "invalid_daemon_log_cursor" });
});

test("daemon log list input rejects unknown or out-of-range fields", async () => {
  const service = makeDaemonLogService({ store: makeMemoryStore().store });
  const context = { repo: { repoId: "canonical", canonicalRoot: "/tmp/canonical" } };
  await assert.rejects(service.list("invalid" as never, context), { code: "invalid_daemon_log_list_input" });
  await assert.rejects(service.list({ limit: 201 }, context), { code: "invalid_daemon_log_list_input" });
  await assert.rejects(
    service.list({ limit: 1, relaxedValidation: true } as never, context),
    { code: "invalid_daemon_log_list_input" }
  );
});

test("daemon log message and hint limits are enforced in UTF-8 bytes", async () => {
  const service = makeDaemonLogService({ store: makeMemoryStore().store, now: () => "2026-07-16T12:00:00.000Z" });
  const context = { repo: { repoId: "canonical", canonicalRoot: "/tmp/canonical" } };
  const entry = await service.append({
    level: "warn",
    source: "daemon",
    component: "protocol",
    event: "bounded",
    message: "🙂".repeat(2_000),
    hint: "界".repeat(1_000)
  }, context);
  assert.equal(Buffer.byteLength(entry.message, "utf8") <= 4_096, true);
  assert.equal(Buffer.byteLength(entry.hint ?? "", "utf8") <= 2_048, true);
  assert.equal(entry.redaction.truncated, true);
});

function makeMemoryStore(): { readonly store: DaemonLogStorePort; readonly records: unknown[] } {
  const records: unknown[] = [];
  return {
    records,
    store: {
      append: async (entry: DaemonLogEntryV1) => { records.push(entry); },
      read: async () => ({ records, droppedCount: 0 })
    }
  };
}
