// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactTimelineQuery, ArtifactTimelineRead, ArtifactTimelineRow } from "@harness-anything/kernel";
import { daemonGuiReadMethods, validateDaemonRpcCall } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { daemonGuiReadSchemas } from "../src/protocol/daemon-protocol-schema-registry.ts";
import { DAEMON_ARTIFACTS_LIST_SCHEMA } from "../src/protocol/daemon-protocol-schema-ids.ts";
import { readArtifactsGui, type ArtifactsProjectionReads } from "../src/artifacts-gui-read.ts";
import {
  serializeArtifactsList,
  validateArtifactsList,
  type ArtifactsListResult,
} from "../src/protocol/artifacts-gui-contract.ts";

const row = (overrides: Partial<ArtifactTimelineRow> = {}): ArtifactTimelineRow => ({
  packageDir: "task_reported-slug",
  relative: "artifacts/reports/weathering.html",
  kind: "html",
  occurredAt: "2026-08-29T09:00:00.000Z",
  sizeBytes: 19,
  taskId: "task_reported",
  taskTitle: "Reported task",
  packagePath: "tasks/task_reported-slug",
  ...overrides,
});

/** The projection seam: one ordered index page. The storage test owns ordering, totals, and the
 * cursor boundary; this stub locks what the daemon sends and how it renders the answered page. */
function projectionStub(
  answer: (
    query: ArtifactTimelineQuery,
  ) => Partial<ArtifactTimelineRead> & { readonly rows: readonly ArtifactTimelineRow[] },
): ArtifactsProjectionReads & { readonly queries: ArtifactTimelineQuery[] } {
  const queries: ArtifactTimelineQuery[] = [];
  return {
    queries,
    readArtifactTimelinePage: (query) => {
      queries.push(query);
      const result = answer(query);
      return {
        status: result.status ?? "ready",
        rows: result.rows,
        hasMore: result.hasMore ?? false,
        counts: result.counts ?? { html: result.rows.length, md: 0, raw: 0 },
        countsCapped: result.countsCapped ?? { html: false, md: false, raw: false },
        watermark: result.watermark ?? 9,
        sourceRevision: result.sourceRevision ?? 9,
      };
    },
  };
}

test("the artifacts list read facet is registered, payload-closed, and defaults to html", () => {
  const facet = daemonGuiReadMethods.find(({ method }) => method === "repo.artifacts.list");
  assert.ok(facet, "repo.artifacts.list must be registered");
  assert.equal(facet.guiBridgeMethod, "listArtifacts");
  assert.equal(facet.outputSchemaId, DAEMON_ARTIFACTS_LIST_SCHEMA.id);
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.artifacts.list",
      params: { repo: { repoId: "artifacts-gui" }, payload: {} },
    }),
    [],
  );
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.artifacts.list",
      params: { repo: { repoId: "artifacts-gui" }, payload: { kind: "md" } },
    }),
    [],
  );
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.artifacts.list",
      params: { repo: { repoId: "artifacts-gui" }, payload: { kind: "raw" } },
    }),
    [],
  );
  assert.notDeepEqual(
    validateDaemonRpcCall({
      method: "repo.artifacts.list",
      params: { repo: { repoId: "artifacts-gui" }, payload: { kind: "pdf" } },
    }),
    [],
  );
  assert.notDeepEqual(
    validateDaemonRpcCall({
      method: "repo.artifacts.list",
      params: { repo: { repoId: "artifacts-gui" }, payload: { kind: "html", includeSecrets: true } },
    }),
    [],
  );
});

