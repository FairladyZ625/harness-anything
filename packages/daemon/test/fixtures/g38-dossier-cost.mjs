import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Measure the real indexed window and synthesis compiler with the prior cut already accepted.
// Fixture setup is outside the measurement, and no sorted/filtering JS copy of history exists.
export async function measureDossierHistory(rootDir, size) {
  const from = (file) => import(pathToFileURL(path.join(rootDir, file)).href);
  const [
    { readSqliteEventWindow },
    { readDossierContext },
    { prepareDossierSynthesis },
    { compileDossierSynthesis },
    { dossierStatePath },
  ] = await Promise.all([
    from("packages/storage/src/store/sqlite-event-window.ts"),
    from("packages/application/src/queries/living-dossier.ts"),
    from("packages/application/src/commands/living-dossier.ts"),
    from("packages/kernel/src/domain/dossier-synthesis-event.ts"),
    from("packages/kernel/src/domain/living-dossier.ts"),
  ]);
  const db = new DatabaseSync(":memory:");
  try {
    const delta = 4,
      head = size + delta,
      verticalId = "cost/dossier",
      slot = {
        id: "context",
        path: "context.md",
        kind: "markdown",
        entityKinds: ["task", "decision"],
        requiredAnchors: ["context"],
      },
      source = "local",
      occurredAt = "2026-11-22T00:00:00.000Z",
      actor = { principal: { personId: "person-g38" }, executor: null },
      counts = {
        indexReads: 0,
        rowsDecoded: 0,
        headReads: 0,
        projectedDocumentReads: 0,
        pointEventReads: 0,
        claims: 0,
      };
    db.exec("CREATE TABLE event(revision INTEGER PRIMARY KEY, event_json TEXT NOT NULL)");
    db.prepare(
      `WITH RECURSIVE numbers(revision) AS (
      SELECT 1 UNION ALL SELECT revision+1 FROM numbers WHERE revision < ?
    ) INSERT INTO event SELECT revision,json_object('schema','task-event/v1','type','task_completed',
      'taskId','task-fixture','opId','cost-'||revision,'eventId','event-cost-'||revision,
      'workspaceRevision',revision,'occurredAt',?,'payload',json_object()) FROM numbers`,
    ).run(head, occurredAt);
    const accepted = compileDossierSynthesis({
      actor,
      source,
      slot,
      verticalId,
      occurredAt,
      opId: "prior",
      expectedWatermark: size - 1,
      watermark: size,
      sourceWatermark: size,
      workspaceRevision: size + 1,
      body: `<!-- dossier-watermark: ${size} -->\n# Context\nPreviously accepted project context.`,
    }).event;
    db.prepare("UPDATE event SET event_json=? WHERE revision=?").run(JSON.stringify(accepted), size + 1);
    const relation = JSON.parse(
      readFileSync(
        path.join(rootDir, "packages/kernel/fixtures/canonical-events/relation-event-v1/accepted.json"),
        "utf8",
      ),
    );
    relation.workspaceRevision = size + 2;
    db.prepare("UPDATE event SET event_json=? WHERE revision=?").run(JSON.stringify(relation), size + 2);
    const pointEvent = (revision) => {
      counts.pointEventReads++;
      return JSON.parse(db.prepare("SELECT event_json FROM event WHERE revision=?").get(revision).event_json);
    };
    const reader = {
      store: {
        readHead() {
          counts.headReads++;
          return { revision: head, opId: `cost-${head}` };
        },
        readEvent() {
          return pointEvent(head);
        },
        readEventAtRevision: pointEvent,
        readEventWindow: (query) =>
          readSqliteEventWindow(
            "cost",
            head,
            (sql, values) => {
              counts.indexReads++;
              const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values);
              assert.match(String(plan[0]?.detail), /SEARCH event USING INTEGER PRIMARY KEY/u);
              const rows = db.prepare(sql).all(...values);
              counts.rowsDecoded += rows.length;
              return rows;
            },
            () => assert.fail("dossier windows do not use historical time-sort"),
            query,
          ),
      },
      projection: {
        readDocumentMetadata(path) {
          counts.projectedDocumentReads++;
          return {
            status: "ready",
            document: path === dossierStatePath(verticalId, slot.id) ? { path, workspaceRevision: size + 1 } : null,
          };
        },
      },
    };
    const started = performance.now();
    const page = readDossierContext(reader, verticalId, slot);
    assert.equal(page.expectedWatermark, size);
    assert.equal(page.nextWatermark, head);
    assert.equal(page.done, true);
    assert.equal(page.changes.length, delta - 1, "ignore the prior synthesis in the source interval");
    assert.ok(
      page.changes.some((change) => change.entityRefs.includes(relation.payload.relation.source)),
      "include relations to a declared decision kind through a clause reference",
    );
    const prepared = prepareDossierSynthesis({
      actor,
      source,
      slot,
      verticalId,
      occurredAt,
      opId: "next",
      reader,
      expectedWatermark: page.expectedWatermark,
      watermark: page.nextWatermark,
      body: `<!-- dossier-watermark: ${head} -->\n# Context\nNew project context at the requested cut.`,
    });
    counts.claims = prepared.event.payload.documentClaims.length;
    return { size, counts, elapsedMs: performance.now() - started };
  } finally {
    db.close();
  }
}
