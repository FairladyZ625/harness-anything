// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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

/** 投影 stub:文档投影行 + 事件时间 + task 归属三块事实全部可控,用于锁定 join 语义。 */
function projectionStub(input: {
  readonly documents?: Readonly<Record<string, number>>;
  readonly events?: Readonly<Record<number, string>>;
  readonly tasks?: readonly { taskId: string; title: string | null; packagePath: string }[];
  readonly status?: "ready" | "pending";
}): ArtifactsProjectionReads {
  return {
    readTaskStatuses: () => ({
      status: input.status ?? "ready",
      rows: (input.tasks ?? []).map(({ taskId }) => ({ taskId })),
      watermark: 9,
      sourceRevision: 9,
    }),
    readTaskRuntimeBatch: ({ taskIds }) => ({
      rows: (input.tasks ?? []).filter(({ taskId }) => taskIds.includes(taskId)),
    }),
    readDocument: (documentPath) =>
      Object.hasOwn(input.documents ?? {}, documentPath)
        ? { document: { workspaceRevision: input.documents![documentPath]! } }
        : { document: null },
    readEventWitness: (revision) => {
      const occurredAt = input.events?.[revision];
      return occurredAt === undefined ? null : { workspaceRevision: revision, occurredAt };
    },
  };
}

function taskFixture(root: string, name: string, files: Readonly<Record<string, string>>, mtime?: Date): void {
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, "harness", "tasks", name, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
    if (mtime !== undefined) utimesSync(target, mtime, mtime);
  }
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