test("the read renders the projection page as a ledger-time artifact row", () => {
  const projection = projectionStub(() => ({ rows: [row()], counts: { html: 2, md: 1, raw: 1 } }));
  const result = readArtifactsGui({ projection, input: { repoId: "artifacts-gui" } }, {});
  assert.deepEqual(validateArtifactsList(result), []);
  assert.equal(parseDaemonGuiReadResult("repo.artifacts.list", result), result);
  assert.equal(result.kind, "html");
  assert.deepEqual(result.counts, { html: 2, md: 1, raw: 1 });
  assert.deepEqual(result.countsCapped, { html: false, md: false, raw: false });
  assert.deepEqual(result.artifacts, [
    {
      taskId: "task_reported",
      taskTitle: "Reported task",
      packagePath: "tasks/task_reported-slug",
      path: "artifacts/reports/weathering.html",
      kind: "html",
      mediaType: "text/html",
      sizeBytes: 19,
      time: "2026-08-29T09:00:00.000Z",
      timeSource: "ledger",
    },
  ]);
  assert.deepEqual(projection.queries, [{ kind: "html", limit: 100 }]);

  const raw = readArtifactsGui(
    {
      projection: projectionStub(() => ({
        rows: [
          row({
            relative: "artifacts/reports/dossier.pdf",
            kind: "raw",
            sizeBytes: 13,
            taskId: null,
            taskTitle: null,
            packagePath: null,
          }),
        ],
      })),
      input: { repoId: "artifacts-gui" },
    },
    { kind: "raw" },
  );
  assert.equal(raw.kind, "raw");
  assert.equal(raw.artifacts[0]!.mediaType, "application/pdf", "raw media type claims its extension");
  assert.equal(raw.artifacts[0]!.taskId, null);
  assert.equal(raw.artifacts[0]!.packagePath, null);
  assert.equal(raw.artifacts[0]!.timeSource, "ledger");
});

test("a capped multi-reader count is surfaced per facet instead of being reported as exact", () => {
  const result = readArtifactsGui(
    {
      projection: projectionStub(() => ({
        rows: [row()],
        counts: { html: 999, md: 12, raw: 0 },
        countsCapped: { html: true, md: false, raw: false },
      })),
      input: { repoId: "artifacts-gui" },
    },
    {},
  );
  assert.deepEqual(validateArtifactsList(result), []);
  assert.deepEqual(result.countsCapped, { html: true, md: false, raw: false });
  assert.deepEqual(result.counts, { html: 999, md: 12, raw: 0 });
});

test("pagination forwards the decoded keyset and stops at the authoritative end signal", () => {
  const pages = [
    { rows: [row()], hasMore: true },
    { rows: [row({ relative: "artifacts/older.html", occurredAt: "2026-08-28T09:00:00.000Z" })], hasMore: false },
  ];
  const projection = projectionStub(() => pages.shift()!);
  const first = readArtifactsGui({ projection, input: { repoId: "pages" } }, { limit: 1 });
  assert.equal(first.page.cursor, null);
  assert.equal(typeof first.page.nextCursor, "string");
  const second = readArtifactsGui(
    { projection, input: { repoId: "pages" } },
    { limit: 1, cursor: first.page.nextCursor! },
  );
  assert.equal(second.page.cursor, first.page.nextCursor);
  assert.equal(second.page.nextCursor, null);
  assert.deepEqual(
    projection.queries.map(({ after }) => after),
    [
      undefined,
      {
        occurredAt: "2026-08-29T09:00:00.000Z",
        relative: "artifacts/reports/weathering.html",
        packageDir: "task_reported-slug",
      },
    ],
  );
  for (const cursor of [
    "garbage",
    Buffer.from('["only-one-key"]').toString("base64url"),
    Buffer.from('["yesterday","artifacts/a.html","pkg"]').toString("base64url"),
  ])
    assert.throws(() => readArtifactsGui({ projection, input: { repoId: "pages" } }, { cursor }), {
      code: "invalid_command",
    });
});

test("an omitted or oversized limit still bounds the page at the shared maximum", () => {
  const seen: number[] = [];
  const projection = projectionStub(({ limit }) => {
    seen.push(limit);
    return { rows: [row()], hasMore: true };
  });
  readArtifactsGui({ projection, input: { repoId: "limit" } }, {});
  readArtifactsGui({ projection, input: { repoId: "limit" } }, { limit: 1_000_000 });
  readArtifactsGui({ projection, input: { repoId: "limit" } }, { limit: 0 });
  assert.deepEqual(seen, [100, 500, 1]);
});

