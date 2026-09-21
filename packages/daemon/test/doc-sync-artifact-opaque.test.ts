// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decideDocWrite,
  createImmutableLegacyGenerationSnapshot,
  convertLegacyGeneration,
  legacyGenerationSnapshotPath,
  docSyncWritePlan,
  makeTaskEventReader,
  makeTaskEventStore,
  parseDocWriteIntent,
  sha256Bytes,
  sqliteLedgerPath,
} from "@harness-anything/kernel";
import { preflightConvertedGenerationActivation } from "../../kernel/test/store/canonical-generation.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { truncateSync } from "node:fs";
import {
  documentPath,
  DOC_SYNC_INLINE_MAX_BYTES,
  RAW_ARTIFACT_MAX_BYTES,
  RAW_ARTIFACT_POLICY_ID,
} from "@harness-anything/kernel";

const PROSE_POLICY_ID = "markdown-body-replaceable/v1",
  OPAQUE_POLICY_ID = "opaque-textual-whole-file/v1";
const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const reviewerBinding = withRoleBinding(
  {
    actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "arbiter" } },
    source: "local" as const,
  },
  "arbiter",
);

test("artifact add treats every artifacts/ path as opaque while preserving media type and bytes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-opaque-"));
  initRepo(rootDir);
  const repoId = workspaceId("artifact-opaque"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-opaque" }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-opaque", title: "Opaque Artifacts" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const cases = [
      {
        source: "tool.mjs",
        destination: "scripts/tool.mjs",
        mediaType: "text/javascript",
        body: 'export const render = (rows) => rows.map((row) => `${row.id}: ${row.label} — UTF-8 报告\n`).join("");\n',
      },
      {
        source: "page.html",
        destination: "reports/page.html",
        mediaType: "text/html",
        body: '<!doctype html>\n<html lang="zh">\n<meta charset="utf-8">\n<title>Dossier — 报告</title>\n<p>byte-fidelity ✓</p>\n',
      },
      {
        source: "payload.json",
        destination: "data/payload.json",
        mediaType: "application/json",
        body: '{\n  "label": "报告 — dossier",\n  "rows": [{ "id": 1, "ok": true }]\n}\n',
      },
      {
        source: "style.css",
        destination: "artifacts/reports/assets/style.css",
        mediaType: "text/css",
        body: 'body { font-family: sans-serif; content: "报告 ✓"; }\n',
      },
      {
        source: "report.md",
        destination: "reports/report.md",
        mediaType: "text/markdown",
        body: "---\ntitle: Opaque report\n---\n\n# Same\n\n# Same\n\nByte-preserved frontmatter.\n",
      },
      { source: "notes.txt", destination: "reports/notes.txt", mediaType: "text/plain", body: "plain-text artifact\n" },
      {
        source: "bom.log",
        destination: "reports/bom.log",
        mediaType: "text/x-harness-opaque",
        body: "\uFEFF2026-09-09 UTF-8 report\r\n原始日志\r\n",
      },
      {
        source: "windows.md",
        destination: "reports/windows.md",
        mediaType: "text/markdown",
        body: "---\r\ntitle: CRLF report\r\n---\r\n\r\n# Windows\r\n",
      },
      {
        source: "script.ts",
        destination: "scripts/script.ts",
        mediaType: "text/x-harness-opaque",
        body: "export const typed: number = 1;\n",
      },
      {
        source: "view.tsx",
        destination: "scripts/view.tsx",
        mediaType: "text/x-harness-opaque",
        body: "export const View = () => <main>artifact</main>;\n",
      },
    ];
    const packagePath = "tasks/task-opaque-opaque-artifacts";
    for (const { source, destination, mediaType, body } of cases) {
      const bytes = Buffer.from(body, "utf8"),
        relative = destination.replace(/^artifacts\//u, "");
      writeFileSync(path.join(rootDir, source), bytes);
      const added = (await cell.run(
        { kind: "task-artifact-add", taskId: "task-opaque", source, destination },
        binding,
      )) as Record<string, unknown>;
      assert.equal(added.outcome, "applied", JSON.stringify(added));
      const logical = String(added.destination);
      assert.equal(logical, `${packagePath}/artifacts/${relative}`);
      const event = makeTaskEventReader({ repoId, rootDir }).readEvent(String(added.opId));
      assert.equal(event?.schema, "doc-event/v1", `${destination}: no doc event`);
      if (event?.schema !== "doc-event/v1") continue;
      const change = event.payload.changes[0]!;
      assert.equal(change.path, logical);
      assert.equal(change.policyId, OPAQUE_POLICY_ID, `${destination}: policy`);
      assert.equal(change.candidate.mediaType, mediaType, `${destination}: media type`);
      assert.equal(change.candidate.sha256, sha256Bytes(bytes));
      assert.equal(change.candidate.size, bytes.byteLength);
      assert.deepEqual(change.regionProofs, [], `${destination}: opaque whole-file policy must not emit region proofs`);
      await waitForFixturePublication(cell, String(added.opId), binding);
      const onDisk = readFileSync(path.join(rootDir, "harness", ...logical.split("/")));
      assert.equal(onDisk.equals(bytes), true, `${destination}: authored bytes must equal source bytes`);
      const shown = await cell.run({ kind: "doc-show", path: logical }, binding);
      assert.equal(shown.outcome, "applied", JSON.stringify(shown));
      assert.deepEqual(Buffer.from(shown.evidence, "utf8"), bytes, `${destination}: projected bytes`);
      const status = await cell.run({ kind: "doc-status", paths: [logical] }, binding);
      const row = rows(status.evidence).find((candidate) => candidate.path === logical);
      assert.deepEqual([row?.state, row?.mediaType], ["clean", mediaType], `${destination}: doc status`);
    }
    const reader = makeTaskEventReader({ repoId, rootDir }),
      beforeMaterialize = reader.readHead();
    rmSync(path.join(rootDir, "harness", "tasks"), { recursive: true, force: true });
    const materialized = await cell.run({ kind: "doc-materialize", paths: [], all: true }, binding);
    assert.equal(materialized.outcome, "applied", JSON.stringify(materialized));
    assert.equal(materialized.proof?.worktreeVisible, true);
    assert.equal(materialized.acceptance, null);
    assert.deepEqual(reader.readHead(), beforeMaterialize, "materialization must not admit a new command");
    for (const { destination, body } of cases) {
      const logical = `${packagePath}/artifacts/${destination.replace(/^artifacts\//u, "")}`;
      assert.equal(existsSync(path.join(rootDir, "harness", logical)), true, "explicit materialize restores deletion");
      assert.deepEqual(readFileSync(path.join(rootDir, "harness", logical)), Buffer.from(body));
      assert.deepEqual(
        reader.readContentBlob(sha256Bytes(Buffer.from(body))),
        Buffer.from(body),
        "accepted bytes remain canonical",
      );
    }
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("artifact add still rejects escapes, symlinked path segments, and undecodable textual names", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-guards-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("artifact-guards"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "artifact-guards",
    }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-guards", title: "Guards" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = "tasks/task-guards-guards",
      artifactsDir = path.join(rootDir, "harness", packagePath, "artifacts");
    writeFileSync(path.join(rootDir, "incoming.mjs"), "export const one = 1;\n");
    const escape = (await cell.run(
      { kind: "task-artifact-add", taskId: "task-guards", source: "incoming.mjs", destination: "../escape.md" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(escape.code, "invalid_artifact_path");
    writeFileSync(path.join(rootDir, "outside.mjs"), "export const two = 2;\n");
    mkdirSync(artifactsDir, { recursive: true });
    symlinkSync(path.join(rootDir), path.join(artifactsDir, "linked"));
    const viaSymlink = (await cell.run(
      { kind: "task-artifact-add", taskId: "task-guards", source: "outside.mjs", destination: "linked/escape.mjs" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(viaSymlink.code, "invalid_artifact_path");
    // A name that claims a textual format keeps its UTF-8 requirement: a broken report is an error,
    // not a binary. Names that never promised text take the raw route (doc-sync-artifact-raw-bytes).
    writeFileSync(path.join(rootDir, "broken.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    assert.equal(
      (
        (await cell.run(
          { kind: "task-artifact-add", taskId: "task-guards", source: "broken.md", destination: "reports/broken.md" },
          binding,
        )) as Record<string, unknown>
      ).code,
      "artifact_invalid_utf8",
    );
    writeFileSync(path.join(rootDir, "broken.json"), Buffer.from([0x7b, 0xff, 0x7d]));
    assert.equal(
      (
        (await cell.run(
          { kind: "task-artifact-add", taskId: "task-guards", source: "broken.json", destination: "data/broken.json" },
          binding,
        )) as Record<string, unknown>
      ).code,
      "artifact_invalid_utf8",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a historical prose artifact is rewritten as opaque without a policy upgrade", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-policy-reclassify-"));
  initRepo(rootDir);
  const repoId = workspaceId("artifact-policy-reclassify"),
    binding = { actor, source: "local" as const };
  let cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-policy-reclassify" });
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-reclassify", title: "Reclassify" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    await cell.close();
    const packagePath = "tasks/task-reclassify-reclassify",
      report = `${packagePath}/artifacts/report.md`,
      legacy = "# Legacy\n\n## Same\n\nfirst\n";
    const store = makeTaskEventStore({ repoId, rootDir }),
      bytes = Buffer.from(legacy),
      sha = sha256Bytes(bytes),
      base = store.currentCut();
    const historic = decideDocWrite({
      intent: parseDocWriteIntent(
        {
          schema: "doc-write-intent/v1",
          executionId: null,
          baseLedgerSha: base,
          changes: [
            {
              path: report,
              baseBlobSha256: null,
              policyId: PROSE_POLICY_ID,
              candidate: {
                ref: `doc-sync-claims/${sha}`,
                sha256: sha,
                size: bytes.byteLength,
                mediaType: "text/markdown",
              },
            },
          ],
        },
        repoId,
      ),
      opId: "op_historical_prose_artifact",
      eventId: "event-historical-prose-artifact",
      workspaceRevision: store.read().revision + 1,
      actor,
      source: "local",
      occurredAt: "2026-08-19T00:00:00.000Z",
      currentLedgerSha: base,
      lease: null,
      authorizationDecision: null,
      documents: [null],
      claims: [bytes],
    });
    assert.equal(historic.accepted, true, JSON.stringify(historic));
    if (!historic.accepted) return;
    store.append({ event: historic.event, plan: docSyncWritePlan(historic.event), blobs: historic.blobs });
    await store.drain();
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-policy-reclassify-next" });
    const rewritten = "---\ntitle: Rewritten report\n---\n\n# Same\n\n# Same\n\nopaque rewrite\n";
    write(rootDir, report, rewritten);
    const submitted = (await cell.run({ kind: "doc-submit", paths: [report] }, binding)) as Record<string, unknown>;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, String(submitted.opId), binding);
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(String(submitted.opId));
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema !== "doc-event/v1") return;
    const change = event.payload.changes[0]!;
    assert.equal(change.policyId, OPAQUE_POLICY_ID);
    assert.equal(change.candidate.mediaType, "text/markdown");
    assert.deepEqual(change.regionProofs, []);
    assert.equal("policyUpgrade" in change, false);
    assert.equal(
      readFileSync(path.join(rootDir, "harness", ...report.split("/"))).equals(Buffer.from(rewritten)),
      true,
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("authored architecture C4 files travel from dry-run through opaque submit", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-architecture-model-"));
  initRepo(rootDir);
  const repoId = workspaceId("architecture-model"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "architecture-model" }),
    binding = { actor, source: "local" as const },
    model = "context/architecture/model/views/write-path.c4",
    manifest = "context/architecture/architecture-manifest.json",
    modelBody = "views { view writePath { title 'Single Write Road' } }\n",
    manifestBody = '{"schema":"architecture-manifest/v1","enabled":true}\n';
  try {
    write(rootDir, model, modelBody);
    write(rootDir, manifest, manifestBody);
    const dry = await cell.run({ kind: "doc-dry-run", paths: [model, manifest] }, binding);
    assert.deepEqual(
      rows(String(dry.evidence)).map((row) => [row.path, row.state, row.mediaType]),
      [
        [manifest, "eligible", "application/json"],
        [model, "eligible", "text/x-harness-opaque"],
      ],
    );
    const submitted = (await cell.run({ kind: "doc-submit", paths: [model, manifest] }, binding)) as Record<
      string,
      unknown
    >;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, String(submitted.opId), binding);
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(String(submitted.opId));
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema !== "doc-event/v1") return;
    assert.deepEqual(
      event.payload.changes.map((change) => [change.path, change.policyId, change.regionProofs]),
      [
        [manifest, OPAQUE_POLICY_ID, []],
        [model, OPAQUE_POLICY_ID, []],
      ],
    );
    assert.equal(readFileSync(path.join(rootDir, "harness", model), "utf8"), modelBody);
    assert.equal(readFileSync(path.join(rootDir, "harness", manifest), "utf8"), manifestBody);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a historical opaque Markdown claim is restamped through the prose channel", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-opaque-prose-restamp-"));
  initRepo(rootDir);
  const sourceRoot = path.join(rootDir, "inactive-source");
  mkdirSync(sourceRoot);
  initRepo(sourceRoot);
  const repoId = workspaceId("opaque-prose-restamp"),
    binding = { actor, source: "local" as const },
    logical = "context/architecture/Architecture-SSoT.md",
    legacy = "# Architecture\n\nLegacy state.\n",
    store = makeTaskEventStore({ repoId, rootDir: sourceRoot }),
    bytes = Buffer.from(legacy),
    sha = sha256Bytes(bytes),
    base = store.currentCut(),
    historic = decideDocWrite({
      intent: parseDocWriteIntent(
        {
          schema: "doc-write-intent/v1",
          executionId: null,
          baseLedgerSha: base,
          changes: [
            {
              path: logical,
              baseBlobSha256: null,
              policyId: OPAQUE_POLICY_ID,
              candidate: {
                ref: `doc-sync-claims/${sha}`,
                sha256: sha,
                size: bytes.byteLength,
                mediaType: "text/markdown",
              },
            },
          ],
        },
        repoId,
      ),
      opId: "op_historical_opaque_prose",
      eventId: "event-historical-opaque-prose",
      workspaceRevision: store.read().revision + 1,
      actor,
      source: "local",
      occurredAt: "2026-08-28T00:00:00.000Z",
      currentLedgerSha: base,
      lease: null,
      authorizationDecision: null,
      documents: [null],
      claims: [bytes],
    });
  const emptyHead = git(sourceRoot, "rev-parse", "HEAD");
  store.materialize();
  assert.equal(git(sourceRoot, "rev-parse", "HEAD"), emptyHead);
  assert.equal(existsSync(path.join(sourceRoot, "harness/events/segments/manifest.json")), false);
  assert.equal(store.followerStatus().git.status, "pending");
  assert.equal(historic.accepted, true, JSON.stringify(historic));
  if (!historic.accepted) {
    rmSync(rootDir, { recursive: true, force: true });
    return;
  }
  store.append({ event: historic.event, plan: docSyncWritePlan(historic.event), blobs: historic.blobs });
  const snapshotPath = legacyGenerationSnapshotPath(rootDir);
  createImmutableLegacyGenerationSnapshot({ repoId, source: store, snapshotPath });
  await store.drain();
  const converted = convertLegacyGeneration({ rootDir, snapshotPath });
  assert.equal(converted.migratedEvents, 1);
  preflightConvertedGenerationActivation({
    repoId,
    rootDir,
    snapshotPath,
    databasePath: sqliteLedgerPath(rootDir, 1),
  });
  const cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "opaque-prose-restamp" });
  try {
    const firstBody = `${legacy}Current state.\n`;
    write(rootDir, logical, firstBody);
    const dry = await cell.run({ kind: "doc-dry-run", paths: [logical] }, binding);
    assert.deepEqual(
      rows(String(dry.evidence)).map((row) => [row.path, row.state]),
      [[logical, "eligible"]],
    );
    const first = (await cell.run({ kind: "doc-submit", paths: [logical] }, binding)) as Record<string, unknown>;
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    await waitForFixturePublication(cell, String(first.opId), binding);
    const upgraded = makeTaskEventReader({ repoId, rootDir }).readEvent(String(first.opId));
    assert.equal(upgraded?.schema, "doc-event/v1");
    if (upgraded?.schema === "doc-event/v1") {
      assert.equal(upgraded.payload.changes[0]?.policyId, PROSE_POLICY_ID);
      assert.deepEqual(upgraded.payload.changes[0]?.policyUpgrade, {
        from: OPAQUE_POLICY_ID,
        to: PROSE_POLICY_ID,
      });
    }

    write(rootDir, logical, `${firstBody}Second edit.\n`);
    const second = (await cell.run({ kind: "doc-submit", paths: [logical] }, binding)) as Record<string, unknown>;
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    const native = makeTaskEventReader({ repoId, rootDir }).readEvent(String(second.opId));
    assert.equal(native?.schema, "doc-event/v1");
    if (native?.schema === "doc-event/v1") assert.equal("policyUpgrade" in native.payload.changes[0]!, false);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task_plan.md and closeout.md retain prose policy, proofs, and deletion protection", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-prose-"));
  initRepo(rootDir);
  const repoId = workspaceId("task-prose"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "task-prose" }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-prose", title: "Prose" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = "tasks/task-prose-prose",
      prosePaths = [`${packagePath}/task_plan.md`, `${packagePath}/closeout.md`];
    for (const logical of prosePaths)
      write(
        rootDir,
        logical,
        `${readFileSync(path.join(rootDir, "harness", logical), "utf8")}\n## Extension\n\nCanonical prose update.\n`,
      );
    const submitted = (await cell.run({ kind: "doc-submit", paths: prosePaths }, binding)) as Record<string, unknown>;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, String(submitted.opId), binding);
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(String(submitted.opId));
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema !== "doc-event/v1") return;
    for (const change of event.payload.changes) {
      assert.equal(change.policyId, PROSE_POLICY_ID, change.path);
      assert.ok(change.regionProofs.length > 0, `${change.path}: prose must carry region proofs`);
    }
    for (const logical of prosePaths) {
      write(rootDir, logical, "# Removed\n");
      const replaced = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
      assert.equal(replaced.outcome, "applied", JSON.stringify(replaced));
      await waitForFixturePublication(cell, replaced.opId, binding);
      rmSync(path.join(rootDir, "harness", logical));
      const status = await cell.run({ kind: "doc-status", paths: [logical] }, binding),
        row = rows(status.evidence)[0];
      assert.equal(row?.path, logical);
      assert.equal(row?.state, "deletion");
      assert.match(String(row?.reason), /canonical document is missing/u);
    }
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("an identifier-free lifecycle publishes dirty artifacts and completes on the derived execution and Review cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-complete-"));
  initRepo(rootDir);
  const repoId = workspaceId("artifact-complete"),
    binding = { actor, source: "local" as const };
  let cell: Awaited<ReturnType<typeof openRepoCell>> | null = await openRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "artifact-complete",
  });
  const taskId = "task-complete";
  try {
    const created = await cell.run({ kind: "task-create", taskId, title: "Complete", presetId: "docs-task" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    assert.equal(
      (
        await cell.run(
          {
            kind: "fact-record",
            taskId,
            statement: "The opaque artifact was generated and reviewed.",
            evidenceSource: "test:artifact-complete",
            confidence: "high",
            memoryClass: "episodic",
            memoryTags: [],
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(path.join(rootDir, "gen.mjs"), "export const generated = true;\n");
    const added = (await cell.run(
      { kind: "task-artifact-add", taskId, source: "gen.mjs", destination: "scripts/gen.mjs" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(added.outcome, "applied", JSON.stringify(added));
    await waitForFixturePublication(cell, String(added.opId), binding);
    const packagePath = String(added.destination).split("/artifacts/")[0]!,
      manual = `${packagePath}/artifacts/reports/manual.html`;
    write(rootDir, manual, "<!doctype html>\n<title>Manual report</title>\n");
    await reachGreenInReview(cell, rootDir, taskId, packagePath);
    const completed = (await cell.run({ kind: "task-complete", taskId }, binding)) as Record<string, unknown>;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal(completed.commitSha, null);
    const store = makeTaskEventReader({ repoId, rootDir });
    assert.equal(
      store
        .read()
        .events.some(
          (event) => event.schema === "doc-event/v1" && event.payload.changes.some((change) => change.path === manual),
        ),
      true,
      "completion must publish the dirty opaque artifact",
    );
    assert.equal(
      store.read().events.some((event) => event.type === "task_completed"),
      true,
    );
    assert.equal(
      readFileSync(path.join(rootDir, "harness", manual), "utf8"),
      "<!doctype html>\n<title>Manual report</title>\n",
    );
    await cell.close();
    cell = null;
    assert.equal(
      git(rootDir, "show", `HEAD:harness/${manual}`),
      "<!doctype html>\n<title>Manual report</title>",
      "close must drain the pending cut into Git independently of the caller index",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function reachGreenInReview(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  rootDir: string,
  taskId: string,
  packagePath: string,
): Promise<void> {
  const binding = { actor, source: "local" as const };
  await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
  );
  assert.equal((await cell.run({ kind: "task-start", taskId }, binding)).outcome, "applied");
  const artifactPath = `${packagePath}/artifacts/verification.md`;
  mkdirSync(path.dirname(path.join(rootDir, "harness", artifactPath)), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", artifactPath), "Verified fixture delivery.\n");
  const artifactSync = await cell.run({ kind: "doc-submit", paths: [artifactPath] }, binding);
  assert.equal(artifactSync.outcome, "applied", JSON.stringify(artifactSync));
  await waitForFixturePublication(cell, artifactSync.opId, binding);
  writeFileSync(
    path.join(rootDir, "harness", `${packagePath}/closeout.md`),
    `# Closeout\n\n## Summary\n\nDelivered artifact:${artifactPath}@${artifactSync.revision}\n\n` +
      "## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n\n" +
      "## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n",
  );
  assert.equal(
    (await cell.run({ kind: "doc-submit", paths: [`${packagePath}/closeout.md`] }, binding)).outcome,
    "applied",
  );
  const submitted = await cell.run({ kind: "task-submit", taskId }, binding);
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  const forwarded = await cell.run(
    { kind: "task-adjudicate", taskId, forward: true, reason: "Forward opaque artifact cut." },
    binding,
  );
  assert.equal(forwarded.outcome, "applied", JSON.stringify(forwarded));
  writeFileSync(
    path.join(rootDir, "review.json"),
    JSON.stringify({ verdict: "approved", reason: "Approved.", evidenceChecked: ["verified"] }),
  );
  write(rootDir, `${packagePath}/artifacts/reports/opaque.md`, "# Review opaque\n\nPhysical review findings.\n");
  const reviewed = (await cell.run(
    { kind: "task-review-execution", taskId, reviewId: "review-opaque", fromFile: "review.json" },
    reviewerBinding,
  )) as unknown as Record<string, unknown>;
  assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
  const consented = await cell.run({ kind: "task-review-consent", taskId }, binding);
  assert.equal(consented.outcome, "applied", JSON.stringify(consented));
}

function rows(evidence: string): readonly {
  readonly path: string;
  readonly state: string;
  readonly reason: string | null;
  readonly mediaType: string | null;
}[] {
  assert.match(evidence, /^doc-scan:/u);
  return (
    JSON.parse(evidence.slice("doc-scan:".length)) as {
      rows: readonly { path: string; state: string; reason: string | null; mediaType: string | null }[];
    }
  ).rows;
}
function write(rootDir: string, target: string, body: string): void {
  const file = path.join(rootDir, "harness", target);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Doc Opaque Test");
  git(rootDir, "config", "user.email", "doc-opaque@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "-qm", "base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

const OPAQUE_TEXTUAL_POLICY_ID = "opaque-textual-whole-file/v1",
  OPAQUE_TEXTUAL_MEDIA_TYPE = "text/x-harness-opaque",
  RAW_ARTIFACT_MEDIA_TYPE = "application/octet-stream";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x0a]),
  pdf = Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from([0xff, 0xd8, 0x00, 0x1a, 0x80]),
    Buffer.from("\n%%EOF\n"),
  ]),
  log = Buffer.concat([Buffer.from("2026-09-09 dispatch "), Buffer.from([0x80]), Buffer.from(" 报告\n")]),
  empty = Buffer.alloc(0);

test("raw task artifacts publish their original bytes, filename, and owner through task-artifact-add", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-raw-"));
  initRawBytesRepo(rootDir);
  const repoId = workspaceId("artifact-raw"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-raw" }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-raw", title: "Raw Bytes" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = "tasks/task-raw-raw-bytes",
      reader = makeTaskEventReader({ repoId, rootDir }),
      // A zero-byte file decodes as UTF-8, so it is not raw. It is listed here to pin that boundary and to
      // prove the empty artifact still survives publication and restore with exactly zero bytes.
      cases = [
        { source: "logo.png", destination: "screenshots/logo.png", bytes: png, policyId: RAW_ARTIFACT_POLICY_ID },
        { source: "dossier.pdf", destination: "reports/dossier.pdf", bytes: pdf, policyId: RAW_ARTIFACT_POLICY_ID },
        { source: "dispatch.log", destination: "logs/dispatch.log", bytes: log, policyId: RAW_ARTIFACT_POLICY_ID },
        { source: "empty.bin", destination: "reports/empty.bin", bytes: empty, policyId: OPAQUE_TEXTUAL_POLICY_ID },
      ];
    for (const { source, destination, bytes, policyId } of cases) {
      const raw = policyId === RAW_ARTIFACT_POLICY_ID;
      writeFileSync(path.join(rootDir, source), bytes);
      const added = (await cell.run(
        { kind: "task-artifact-add", taskId: "task-raw", source, destination },
        binding,
      )) as Record<string, unknown>;
      assert.equal(added.outcome, "applied", `${destination}: ${JSON.stringify(added)}`);
      const logical = String(added.destination);
      assert.equal(logical, `${packagePath}/artifacts/${destination}`, "the artifact keeps its real filename");
      const event = reader.readEvent(String(added.opId));
      assert.equal(event?.schema, "doc-event/v1", `${destination}: no doc event`);
      if (event?.schema !== "doc-event/v1") continue;
      const change = event.payload.changes[0]!;
      assert.deepEqual(
        [change.path, change.policyId, change.candidate.mediaType, change.regionProofs],
        [logical, policyId, raw ? RAW_ARTIFACT_MEDIA_TYPE : OPAQUE_TEXTUAL_MEDIA_TYPE, []],
        `${destination}: claim shape`,
      );
      assert.deepEqual(
        [change.candidate.sha256, change.candidate.size],
        [sha256Bytes(bytes), bytes.byteLength],
        `${destination}: the claim addresses the original bytes`,
      );
      assert.deepEqual(event.actor, actor, `${destination}: the doc event carries the real owner`);
      assert.equal(event.source, "local", `${destination}: the doc event carries the real write source`);
      // Durability order: the content object is readable at the accepted cut that carries the claim.
      assert.deepEqual(
        Buffer.from(reader.readContentBlob(change.candidate.sha256)!),
        bytes,
        `${destination}: accepted bytes are durable and unmodified`,
      );
      await waitForFixturePublication(cell, String(added.opId), binding);
      assert.deepEqual(
        readFileSync(path.join(rootDir, "harness", ...logical.split("/"))),
        bytes,
        `${destination}: authored bytes equal source bytes`,
      );
      assert.deepEqual(
        gitBytes(rootDir, `harness/${logical}`),
        bytes,
        `${destination}: the ledger Git cut holds the same bytes`,
      );
      // Discovery names the route instead of printing an empty body or claiming the file is missing.
      const shown = (await cell.run({ kind: "doc-show", path: logical }, binding)) as Record<string, unknown>;
      if (raw) {
        assert.equal(shown.outcome, "op_rejected", `${destination}: ${JSON.stringify(shown)}`);
        assert.equal(shown.code, "document_not_text");
        assert.match(String(shown.evidence), /raw task artifact/u);
        assert.match(String(shown.evidence), new RegExp(change.candidate.sha256, "u"));
      } else {
        assert.equal(shown.outcome, "applied", `${destination}: ${JSON.stringify(shown)}`);
        assert.deepEqual(Buffer.from(String(shown.evidence), "utf8"), bytes);
      }
    }
    const beforeMaterialize = reader.readHead();
    rmSync(path.join(rootDir, "harness", "tasks"), { recursive: true, force: true });
    const materialized = await cell.run({ kind: "doc-materialize", paths: [], all: true }, binding);
    assert.equal(materialized.outcome, "applied", JSON.stringify(materialized));
    assert.deepEqual(reader.readHead(), beforeMaterialize, "restore must not admit a new command");
    for (const { destination, bytes } of cases)
      assert.deepEqual(
        readFileSync(path.join(rootDir, "harness", packagePath, "artifacts", ...destination.split("/"))),
        bytes,
        `${destination}: restore reproduces the original bytes`,
      );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("two executions producing the same raw report basename keep both artifacts and their own bytes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-raw-basename-"));
  initRawBytesRepo(rootDir);
  const repoId = workspaceId("artifact-raw-basename"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-raw-basename" }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-basename", title: "Basename" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = "tasks/task-basename-basename",
      reader = makeTaskEventReader({ repoId, rootDir }),
      first = Buffer.concat([Buffer.from([0xff, 0x01]), Buffer.from("execution one\n")]),
      second = Buffer.concat([Buffer.from([0xff, 0x02]), Buffer.from("execution two\n")]);
    writeFileSync(path.join(rootDir, "one.bin"), first);
    writeFileSync(path.join(rootDir, "two.bin"), second);
    const left = (await cell.run(
      { kind: "task-artifact-add", taskId: "task-basename", source: "one.bin", destination: "exec-a/result.bin" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(left.outcome, "applied", JSON.stringify(left));
    await waitForFixturePublication(cell, String(left.opId), binding);
    const right = (await cell.run(
      { kind: "task-artifact-add", taskId: "task-basename", source: "two.bin", destination: "exec-b/result.bin" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(right.outcome, "applied", JSON.stringify(right));
    await waitForFixturePublication(cell, String(right.opId), binding);
    assert.notEqual(String(left.destination), String(right.destination));
    assert.deepEqual(
      readFileSync(path.join(rootDir, "harness", packagePath, "artifacts", "exec-a", "result.bin")),
      first,
      "the first execution still owns its own bytes",
    );
    assert.deepEqual(
      readFileSync(path.join(rootDir, "harness", packagePath, "artifacts", "exec-b", "result.bin")),
      second,
      "the second execution owns different bytes under the same basename",
    );
    for (const [opId, bytes] of [
      [String(left.opId), first],
      [String(right.opId), second],
    ] as const) {
      const event = reader.readEvent(opId);
      assert.equal(event?.schema, "doc-event/v1");
      if (event?.schema !== "doc-event/v1") continue;
      assert.equal(event.payload.changes[0]!.candidate!.sha256, sha256Bytes(bytes), "each claim keeps its own digest");
    }
    // The same destination twice is a collision, not an overwrite: the first bytes survive untouched.
    const collided = (await cell.run(
      { kind: "task-artifact-add", taskId: "task-basename", source: "two.bin", destination: "exec-a/result.bin" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(collided.code, "artifact_collision", JSON.stringify(collided));
    assert.deepEqual(
      readFileSync(path.join(rootDir, "harness", packagePath, "artifacts", "exec-a", "result.bin")),
      first,
      "a rejected second write must not replace the accepted bytes",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a raw publication that fails leaves no accepted artifact and no raw claim outside a task subtree", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-raw-failure-"));
  initRawBytesRepo(rootDir);
  const repoId = workspaceId("artifact-raw-failure"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-raw-failure" }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-fail", title: "Fail" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = "tasks/task-fail-fail",
      reader = makeTaskEventReader({ repoId, rootDir }),
      before = reader.readHead(),
      oversized = path.join(rootDir, "huge.bin");
    writeFileSync(oversized, "");
    truncateSync(oversized, RAW_ARTIFACT_MAX_BYTES + 1);
    const rejected = (await cell.run(
      { kind: "task-artifact-add", taskId: "task-fail", source: "huge.bin", destination: "reports/huge.bin" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(rejected.code, "artifact_too_large", JSON.stringify(rejected));
    assert.notEqual(rejected.outcome, "applied");
    assert.equal(
      existsSync(path.join(rootDir, "harness", packagePath, "artifacts", "reports", "huge.bin")),
      false,
      "a refused required publication must not appear as a materialized artifact",
    );
    assert.deepEqual(reader.readHead(), before, "a refused publication must not advance the accepted cut");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
  const confinementRoot = mkdtempSync(path.join(tmpdir(), "ha-artifact-raw-confine-"));
  initRawBytesRepo(confinementRoot);
  try {
    const store = makeTaskEventStore({ repoId: workspaceId("artifact-raw-confine"), rootDir: confinementRoot }),
      bytes = png,
      sha = sha256Bytes(bytes),
      target = documentPath("context/architecture/logo.png"),
      decision = decideDocWrite({
        intent: parseDocWriteIntent(
          {
            schema: "doc-write-intent/v1",
            executionId: null,
            baseLedgerSha: store.currentCut(),
            changes: [
              {
                path: target,
                baseBlobSha256: null,
                policyId: RAW_ARTIFACT_POLICY_ID,
                candidate: {
                  ref: `doc-sync-claims/${sha}`,
                  sha256: sha,
                  size: bytes.byteLength,
                  mediaType: RAW_ARTIFACT_MEDIA_TYPE,
                },
              },
            ],
          },
          workspaceId("artifact-raw-confine"),
        ),
        opId: "confine",
        eventId: "confine",
        workspaceRevision: (store.readHead()?.revision ?? 0) + 1,
        actor,
        source: "local",
        occurredAt: new Date().toISOString(),
        currentLedgerSha: store.currentCut(),
        lease: null,
        authorizationDecision: null,
        documents: [null],
        claims: [bytes],
      });
    assert.equal(decision.accepted, false, "raw bytes outside a task artifacts subtree must not be accepted");
    if (decision.accepted) return;
    assert.equal(decision.code, "unresolved_touch");
    assert.equal(decision.detail.unresolvedTouches[0]?.requiredRoute, "task-artifact-add");
  } finally {
    rmSync(confinementRoot, { recursive: true, force: true });
  }
});

test("doc status offers a new small JSON task artifact to doc sync like any textual document", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-json-route-"));
  initRawBytesRepo(rootDir);
  const repoId = workspaceId("artifact-json-route"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-json-route" }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run({ kind: "task-create", taskId: "task-json", title: "JSON Artifact" }, binding)) as {
      readonly outcome: string;
      readonly packagePath: string;
    };
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const logical = `${created.packagePath}/artifacts/report.json`,
      target = path.join(rootDir, "harness", ...logical.split("/")),
      bytes = Buffer.from('{"schema":"report/v1","ok":true}\n');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    const status = (await cell.run({ kind: "doc-status", paths: [logical] }, binding)) as Record<string, unknown>,
      rows = JSON.parse(String(status.evidence).slice("doc-scan:".length)) as {
        readonly rows: readonly { readonly state: string; readonly reason: string | null }[];
      };
    assert.deepEqual([rows.rows[0]?.state, rows.rows[0]?.reason], ["eligible", null], JSON.stringify(rows));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc status uses the configured authored root and quotes artifact source paths", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-configured-root-"));
  initRawBytesRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: ledger\n  localRoot: .harness\n",
  );
  const repoId = workspaceId("artifact-configured-root"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-configured-root" }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run(
      { kind: "task-create", taskId: "task-configured", title: "Configured Root" },
      binding,
    )) as { readonly outcome: string; readonly packagePath: string };
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const logical = `${created.packagePath}/artifacts/report (final).pdf`,
      target = path.join(rootDir, "ledger", ...logical.split("/")),
      bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(DOC_SYNC_INLINE_MAX_BYTES + 1, 0xff)]);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    const status = (await cell.run({ kind: "doc-status", paths: [logical] }, binding)) as Record<string, unknown>;
    const rows = JSON.parse(String(status.evidence).slice("doc-scan:".length)) as {
      readonly rows: readonly {
        readonly state: string;
        readonly reason: string | null;
        readonly size: number | null;
        readonly candidateBlobSha256: string | null;
      }[];
    };
    assert.deepEqual(
      [rows.rows[0]?.state, rows.rows[0]?.size, rows.rows[0]?.candidateBlobSha256],
      ["inapplicable", bytes.byteLength, null],
      JSON.stringify(rows),
    );
    assert.match(
      rows.rows[0]?.reason ?? "",
      /'ledger\/tasks\/task-configured-configured-root\/artifacts\/report \(final\)\.pdf'/u,
    );
    assert.equal(
      (status.detail as { readonly nextAction?: string }).nextAction,
      "ha task artifact add task-configured --source 'ledger/tasks/task-configured-configured-root/artifacts/report (final).pdf' " +
        "--destination 'artifacts/report (final).pdf'",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc status routes oversized textual task artifacts through artifact add", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-oversized-text-"));
  initRepo(rootDir);
  const repoId = workspaceId("artifact-oversized-text"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-oversized-text" }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run(
        { kind: "task-create", taskId: "task-oversized-text", title: "Oversized Text" },
        binding,
      )) as { readonly outcome: string; readonly packagePath: string },
      logical = `${created.packagePath}/artifacts/report.txt`,
      source = `harness/${logical}`,
      target = path.join(rootDir, source),
      bytes = Buffer.from(`# Oversized\n${"x".repeat(DOC_SYNC_INLINE_MAX_BYTES)}`);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    const rejected = (await cell.run({ kind: "doc-submit", paths: [logical] }, binding)) as Record<string, unknown>;
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "doc_candidate_too_large");
    assert.equal(
      (rejected.detail as { readonly nextAction?: string }).nextAction,
      `ha task artifact add task-oversized-text --source ${source} --destination artifacts/report.txt`,
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc status nextAction round-trips when the authored root is its own nested Git repository", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-nested-ledger-"));
  initRawBytesRepo(rootDir);
  // Canonical layout: the authored root is an independent Git repository nested inside the
  // product repository. The prefix relative to the ledger Git top level is then empty, so the
  // artifact add source must be derived from the product root, not from the ledger prefix.
  const ledgerRoot = path.join(rootDir, "harness");
  mkdirSync(ledgerRoot, { recursive: true });
  git(ledgerRoot, "init", "-q");
  git(ledgerRoot, "config", "user.name", "Doc Raw Test");
  git(ledgerRoot, "config", "user.email", "doc-raw@example.invalid");
  git(ledgerRoot, "config", "gc.auto", "0");
  writeFileSync(path.join(ledgerRoot, ".gitkeep"), "");
  git(ledgerRoot, "add", ".gitkeep");
  git(ledgerRoot, "commit", "-qm", "ledger base");
  const repoId = workspaceId("artifact-nested-ledger"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-nested-ledger" }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run(
      { kind: "task-create", taskId: "task-nested", title: "Nested Ledger" },
      binding,
    )) as { readonly outcome: string; readonly packagePath: string };
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const logical = `${created.packagePath}/artifacts/report.pdf`,
      target = path.join(ledgerRoot, ...logical.split("/")),
      bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(DOC_SYNC_INLINE_MAX_BYTES + 1, 0xff)]);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    const status = (await cell.run({ kind: "doc-status", paths: [logical] }, binding)) as Record<string, unknown>,
      nextAction = String((status.detail as { readonly nextAction?: string }).nextAction),
      routed = /^ha task artifact add (\S+) --source ('[^']*'|\S+) --destination ('[^']*'|\S+)$/u.exec(nextAction),
      unquote = (token: string): string => token.replace(/^'(.*)'$/u, "$1");
    assert.ok(routed, nextAction);
    assert.equal(unquote(routed[2]!), `harness/${logical}`, nextAction);
    assert.equal(unquote(routed[3]!), "artifacts/report.pdf", nextAction);
    const added = (await cell.run(
      {
        kind: "task-artifact-add",
        taskId: routed[1]!,
        source: unquote(routed[2]!),
        destination: unquote(routed[3]!),
      },
      binding,
    )) as Record<string, unknown>;
    assert.equal(added.outcome, "applied", JSON.stringify(added));
    assert.equal(added.source, `harness/${logical}`);
    assert.deepEqual(readFileSync(target), bytes, "same-path takeover preserves the original bytes");
    await waitForFixturePublication(cell, String(added.opId), binding);
    assert.deepEqual(gitBytes(ledgerRoot, logical), bytes, "the nested ledger Git cut holds the same bytes");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function gitBytes(rootDir: string, target: string): Buffer {
  return execFileSync("git", ["-C", rootDir, "show", `HEAD:${target}`], { maxBuffer: 64 * 1024 * 1024 });
}
function initRawBytesRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Doc Raw Test");
  git(rootDir, "config", "user.email", "doc-raw@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "-qm", "base");
}
