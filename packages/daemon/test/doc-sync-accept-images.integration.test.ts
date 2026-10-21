// harness-test-tier: integration
// A screenshot dropped into a task package is task output, not a second kind of document. doc sync
// is the one entry that publishes task-package bytes, so it must publish these itself instead of
// routing the operator to `ha task artifact add` for one more trip.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decideDocWrite,
  docSyncWritePlan,
  makeTaskEventReader,
  makeTaskEventStore,
  OPAQUE_TEXTUAL_POLICY_ID,
  parseDocWriteIntent,
  RAW_ARTIFACT_MEDIA_TYPE,
  RAW_ARTIFACT_POLICY_ID,
  sha256Bytes,
} from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
const OPAQUE_MEDIA_TYPE = "text/x-harness-opaque";

function initRepo(rootDir: string): void {
  const git = (cmd: string, ...args: string[]) =>
    execFileSync("git", [cmd, ...args], { cwd: rootDir, stdio: "ignore", windowsHide: true });
  git("init", "-q");
  git("config", "user.name", "Image Test");
  git("config", "user.email", "image-test@example.invalid");
  git("config", "gc.auto", "0");
  writeFileSync(path.join(rootDir, ".gitkeep"), "");
  git("add", ".gitkeep");
  git("commit", "-qm", "initial");
}

// Real format magic followed by bytes no UTF-8 decoder accepts: the exact shape of a screenshot.
const images = [
  {
    destination: "screenshots/diagram.png",
    bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0xab)]),
  },
  {
    destination: "photos/sample.jpg",
    bytes: Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
      Buffer.alloc(32, 0xcd),
    ]),
  },
  {
    destination: "assets/sample.webp",
    bytes: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0x00), Buffer.from("WEBPVP8 "), Buffer.alloc(32, 0xef)]),
  },
  { destination: "icons/sample.gif", bytes: Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32, 0x12)]) },
];

test("doc sync publishes PNG, JPG, WebP and GIF task artifacts byte-exactly and reads them back", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-image-sync-"));
  initRepo(rootDir);
  const repoId = workspaceId("image-sync"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "image-sync" });
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-images", title: "Image Sync" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = "tasks/task-images-image-sync",
      logicalPaths = images.map(({ destination }) => `${packagePath}/artifacts/${destination}`),
      targets = new Map(
        images.map(({ destination }) => [
          destination,
          path.join(rootDir, "harness", packagePath, "artifacts", destination),
        ]),
      );
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId: "task-images" }, binding)).outcome, "applied");
    for (const { destination, bytes } of images) {
      const target = targets.get(destination)!;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }

    // The defect this test exists for: a PNG sat inapplicable with a `ha task artifact add` reason.
    const status = (await cell.run({ kind: "doc-status", paths: logicalPaths }, binding)) as { evidence: string },
      scanned = JSON.parse(status.evidence.slice("doc-scan:".length)) as {
        readonly rows: readonly { readonly path: string; readonly state: string; readonly reason: string | null }[];
      };
    for (const logical of logicalPaths) {
      const row = scanned.rows.find((candidate) => candidate.path === logical);
      assert.deepEqual([row?.state, row?.reason ?? null], ["eligible", null], `${logical}: ${status.evidence}`);
    }

    const submitted = (await cell.run({ kind: "doc-submit", paths: logicalPaths }, binding)) as {
      readonly outcome: string;
      readonly opId: string;
    };
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, submitted.opId, binding);

    const reader = makeTaskEventReader({ repoId, rootDir }),
      event = reader.readEvent(submitted.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema !== "doc-event/v1") return;
    assert.equal(event.payload.changes.length, images.length);
    for (const { destination, bytes } of images) {
      const logical = `${packagePath}/artifacts/${destination}`,
        change = event.payload.changes.find((candidate) => candidate.path === logical);
      assert.ok(change, `the event must carry ${logical}`);
      assert.deepEqual(
        [change.policyId, change.candidate.mediaType, change.candidate.sha256, change.candidate.size],
        [RAW_ARTIFACT_POLICY_ID, RAW_ARTIFACT_MEDIA_TYPE, sha256Bytes(bytes), bytes.byteLength],
        `${destination}: raw claim identity`,
      );
      // One byte sequence end to end: the content object and the Git cut hold what the worktree had.
      assert.deepEqual(Buffer.from(reader.readContentBlob(change.candidate.sha256) ?? []), bytes, destination);
      assert.deepEqual(execFileSync("git", ["-C", rootDir, "show", `HEAD:harness/${logical}`]), bytes, destination);
    }

    // Materialize is the read-back a fresh checkout gets: identical bytes, no re-encode.
    for (const target of targets.values()) rmSync(target);
    assert.equal((await cell.run({ kind: "doc-materialize", paths: [], all: true }, binding)).outcome, "applied");
    for (const { destination, bytes } of images)
      assert.deepEqual(readFileSync(targets.get(destination)!), bytes, `${destination}: materialized bytes`);

    const settled = (await cell.run({ kind: "doc-status", paths: logicalPaths }, binding)) as { evidence: string },
      after = JSON.parse(settled.evidence.slice("doc-scan:".length)) as {
        readonly rows: readonly { readonly path: string; readonly state: string }[];
      };
    for (const logical of logicalPaths)
      assert.equal(
        after.rows.find((candidate) => candidate.path === logical)?.state,
        "clean",
        `${logical}: ${settled.evidence}`,
      );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// Before the artifacts subtree judged bytes, a `.pdf` whose bytes happened to decode was persisted