test("the artifacts list validator locks the wire shape", () => {
  const base: ArtifactsListResult = {
    ok: true,
    status: "ready",
    repoId: "artifacts-gui",
    kind: "html",
    artifacts: [
      {
        taskId: "task_reported",
        taskTitle: "Reported task",
        packagePath: "tasks/task_reported-slug",
        path: "artifacts/reports/weathering.html",
        kind: "html",
        mediaType: "text/html",
        sizeBytes: 19,
        time: "2026-08-29T09:00:00.000Z",
        timeSource: "ledger",
      },
    ],
    page: { limit: 100, cursor: null, nextCursor: null },
    counts: { html: 1, md: 0, raw: 0 },
    countsCapped: { html: false, md: false, raw: false },
    watermark: 9,
    sourceRevision: 9,
  };
  assert.deepEqual(validateArtifactsList(base), []);
  assert.equal(serializeArtifactsList(base), `${JSON.stringify(base)}\n`);
  for (const mutate of [
    (value: ArtifactsListResult) => ({ ...value, kind: "pdf" }),
    (value: ArtifactsListResult) => ({ ...value, counts: { html: 1 } }),
    (value: ArtifactsListResult) => ({ ...value, counts: { html: 1, md: 0 } }),
    (value: ArtifactsListResult) => ({ ...value, countsCapped: undefined }),
    (value: ArtifactsListResult) => ({ ...value, countsCapped: { html: false, md: false } }),
    (value: ArtifactsListResult) => ({ ...value, countsCapped: { html: "no", md: false, raw: false } }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: "many" }),
    (value: ArtifactsListResult) => ({ ...value, apiKey: "secret" }),
    (value: ArtifactsListResult) => ({ ...value, nextCursor: null }),
    (value: ArtifactsListResult) => ({ ...value, page: undefined }),
    (value: ArtifactsListResult) => ({ ...value, page: { ...value.page, nextCursor: "" } }),
    (value: ArtifactsListResult) => ({ ...value, page: { ...value.page, cursor: 1 } }),
    (value: ArtifactsListResult) => ({ ...value, page: { ...value.page, limit: 501 } }),
  ])
    assert.notDeepEqual(validateArtifactsList(mutate(base)), []);
  const artifact = base.artifacts[0]!;
  for (const mutate of [
    (value: ArtifactsListResult) => ({
      ...value,
      artifacts: [{ ...artifact, path: "docs/outside.html" }],
    }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...artifact, time: "yesterday" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...artifact, timeSource: "filesystem" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...artifact, taskId: "" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...artifact, packagePath: "/etc" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...artifact, kind: "htm" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...artifact, mediaType: "" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...artifact, sizeBytes: -1 }] }),
    (value: ArtifactsListResult) => ({
      ...value,
      artifacts: [
        {
          taskId: artifact.taskId,
          taskTitle: artifact.taskTitle,
          packagePath: artifact.packagePath,
          path: artifact.path,
          kind: artifact.kind,
          time: artifact.time,
          timeSource: artifact.timeSource,
        },
      ],
    }),
  ])
    assert.notDeepEqual(validateArtifactsList(mutate(base)), [], `mutation must be rejected`);
});

test("the artifacts list schema is registry-closed with a negative fixture", () => {
  const entry = daemonGuiReadSchemas.find(({ id }) => id === DAEMON_ARTIFACTS_LIST_SCHEMA.id);
  assert.ok(entry, "the artifacts list schema must be registered");
  assert.deepEqual(entry.negativeFixtures, ["packages/daemon/fixtures/contracts/daemon-artifacts-list-invalid.json"]);
  assert.notDeepEqual(
    validateArtifactsList(
      JSON.parse(
        '{"ok":true,"status":"ready","repoId":"r","kind":"html","artifacts":[{"taskId":"t","taskTitle":"T","packagePath":"tasks/t","path":"artifacts/a.html","kind":"html","mediaType":"text/html","sizeBytes":1,"time":"yesterday","timeSource":"ledger"}],"counts":{"html":1,"md":0,"raw":0},"watermark":0,"sourceRevision":0}',
      ),
    ),
    [],
  );
});

test("artifacts pagination validates the shared query limit and cursor contract", () => {
  for (const payload of [{ limit: 1 }, { limit: 500, cursor: "opaque", kind: "raw" }])
    assert.deepEqual(
      validateDaemonRpcCall({ method: "repo.artifacts.list", params: { repo: { repoId: "pages" }, payload } }),
      [],
    );
  for (const payload of [
    { limit: 0 },
    { limit: -1 },
    { limit: 501 },
    { limit: 1.5 },
    { limit: "2" },
    { cursor: "" },
    { cursor: 1 },
  ])
    assert.notDeepEqual(
      validateDaemonRpcCall({ method: "repo.artifacts.list", params: { repo: { repoId: "pages" }, payload } }),
      [],
    );
});
