// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { canonicalEventEntityRefs } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { compileFactWrite } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import {
  canonicalEventFleetSummary,
  canonicalEventSummary,
} from "@harness-anything/kernel/internal/domain/canonical-event-summary.ts";
import { serializePersistedCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { backfillPgDefaultEventSummaries } from "../../src/pg/pg-event-read-index-migration.ts";
import { eventAt } from "../store/task-event-store.fixtures.ts";
import { fact } from "../store/relation-graph-projection.fixtures.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";

test("external PostgreSQL upgrade drains default summaries before workspace reads", { timeout: 120_000 }, async () => {
  const fixture = await pgRuntimeFixture(),
    repoId = "default-summary-upgrade",
    scope = { tenantId: "default-summary", projectId: "default-summary", policyEpoch: 1, readers: [] },
    summaryReadBytes: { readonly default: number[]; readonly workspace: number[] } = { default: [], workspace: [] },
    queryTrace: { readonly kind: string; readonly bytes: number; readonly sql: string }[] = [],
    tracedPool = new Proxy(fixture.pool, {
      get(target, property) {
        if (property !== "connect") {
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key) {
              if (key === "query")
                return async (...args: unknown[]) => {
                  const sql = typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string }).text ?? ""),
                    result = await Reflect.apply(connection.query, connection, args);
                  if (/^\s*(?:SELECT|WITH)\b/iu.test(sql) && /\bFROM ha_events\b/u.test(sql)) {
                    const kind = sql.includes("default_summary_json AS summary_json")
                        ? sql.includes("canonical_task_id = $6")
                          ? "workspace"
                          : "default"
                        : "ancillary",
                      bytes = Buffer.byteLength(JSON.stringify((result as { rows: unknown[] }).rows));
                    queryTrace.push({ kind, bytes, sql });
                  }
                  return result;
                };
              const value: unknown = Reflect.get(connection, key);
              return typeof value === "function" ? value.bind(connection) : value;
            },
          });
        };
      },
    }),
    { eventStore, projection } = createPgStorageBackend({ pool: tracedPool as typeof fixture.pool, repoId, scope }),
    event = eventAt(1);
  try {
    const readSummaryPage = async (
      afterRevision: number,
      limit: number,
      fields?: { readonly taskIds: readonly string[] } | "fleet",
    ) => {
      const traceStart = queryTrace.length,
        page = await projection.readEventSummaries(afterRevision, limit, fields),
        current = queryTrace.slice(traceStart);
      queryTrace.length = traceStart;
      for (const { kind, bytes, sql } of current) {
        assert.doesNotMatch(sql, /\bevent_json\b/u, "serving summary SQL must not select canonical bodies");
        if (kind !== "ancillary") summaryReadBytes[kind as "default" | "workspace"].push(bytes);
      }
      return page;
    };
    await eventStore.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] }, 0, {
      repoId,
      holderId: "upgrade",
      epoch: 1,
    });
    await fixture.adminPool.query(
      "UPDATE ha_events SET summary_json=NULL,default_summary_json=NULL,read_index_version=5 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
      [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
    );

    let processed = 0;
    do {
      processed = (
        await fixture.adminPool.query<{ processed: number }>(
          "SELECT ha_backfill_event_read_indexes($1,$2,$3,$4) AS processed",
          [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
        )
      ).rows[0]!.processed;
    } while (processed > 0);

    await backfillPgDefaultEventSummaries(fixture.adminPool, scope, repoId);
    const pending = await fixture.adminPool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND default_summary_json IS NULL",
      [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
    );
    assert.equal(pending.rows[0]!.count, 0);
    assert.equal((await projection.readEventSummaries(0, 10)).events.length, 1);

    // Previous binaries still insert only original event columns. The upgrade trigger writes the
    // default summary during that insert, so every serving read remains independent of body size.
    const previousEvent = { ...eventAt(2), workspaceRevision: 200 },
      previousBody = serializePersistedCanonicalEvent(previousEvent).trimEnd(),
      largeEvents = [3200, 32000].map(
        (length, index) =>
          compileFactWrite({
            event: {
              ...fact(index + 3),
              eventId: `old-writer-${index}`,
              opId: `old-writer-op-${index}`,
              workspaceRevision: index + 3,
              taskId: index === 0 ? "task-small-body" : "task-large-body",
              payload: { ...fact(index + 3).payload, statement: "x".repeat(length) },
            },
          }).event,
      );
    for (const [index, oldEvent] of [previousEvent, ...largeEvents].entries()) {
      const revision = index + 2,
        body = index === 0 ? previousBody : serializePersistedCanonicalEvent(oldEvent).trimEnd();
      await fixture.adminPool.query(
        `INSERT INTO ha_events
           (tenant_id,project_id,repo_id,revision,op_id,event_id,event_type,event_json,summary_json,event_digest,occurred_at,
            actor_refs,entity_refs,readers,policy_epoch)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          scope.tenantId,
          scope.projectId,
          repoId,
          revision,
          oldEvent.opId,
          oldEvent.eventId,
          oldEvent.type,
          body,
          JSON.stringify(canonicalEventFleetSummary(oldEvent)),
          `sha256:${sha256Text(body)}`,
          oldEvent.occurredAt,
          [oldEvent.actor.principal.personId, ...(oldEvent.actor.executor ? [oldEvent.actor.executor.id] : [])],
          canonicalEventEntityRefs(oldEvent),
          scope.readers,
          scope.policyEpoch,
        ],
      );
    }
    const insertedSummaries = await fixture.adminPool.query<{ event_id: string; default_summary_json: string | null }>(
      "SELECT event_id,default_summary_json FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision >= 2 ORDER BY revision",
      [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
    );
    assert.equal(insertedSummaries.rows.length, 3);
    assert.ok(insertedSummaries.rows.every(({ default_summary_json }) => default_summary_json !== null));
    summaryReadBytes.default.length = 0;
    summaryReadBytes.workspace.length = 0;
    await fixture.adminPool.query(
      "UPDATE ha_repo_heads SET revision=$5,head_op_id=$6,head_event_digest=$7,head_digest=$8 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
      [
        scope.tenantId,
        scope.projectId,
        scope.policyEpoch,
        repoId,
        4,
        largeEvents[1]!.opId,
        `sha256:${sha256Text(serializePersistedCanonicalEvent(largeEvents[1]!).trimEnd())}`,
        `sha256:${sha256Text(serializePersistedCanonicalEvent(largeEvents[1]!).trimEnd())}`,
      ],
    );
    await fixture.adminPool.query(
      "UPDATE ha_projection_meta SET watermark=$4,source_revision=$4 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'",
      [scope.tenantId, scope.projectId, scope.policyEpoch, 4],
    );

    // The unrelated previous-writer row must not block task reads, and 3.2KB/32KB old-writer
    // bodies must produce identical SQL result sizes on default, workspace and observe-tail reads.
    const taskPage = await readSummaryPage(0, 10, { taskIds: [event.taskId] });
    assert.deepEqual(
      taskPage.events.map(({ eventId }) => eventId),
      [event.eventId],
    );
    const defaultPage = await readSummaryPage(0, 10);
    assert.deepEqual(
      defaultPage.events.find(({ eventId }) => eventId === previousEvent.eventId),
      canonicalEventSummary(previousEvent),
    );
    const expectedLarge = largeEvents.map((oldEvent) => canonicalEventSummary(oldEvent));
    assert.deepEqual(
      defaultPage.events.filter(({ eventId }) => largeEvents.some((oldEvent) => oldEvent.eventId === eventId)),
      expectedLarge,
    );
    const largeDefault = await readSummaryPage(2, 10),
      largeTask = await readSummaryPage(2, 10, { taskIds: [largeEvents[0]!.taskId] }),
      repeatedDefault = await readSummaryPage(2, 10),
      repeatedTask = await readSummaryPage(2, 10, { taskIds: [largeEvents[0]!.taskId] });
    assert.deepEqual(largeDefault.events, expectedLarge);
    assert.deepEqual(largeTask.events, [expectedLarge[0]]);
    assert.deepEqual(repeatedDefault, largeDefault);
    assert.deepEqual(repeatedTask, largeTask);

    summaryReadBytes.default.length = 0;
    summaryReadBytes.workspace.length = 0;
    const smallDefault = await readSummaryPage(2, 1),
      largeDefaultPage = await readSummaryPage(3, 1),
      smallWorkspace = await readSummaryPage(2, 1, { taskIds: [largeEvents[0]!.taskId!] }),
      largeWorkspace = await readSummaryPage(2, 1, { taskIds: [largeEvents[1]!.taskId!] });
    assert.deepEqual(smallDefault.events, [expectedLarge[0]]);
    assert.deepEqual(largeDefaultPage.events, [expectedLarge[1]]);
    assert.deepEqual(smallWorkspace.events, [expectedLarge[0]]);
    assert.deepEqual(largeWorkspace.events, [expectedLarge[1]]);
    await readSummaryPage(2, 1);
    await readSummaryPage(3, 1);
    await readSummaryPage(2, 1, { taskIds: [largeEvents[0]!.taskId!] });
    await readSummaryPage(2, 1, { taskIds: [largeEvents[1]!.taskId!] });
    const bodySizes = await fixture.adminPool.query<{ readonly revision: number; readonly bytes: number }>(
      "SELECT revision,octet_length(event_json)::integer AS bytes FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision IN (3,4) ORDER BY revision",
      [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
    );
    assert.equal(bodySizes.rows.length, 2);
    assert.ok(bodySizes.rows[1]!.bytes - bodySizes.rows[0]!.bytes >= 28_000);
    assert.equal(
      new Set(summaryReadBytes.default).size,
      1,
      `default summary SQL bytes changed across body sizes/repeats: ${summaryReadBytes.default.join(",")}`,
    );
    assert.equal(
      new Set(summaryReadBytes.workspace).size,
      1,
      `workspace summary SQL bytes changed across body sizes/repeats: ${summaryReadBytes.workspace.join(",")}`,
    );
    const tailSqlPage = await readSummaryPage(2, 65);
    assert.deepEqual(tailSqlPage.events, expectedLarge);
    const tailSqlBytes = summaryReadBytes.default.at(-1)!;
    const repeatedTailSqlPage = await readSummaryPage(2, 65);
    assert.deepEqual(repeatedTailSqlPage, tailSqlPage);
    assert.equal(
      summaryReadBytes.default.at(-1),
      tailSqlBytes,
      "repeated tail projection SQL results must stay bounded",
    );
    assert.ok(
      tailSqlBytes >= summaryReadBytes.default[0]!,
      "a multi-row tail page may be larger than a single-row page, but must not depend on body size",
    );
    // The daemon observe-tail adapter delegates to this bounded projection query; its mode and
    // cursor behavior are covered by packages/daemon/test/g38-event-summary-bounded.integration.test.mjs.

    // The trigger is the compatibility writer for a previous binary, so exercise the less common
    // summary shapes at that boundary too. The stored projection must remain byte-for-byte
    // equivalent after JSON decoding to the kernel authority, including UTF-16 clipping.
    const richEvent = {
      schema: "fact-event/v1",
      eventId: "old-writer-rich",
      workspaceRevision: 5,
      opId: "old-writer-rich-op",
      factId: "F-RICH0001",
      type: "fact_recorded",
      actor: { principal: { personId: "rich-principal" }, executor: null },
      source: "local",
      occurredAt: "2026-08-13T00:00:00.000Z",
      payload: {
        statement: `${"汉".repeat(279)}😀`,
        text: `nul-\u0000-${"x".repeat(300)}`,
        title: "",
        runtimeSessionId: "",
        instanceId: "instance-rich",
        entityKind: "fact",
        entityId: "F-RICH0001",
        witness: { gateId: "", result: "passed" },
        review: { verdict: "approved" },
        documentClaims: [{ path: "facts/F-RICH0001.md" }, { path: "" }],
        subject: { kind: "task", taskId: "subject-task" },
      },
    } as const;
    const richBody = JSON.stringify(richEvent);
    await fixture.adminPool.query(
      `INSERT INTO ha_events
         (tenant_id,project_id,repo_id,revision,op_id,event_id,event_type,event_json,summary_json,event_digest,occurred_at,
          actor_refs,entity_refs,readers,policy_epoch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        scope.tenantId,
        scope.projectId,
        repoId,
        5,
        richEvent.opId,
        richEvent.eventId,
        richEvent.type,
        richBody,
        JSON.stringify(canonicalEventFleetSummary(richEvent as never)),
        `sha256:${sha256Text(richBody)}`,
        richEvent.occurredAt,
        [richEvent.actor.principal.personId],
        [],
        scope.readers,
        scope.policyEpoch,
      ],
    );
    const richRow = await fixture.adminPool.query<{ default_summary_json: string }>(
      "SELECT default_summary_json FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision=5",
      [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
    );
    assert.deepEqual(
      canonicalEventSummary(JSON.parse(richRow.rows[0]!.default_summary_json)),
      canonicalEventSummary(richEvent as never),
    );
    for (const payload of [
      { ignored: { statement: "nested-decoy" }, statement: "correct-statement" },
      { statement: "__ha_summary_text__", text: "correct-text", title: "__ha_summary_statement__" },
      { statement: `${"😀".repeat(139)}x😀`, documentClaims: [{ path: "nul-\u0000.md" }] },
      { statement: `${"x".repeat(279)}\ud800`, text: "literal-\\u0000", witness: {}, review: {} },
    ]) {
      const candidate = { ...richEvent, payload },
        stored = await fixture.adminPool.query<{ source: string }>("SELECT ha_default_summary_source($1) AS source", [
          JSON.stringify(candidate),
        ]);
      assert.deepEqual(
        canonicalEventSummary(JSON.parse(stored.rows[0]!.source)),
        canonicalEventSummary(candidate as never),
        "old-writer source must preserve the kernel summary, including nested keys and JSON escapes",
      );
    }
    console.log(
      "DEFAULT_SUMMARY_READ_BYTES",
      JSON.stringify({
        body: bodySizes.rows.map(({ bytes }) => bytes),
        default: summaryReadBytes.default,
        workspace: summaryReadBytes.workspace,
      }),
    );
    await backfillPgDefaultEventSummaries(fixture.adminPool, scope, repoId);
    const remaining = await fixture.adminPool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND default_summary_json IS NULL",
      [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
    );
    assert.equal(remaining.rows[0]!.count, 0);
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