// as an opaque text claim. That row is not a new artifact at a binary name — it is an existing
// document, and one entry must be able to keep publishing it.
test("an artifact persisted under the opaque policy at a binary name stays doc-sync writable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-legacy-opaque-artifact-"));
  initRepo(rootDir);
  const repoId = workspaceId("legacy-opaque-artifact");
  let cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "legacy-opaque" });
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-legacy", title: "Legacy Opaque" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    await cell.close();
    const packagePath = "tasks/task-legacy-legacy-opaque",
      logical = `${packagePath}/artifacts/ceo-preview/test.pdf`,
      // The old shape: a PDF name holding bytes a UTF-8 decoder accepts, so the artifacts subtree
      // stamped it with the opaque whole-file policy instead of the raw byte policy.
      legacy = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
      store = makeTaskEventStore({ repoId, rootDir }),
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
                policyId: OPAQUE_TEXTUAL_POLICY_ID,
                candidate: {
                  ref: `doc-sync-claims/${sha}`,
                  sha256: sha,
                  size: bytes.byteLength,
                  mediaType: OPAQUE_MEDIA_TYPE,
                },
              },
            ],
          },
          repoId,
        ),
        opId: "op_legacy_opaque_binary_name",
        eventId: "event-legacy-opaque-binary-name",
        workspaceRevision: store.read().revision + 1,
        actor,
        source: "local",
        occurredAt: "2026-08-30T00:00:00.000Z",
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
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "legacy-opaque-next" });
    const target = path.join(rootDir, "harness", ...logical.split("/")),
      edited = `${legacy}% reviewed\n`;
    writeFileSync(target, edited);
    const status = (await cell.run({ kind: "doc-status", paths: [logical] }, binding)) as { evidence: string },
      row = JSON.parse(status.evidence.slice("doc-scan:".length)).rows[0] as
        | { readonly state: string; readonly reason: string | null }
        | undefined;
    // The defect: an ordinary text edit of this persisted row reported a bare block with no route.
    assert.deepEqual([row?.state, row?.reason ?? null], ["eligible", null], status.evidence);
    const submitted = (await cell.run({ kind: "doc-submit", paths: [logical] }, binding)) as Record<string, unknown>;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, String(submitted.opId), binding);
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(String(submitted.opId));
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema !== "doc-event/v1") return;
    const change = event.payload.changes[0]!;
    // The row keeps the policy it was written under; the write is the same one entry, no re-stamp.
    assert.deepEqual(
      [change.policyId, change.candidate.mediaType, change.candidate.sha256],
      [OPAQUE_TEXTUAL_POLICY_ID, OPAQUE_MEDIA_TYPE, sha256Bytes(Buffer.from(edited))],
    );
    assert.equal("policyUpgrade" in change, false);
    assert.deepEqual(readFileSync(target), Buffer.from(edited));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task artifact add refuses a source that already sits inside a task package", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-add-narrow-"));
  initRepo(rootDir);
  const repoId = workspaceId("artifact-add-narrow"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "artifact-add-narrow" });
  try {
    const created = await cell.run(
      { kind: "task-create", taskId: "task-narrow", title: "Narrow Artifact Add" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = "tasks/task-narrow-narrow-artifact-add",
      target = path.join(rootDir, "harness", packagePath, "artifacts", "sample.png");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    const rejected = (await cell.run(
      {
        kind: "task-artifact-add",
        taskId: "task-narrow",
        source: `harness/${packagePath}/artifacts/sample.png`,
        destination: "sample.png",
      },
      binding,
    )) as { readonly code: string; readonly rejectionExplanation: string };
    // The package file has one entry; this command must name that entry, not accept the same bytes twice.
    assert.equal(rejected.code, "artifact_source_in_task_package");
    assert.match(rejected.rejectionExplanation, /ha doc sync --submit --path/u);
    assert.equal(existsSync(target), true, "the refused add must not consume the worktree file");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