test("the read joins task attribution, ledger time, and mtime fallback; non-artifacts stay out", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-artifacts-gui-"));
  try {
    const mtime = new Date("2026-08-01T00:00:00.000Z");
    taskFixture(
      root,
      "task_reported-slug",
      {
        "artifacts/reports/weathering.html": "<h1>Weathering</h1>",
        "artifacts/notes.md": "# Notes\n",
        "artifacts/reports/dossier.pdf": "%PDF-1.7 body",
        "task_plan.md": "# Plan (not an artifact)\n",
      },
      mtime,
    );
    taskFixture(root, "task_draft-slug", { "artifacts/unsynced.html": "<p>draft</p>" }, mtime);
    // 非 artifacts/ 目录下的 html 不得进入时间线(阴性证据)。
    taskFixture(root, "task_reported-slug", { "docs/not-an-artifact.html": "<p>no</p>" }, mtime);
    // 符号链接产物不跟。
    symlinkSync(
      path.join(root, "harness", "tasks", "task_reported-slug", "artifacts", "reports", "weathering.html"),
      path.join(root, "harness", "tasks", "task_reported-slug", "artifacts", "linked.html"),
    );
    const result = readArtifactsGui(
      {
        rootDir: root,
        projection: projectionStub({
          documents: {
            "tasks/task_reported-slug/artifacts/notes.md": 4,
            "tasks/task_reported-slug/artifacts/reports/weathering.html": 5,
          },
          events: { 4: "2026-08-28T10:00:00.000Z", 5: "2026-08-29T09:00:00.000Z" },
          tasks: [{ taskId: "task_reported", title: "Reported task", packagePath: "tasks/task_reported-slug" }],
        }),
        input: { repoId: "artifacts-gui" },
      },
      {},
    );
    assert.deepEqual(validateArtifactsList(result), []);
    assert.equal(parseDaemonGuiReadResult("repo.artifacts.list", result), result);
    assert.equal(result.kind, "html");
    assert.deepEqual(result.counts, { html: 2, md: 1, raw: 1 });
    const paths = result.artifacts.map((row) => row.path);
    // 台账时间(08-29)在前,未同步产物的 mtime(08-01)在后。
    assert.deepEqual(paths, ["artifacts/reports/weathering.html", "artifacts/unsynced.html"]);
    assert.ok(!paths.includes("docs/not-an-artifact.html"), "html outside artifacts/ must not be listed");
    assert.ok(!paths.includes("linked.html"), "symlinked artifacts must not be listed");
    const weathering = result.artifacts[0]!;
    assert.equal(weathering.taskId, "task_reported");
    assert.equal(weathering.taskTitle, "Reported task");
    assert.equal(weathering.packagePath, "tasks/task_reported-slug");
    assert.equal(weathering.time, "2026-08-29T09:00:00.000Z");
    assert.equal(weathering.timeSource, "ledger");
    const unsynced = result.artifacts[1]!;
    assert.equal(unsynced.timeSource, "mtime");
    assert.equal(unsynced.time, "2026-08-01T00:00:00.000Z");
    assert.equal(unsynced.taskId, null);
    assert.equal(unsynced.packagePath, null);
    assert.equal(weathering.mediaType, "text/html");
    assert.equal(weathering.sizeBytes, "<h1>Weathering</h1>".length);

    // 二进制产物过去连一行都不存在:时间线只认 html/md,PDF 既不在列表里也没有理由。
    const raw = readArtifactsGui(
      {
        rootDir: root,
        projection: projectionStub({
          documents: { "tasks/task_reported-slug/artifacts/reports/dossier.pdf": 4 },
          events: { 4: "2026-08-28T10:00:00.000Z" },
          tasks: [{ taskId: "task_reported", title: "Reported task", packagePath: "tasks/task_reported-slug" }],
        }),
        input: { repoId: "artifacts-gui" },
      },
      { kind: "raw" },
    );
    assert.deepEqual(validateArtifactsList(raw), []);
    assert.equal(raw.kind, "raw");
    assert.deepEqual(
      raw.artifacts.map((row) => row.path),
      ["artifacts/reports/dossier.pdf"],
    );
    const dossier = raw.artifacts[0]!;
    assert.equal(dossier.mediaType, "application/pdf");
    assert.equal(dossier.sizeBytes, "%PDF-1.7 body".length);
    assert.equal(dossier.taskId, "task_reported");
    assert.equal(dossier.timeSource, "ledger");
    // html/md 面不得因为新增 raw 面而混入二进制行。
    assert.equal(
      result.artifacts.some((row) => row.path.endsWith(".pdf")),
      false,
    );

    const markdown = readArtifactsGui(
      {
        rootDir: root,
        projection: projectionStub({
          documents: { "tasks/task_reported-slug/artifacts/notes.md": 4 },
          events: { 4: "2026-08-28T10:00:00.000Z" },
        }),
        input: { repoId: "artifacts-gui" },
      },
      { kind: "md" },
    );
    assert.equal(markdown.kind, "md");
    assert.equal(markdown.artifacts.length, 1);
    assert.equal(markdown.artifacts[0]!.time, "2026-08-28T10:00:00.000Z");
    assert.equal(markdown.artifacts[0]!.timeSource, "ledger");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a projected document without its revision event falls back to mtime", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-artifacts-hole-"));
  try {
    taskFixture(root, "task_hole-slug", { "artifacts/hole.html": "<p>hole</p>" }, new Date("2026-08-02T00:00:00.000Z"));
    const result = readArtifactsGui(
      {
        rootDir: root,
        projection: projectionStub({
          documents: { "tasks/task_hole-slug/artifacts/hole.html": 6 },
          // revision 6 无事件(投影洞):不得借用别的事件时间。
          events: { 7: "2026-08-29T00:00:00.000Z" },
        }),
        input: { repoId: "artifacts-gui" },
      },
      {},
    );
    assert.equal(result.artifacts[0]!.timeSource, "mtime");
    assert.equal(result.artifacts[0]!.time, "2026-08-02T00:00:00.000Z");
    assert.deepEqual(validateArtifactsList(result), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a walk past the scale bound warns that the timeline is incomplete instead of silently truncating", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-artifacts-truncated-"));
  const warning = console.warn,
    warnings: string[] = [];
  console.warn = (value: unknown) => warnings.push(String(value));
  try {
    // 阴性对照:上限内的小树不告警。
    taskFixture(root, "task_small-slug", { "artifacts/only.html": "<p>one</p>" });
    const small = readArtifactsGui(
      { rootDir: root, projection: projectionStub({}), input: { repoId: "artifacts-gui" } },
      {},
    );
    assert.equal(small.counts.html, 1);
    assert.equal(warnings.length, 0);
    // 20,001 个已分类文件击穿 20k 上限:截断必须可见,操作者得知道列表不全。
    const floodDirectory = path.join(root, "harness", "tasks", "task_flood-slug", "artifacts");
    mkdirSync(floodDirectory, { recursive: true });
    for (let index = 0; index < 20_001; index += 1)
      writeFileSync(path.join(floodDirectory, `flood-${String(index).padStart(5, "0")}.html`), "<p>flood</p>");
    const flooded = readArtifactsGui(
      { rootDir: root, projection: projectionStub({}), input: { repoId: "artifacts-gui" } },
      {},
    );
    assert.equal(flooded.counts.html, 20_000, "the walk stops counting at the classified-file bound");
    assert.ok(flooded.artifacts.length < 20_001, "the listing is capped by the walk bound");
    assert.match(warnings.join("\n"), /incomplete/u);
  } finally {
    console.warn = warning;
    rmSync(root, { recursive: true, force: true });
  }
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
        time: "2026-08-28T10:00:00.000Z",
        timeSource: "ledger",
      },
    ],
    page: { limit: 100, cursor: null, nextCursor: null },
    counts: { html: 1, md: 0, raw: 0 },
    watermark: 9,
    sourceRevision: 9,
  };
  assert.deepEqual(validateArtifactsList(base), []);
  assert.equal(serializeArtifactsList(base), `${JSON.stringify(base)}\n`);
  for (const mutate of [
    (value: ArtifactsListResult) => ({ ...value, kind: "pdf" }),
    (value: ArtifactsListResult) => ({ ...value, counts: { html: 1 } }),
    (value: ArtifactsListResult) => ({ ...value, counts: { html: 1, md: 0 } }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: "many" }),
    (value: ArtifactsListResult) => ({ ...value, apiKey: "secret" }),
    (value: ArtifactsListResult) => ({ ...value, nextCursor: null }),
    (value: ArtifactsListResult) => ({ ...value, page: undefined }),
    (value: ArtifactsListResult) => ({ ...value, page: { ...value.page, nextCursor: "" } }),
    (value: ArtifactsListResult) => ({ ...value, page: { ...value.page, cursor: 1 } }),
    (value: ArtifactsListResult) => ({ ...value, page: { ...value.page, limit: 501 } }),
  ])
    assert.notDeepEqual(validateArtifactsList(mutate(base)), []);
  const row = base.artifacts[0]!;
  for (const mutate of [
    (value: ArtifactsListResult) => ({
      ...value,
      artifacts: [{ ...row, path: "docs/outside.html" }],
    }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...row, time: "yesterday" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...row, timeSource: "filesystem" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...row, taskId: "" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...row, packagePath: "/etc" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...row, kind: "htm" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...row, mediaType: "" }] }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: [{ ...row, sizeBytes: -1 }] }),
    (value: ArtifactsListResult) => ({
      ...value,
      artifacts: [
        {
          taskId: row.taskId,
          taskTitle: row.taskTitle,
          packagePath: row.packagePath,
          path: row.path,
          kind: row.kind,
          time: row.time,
          timeSource: row.timeSource,
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

test("artifacts pages are bounded and resume across identical times and paths without losing packages", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-artifacts-pages-"));
  try {
    const mtime = new Date("2026-08-01T00:00:00.000Z");
    for (let index = 0; index < 103; index += 1)
      taskFixture(root, `task_${String(index).padStart(3, "0")}`, { "artifacts/same.html": "<p>same</p>" }, mtime);
    const tasks = Array.from({ length: 103 }, (_, index) => {
      const taskId = `task_${String(index).padStart(3, "0")}`;
      return { taskId, title: taskId, packagePath: `tasks/${taskId}` };
    });
    const context = { rootDir: root, projection: projectionStub({ tasks }), input: { repoId: "pages" } };
    const first = readArtifactsGui(context);
    assert.equal(first.artifacts.length, 100, "an omitted limit must still bound the response");
    assert.equal(first.page.limit, 100);
    assert.equal(first.page.cursor, null);
    assert.equal(typeof first.page.nextCursor, "string");
    const last = readArtifactsGui(context, { cursor: first.page.nextCursor });
    assert.equal(last.artifacts.length, 3);
    assert.equal(last.page.nextCursor, null);
    assert.deepEqual(last.counts, first.counts, "counts describe the whole facet, not this page");
    const seen = new Set<string>();
    const taskIds: (string | null)[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 103; pageIndex += 1) {
      const page = readArtifactsGui(context, { limit: 1, ...(cursor ? { cursor } : {}) });
      assert.equal(page.artifacts.length, 1);
      taskIds.push(page.artifacts[0]!.taskId);
      assert.deepEqual(validateArtifactsList(page), []);
      assert.equal(page.page.cursor, cursor ?? null);
      if (pageIndex === 102) assert.equal(page.page.nextCursor, null);
      else {
        assert.equal(typeof page.page.nextCursor, "string");
        assert.ok(!seen.has(page.page.nextCursor!));
        seen.add(page.page.nextCursor!);
        cursor = page.page.nextCursor!;
      }
    }
    assert.deepEqual(
      taskIds,
      tasks.map(({ taskId }) => taskId),
    );
    for (const cursor of ["garbage", Buffer.from('["only-one-key"]').toString("base64url")])
      assert.throws(() => readArtifactsGui(context, { cursor }), { code: "invalid_command" });
    const empty = readArtifactsGui(context, { kind: "md", limit: 1 });
    assert.deepEqual(empty.artifacts, []);
    assert.deepEqual(empty.page, { limit: 1, cursor: null, nextCursor: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("artifact cursors distinguish raw paths and packages that collate equally", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-artifacts-unicode-cursors-"));
  try {
    const time = new Date("2026-08-01T00:00:00.000Z");
    taskFixture(root, "task_same", { "artifacts/a.html": "plain", "artifacts/a\u200b.html": "zero width" }, time);
    const context = { rootDir: root, projection: projectionStub({}), input: { repoId: "unicode-paths" } };
    const all = readArtifactsGui(context);
    assert.equal(all.artifacts.length, 2);
    const first = readArtifactsGui(context, { limit: 1 });
    assert.equal(first.artifacts.length, 1);
    assert.notEqual(first.page.nextCursor, null);
    const last = readArtifactsGui(context, { limit: 1, cursor: first.page.nextCursor });
    assert.deepEqual([...first.artifacts, ...last.artifacts], all.artifacts);
    assert.deepEqual(
      all.artifacts.map(({ path }) => path),
      ["artifacts/a.html", "artifacts/a\u200b.html"],
    );
    assert.equal(last.page.nextCursor, null);

    // A package name is also part of the cursor, including when filenames match.
    taskFixture(root, "task_a", { "artifacts/same.md": "plain package" }, time);
    taskFixture(root, "task_a\u200b", { "artifacts/same.md": "zero width package" }, time);
    const packages = readArtifactsGui(context, { kind: "md" });
    const firstPackage = readArtifactsGui(context, { kind: "md", limit: 1 });
    assert.equal(packages.artifacts.length, 2);
    assert.notEqual(firstPackage.page.nextCursor, null);
    const lastPackage = readArtifactsGui(context, { kind: "md", limit: 1, cursor: firstPackage.page.nextCursor });
    assert.equal(lastPackage.artifacts.length, 1);
    assert.deepEqual([...firstPackage.artifacts, ...lastPackage.artifacts], packages.artifacts);
    assert.equal(lastPackage.page.nextCursor, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
