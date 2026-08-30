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
    readCanonicalEvents: (afterRevision) => ({
      events: Object.entries(input.events ?? {})
        .map(([revision, occurredAt]) => ({ workspaceRevision: Number(revision), occurredAt }))
        .filter(({ workspaceRevision }) => workspaceRevision > afterRevision)
        .sort((left, right) => left.workspaceRevision - right.workspaceRevision)
        .slice(0, 1),
    }),
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
    assert.deepEqual(result.counts, { html: 2, md: 1 });
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
        time: "2026-08-28T10:00:00.000Z",
        timeSource: "ledger",
      },
    ],
    counts: { html: 1, md: 0 },
    watermark: 9,
    sourceRevision: 9,
  };
  assert.deepEqual(validateArtifactsList(base), []);
  assert.equal(serializeArtifactsList(base), `${JSON.stringify(base)}\n`);
  for (const mutate of [
    (value: ArtifactsListResult) => ({ ...value, kind: "pdf" }),
    (value: ArtifactsListResult) => ({ ...value, counts: { html: 1 } }),
    (value: ArtifactsListResult) => ({ ...value, artifacts: "many" }),
    (value: ArtifactsListResult) => ({ ...value, apiKey: "secret" }),
    (value: ArtifactsListResult) => ({ ...value, nextCursor: null }),
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
        '{"ok":true,"status":"ready","repoId":"r","kind":"html","artifacts":[{"taskId":"t","taskTitle":"T","packagePath":"tasks/t","path":"artifacts/a.html","kind":"html","time":"yesterday","timeSource":"ledger"}],"counts":{"html":1,"md":0},"watermark":0,"sourceRevision":0}',
      ),
    ),
    [],
  );
});
