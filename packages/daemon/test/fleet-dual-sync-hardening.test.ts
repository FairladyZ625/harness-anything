// harness-test-tier: fast
import { commitEdgeManifest, withEdgeManifest } from "../src/fleet/replica-read-model.ts";
import { fleetManifestDigest } from "../src/fleet/contract.ts";
// W3-C adversarial hardening regressions (terra round): each test lands one
// finding from tmp/orch/w3c-adversarial as a permanent failure path — the
// fleet doc-submit channel cannot bypass the class-A holder entry (F1), a
// carried-docs bundle never leaves a transitioned task without its documents
// across the append crash window (F2), staged conflicts keep their base bytes
// past replica retention (F3), an unresolved conflict is a persistent gate
// instead of self-healing (F4), center-deleted × locally-modified paths stage
// (F7), the mirror gate fences on cut identity not just revision (F8), mirror
// rounds serialize (F9), and task-package containment covers plain task ids
// without any id-shape heuristic (F10/F11).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { DOC_SYNC_INLINE_MAX_BYTES, makeTaskEventReader } from "@harness-anything/kernel";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import {
  applyFleetMirrorCut,
  cacheFleetMirrorDirtyBases,
  readFleetConflictRecord,
  readFleetUnresolvedConflicts,
  scanFleetMirrorWorktree,
  stageFleetConflict,
  withFleetMirrorLock,
} from "../src/fleet-edge-mirror.ts";
import { fleetDocPathInTaskPackage } from "../src/fleet-edge-task.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

const actor = { principal: { personId: "hardening-owner" }, executor: { kind: "agent", id: "hardening" } } as const;
const nodeSource = {
  kind: "node",
  nodeId: "node-hardening",
} as const;
const policyId = "markdown-body-replaceable/v1";
// A node grants nothing by itself: each assignment-sourced binding carries its person's own authority.
const ownerCredential = (who: { readonly principal: { readonly personId: string }; readonly executor: unknown }) =>
  withPolicyGroup({ actor: who as typeof actor }, "admin").keycloakAuthorization;

function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function initRepo(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Hardening");
  git(root, "config", "user.email", "hardening@example.invalid");
  writeFileSync(
    path.join(root, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nname: hardening\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git(root, "add", "harness");
  git(root, "commit", "--quiet", "-m", "base");
}
const sha = (body: string | Buffer): string => createHash("sha256").update(body).digest("hex");
const writeJson = (file: string, value: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`);
};
const writeBytes = (file: string, body: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};
const docClaim = (root: string, ref: string, body: string) => {
  writeBytes(path.join(root, ".harness", "doc-sync-claims", ref), body);
  return {
    ref: `doc-sync-claims/${ref}`,
    sha256: sha(body),
    size: Buffer.byteLength(body),
    mediaType: "text/markdown" as const,
  };
};
const ledgerCut = (value: unknown): { repoId: string; revision: number; headDigest: string } => {
  const cut = value as { repoId: string; revision: number; headDigest: string };
  return { repoId: cut.repoId, revision: cut.revision, headDigest: cut.headDigest };
};
const mirrorCut = (value: unknown): { revision: number; headDigest: string } => {
  const cut = ledgerCut(value);
  return { revision: cut.revision, headDigest: cut.headDigest };
};

test("fleet conflict lookup accepts a staged record and rejects unsafe or absent ids", (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), "ha-fleet-conflict-lookup-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const conflictId = "conflict-safe";
  stageFleetConflict(workspace, {
    record: {
      schema: "fleet-conflict/v1",
      conflictId,
      repoId: "repo-one",
      viewId: "view-one",
      trigger: "pull",
      kind: "shared-docs",
      taskId: null,
      executionId: null,
      fromRevision: 1,
      toRevision: 2,
      code: "pull_blocked",
      paths: [
        {
          path: "context/shared.md",
          baseBlobSha256: sha("base"),
          localBlobSha256: sha("local"),
          centerBlobSha256: sha("center"),
        },
      ],
    },
    files: [
      {
        path: "context/shared.md",
        base: Buffer.from("base"),
        local: Buffer.from("local"),
        center: Buffer.from("center"),
      },
    ],
  });

  assert.equal(readFleetConflictRecord(workspace, conflictId).conflictId, conflictId);
  assert.throws(
    () => readFleetConflictRecord(workspace, "../outside"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "conflict_id_invalid",
  );
  assert.throws(
    () => readFleetConflictRecord(workspace, "conflict-missing"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "conflict_not_found",
  );
});

test("fleet mirror candidate scan names oversized prose without reading it into a change", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "w3c-h-large-doc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initRepo(root);
  const logical = "context/oversized.md",
    body = `# Oversized\n${"x".repeat(DOC_SYNC_INLINE_MAX_BYTES)}`,
    size = Buffer.byteLength(body);
  writeBytes(path.join(root, "harness", logical), body);
  const scan = scanFleetMirrorWorktree(
    {
      repoId: "large-doc",
      viewId: "view-one",
      viewDir: path.join(root, "view"),
      revision: 1,
      headDigest: "head",
      manifestDigest: "manifest",
      entries: new Map(),
    },
    root,
  );
  assert.deepEqual(scan.changes, []);
  assert.deepEqual(scan.blocked, [
    {
      path: logical,
      size,
      maxInlineBytes: DOC_SYNC_INLINE_MAX_BYTES,
      code: "doc_candidate_too_large",
      requiredRoute: "blob-content",
      reason:
        `${logical} is ${size} bytes; doc sync accepts at most ${DOC_SYNC_INLINE_MAX_BYTES} bytes; ` +
        "send raw content through the blob content contract",
    },
  ]);
});

test("F1: the fleet doc-submit channel cannot write task documents without the held execution", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "w3c-h-f1-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initRepo(root);
  const cell = await openRepoCell({ repoId: workspaceId("w3c-h-f1"), rootDir: canonicalRoot(root), ownerId: "f1" });
  try {
    const localOwner = withPolicyGroup({ actor, source: "local" as const }, "admin"),
      heldAssignment = {
        actor,
        source: nodeSource,
        keycloakAuthorization: ownerCredential(actor),
      };
    const created = await cell.run({ kind: "task-create", taskId: "task-direct", title: "Direct" }, localOwner);
    await cell.settlePendingMaterialization("inspect created task package");
    const packagePath = String((created as Record<string, unknown>).packagePath),
      logical = `${packagePath}/task_plan.md`;
    const target = path.join(root, "harness", logical);
    writeFileSync(target, realizedTaskPlan("Direct"));
    const planned = await cell.run({ kind: "doc-submit", paths: [logical] }, localOwner);
    assert.equal(planned.outcome, "applied", JSON.stringify(planned));
    await cell.settlePendingMaterialization("inspect submitted task plan");
    const original = readFileSync(target, "utf8"),
      body = `${original}\n## Unheld push\n`;
    const beforeReader = makeTaskEventReader({ repoId: "w3c-h-f1", rootDir: root }),
      before = beforeReader.read().revision;
    await beforeReader.drain();
    const bypass = await cell.run(
      {
        kind: "doc-submit",
        executionId: null,
        baseLedgerSha: ledgerCut(planned.cut),
        changes: [
          { path: logical, baseBlobSha256: sha(original), policyId, candidate: docClaim(root, "f1-unheld", body) },
        ],
      },
      {
        actor,
        source: nodeSource,
        keycloakAuthorization: ownerCredential(actor),
      },
    );
    assert.equal(bypass.outcome, "op_rejected");
    assert.equal(bypass.code, "task_docs_require_task_command");
    const afterReader = makeTaskEventReader({ repoId: "w3c-h-f1", rootDir: root });
    assert.equal(afterReader.read().revision, before, "the ledger must not move for a channel-less task-document push");
    await afterReader.drain();
    const ghostPath = "tasks/ghost-package/task_plan.md";
    const ghost = await cell.run(
      {
        kind: "doc-submit",
        executionId: null,
        baseLedgerSha: ledgerCut(planned.cut),
        changes: [
          { path: ghostPath, baseBlobSha256: null, policyId, candidate: docClaim(root, "f1-ghost", "# Ghost\n") },
        ],
      },
      {
        actor,
        source: nodeSource,
        keycloakAuthorization: ownerCredential(actor),
      },
    );
    assert.equal(ghost.outcome, "op_rejected");
    assert.equal(
      ghost.code,
      "task_docs_require_task_command",
      "an unprojected task package must not become a shared-surface bypass",
    );
    // The holder naming its held execution keeps decideDocWrite's holder check
    // as its authority: the same actor holding the lease may push explicitly.
    const started = await cell.run(
      { kind: "task-start", taskId: "task-direct", executionId: "exe-f1" },
      heldAssignment,
    );
    assert.equal(started.outcome, "applied");
    const held = await cell.run(
      {
        kind: "doc-submit",
        executionId: "exe-f1",
        baseLedgerSha: ledgerCut(started.cut),
        changes: [
          { path: logical, baseBlobSha256: sha(original), policyId, candidate: docClaim(root, "f1-held", body) },
        ],
      },
      heldAssignment,
    );
    assert.equal(held.outcome, "applied", JSON.stringify(held).slice(0, 300));
    await cell.settlePendingMaterialization("inspect held task document update");
    // A different principal naming the held execution is still refused.
    const other = { principal: { personId: "someone-else" }, executor: null } as const;
    const forged = await cell.run(
      {
        kind: "doc-submit",
        executionId: "exe-f1",
        baseLedgerSha: ledgerCut(held.cut),
        changes: [
          {
            path: logical,
            baseBlobSha256: sha(readFileSync(target, "utf8")),
            policyId,
            candidate: docClaim(root, "f1-forged", `${readFileSync(target, "utf8")}\n## Forged\n`),
          },
        ],
      },
      {
        actor: other,
        source: nodeSource,
        keycloakAuthorization: ownerCredential(other),
      },
    );
    assert.equal(forged.outcome, "op_rejected");
    assert.equal(forged.code, "execution_scope_mismatch");
  } finally {
    await cell.close();
  }
});

test("F2: a crash after the atomic bundle commit replays both the transition and carried document", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "w3c-h-f2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initRepo(root);
  let armed = false;
  const killpoint = (point: string): void => {
    if (armed && point === "after_sqlite_commit") throw new Error("injected-crash");
  };
  let cell = await openRepoCell({
    repoId: workspaceId("w3c-h-f2"),
    rootDir: canonicalRoot(root),
    ownerId: "f2-one",
    killpoint,
  });
  const binding = {
    actor,
    source: nodeSource,
    keycloakAuthorization: ownerCredential(actor),
  };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-crash", title: "Crash" }, binding);
    await cell.settlePendingMaterialization("inspect crash test task package");
    const packagePath = String((created as Record<string, unknown>).packagePath),
      logical = `${packagePath}/task_plan.md`,
      target = path.join(root, "harness", logical),
      original = readFileSync(target, "utf8"),
      body = `${realizedTaskPlan("Crash")}\n## Carried\n\nCarry the realized plan with the start transition.\n`;
    const base = mirrorCut(created.cut);
    armed = true;
    const failed = await cell.run(
      {
        kind: "task-start",
        taskId: "task-crash",
        executionId: "exe-crash",
        mirrorBaseCut: base,
        docChanges: [
          { path: logical, baseBlobSha256: sha(original), policyId, candidate: docClaim(root, "f2-carried", body) },
        ],
      },
      binding,
    );
    assert.equal(failed.outcome, "pending", JSON.stringify(failed));
    assert.equal(failed.status, "accepted_durable");
    assert.ok(failed.acceptance, "the committed command must retain its acceptance interval");
    await cell.close();
    cell = await openRepoCell({ repoId: workspaceId("w3c-h-f2"), rootDir: canonicalRoot(root), ownerId: "f2-two" });
    const shown = await cell.run(
      { kind: "task-show", taskId: "task-crash" },
      withPolicyGroup({ actor, source: "local" }, "admin"),
    );
    const evidence = JSON.parse(String(shown.evidence)) as { task?: { status?: string }; lease?: unknown };
    const doc = await cell.run(
      { kind: "doc-show", path: logical },
      withPolicyGroup({ actor, source: "local" }, "admin"),
    );
    assert.equal(
      evidence.task?.status,
      "active",
      "the committed bundle must replay the transition together with its document",
    );
    assert.notEqual(evidence.lease, null);
    assert.match(String(doc.evidence), /Carried/u, "the carried document must replay from the same canonical event");
  } finally {
    await cell.close();
  }
});

test("F8: the mirror gate fences on cut identity — same revision with a different head digest is refused", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "w3c-h-f8-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initRepo(root);
  const cell = await openRepoCell({ repoId: workspaceId("w3c-h-f8"), rootDir: canonicalRoot(root), ownerId: "f8" });
  const binding = {
    actor,
    source: nodeSource,
    keycloakAuthorization: ownerCredential(actor),
  };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-fence", title: "Fence" }, binding);
    await cell.settlePendingMaterialization("inspect fence test task package");
    const packagePath = String((created as Record<string, unknown>).packagePath),
      logical = `${packagePath}/task_plan.md`,
      target = path.join(root, "harness", logical),
      original = readFileSync(target, "utf8");
    const base = mirrorCut(created.cut);
    const rolled = await cell.run(
      {
        kind: "task-start",
        taskId: "task-fence",
        executionId: "exe-fence",
        mirrorBaseCut: { revision: base.revision, headDigest: `sha256:${"0".repeat(64)}` },
        docChanges: [
          {
            path: logical,
            baseBlobSha256: sha(original),
            policyId,
            candidate: docClaim(
              root,
              "f8-rolled",
              `${realizedTaskPlan("Fence")}\n## Rolled back view\n\nReject the stale mirror cut.\n`,
            ),
          },
        ],
      },
      binding,
    );
    assert.equal(rolled.outcome, "op_rejected");
    assert.equal(rolled.code, "mirror_behind_center");
    const unrelated = await cell.run(
      { kind: "task-create", taskId: "task-unrelated-fence", title: "Unrelated" },
      withPolicyGroup({ actor, source: "local" }, "admin"),
    );
    assert.equal(unrelated.outcome, "applied");
    for (const invalidBase of [
      { ...base, headDigest: `sha256:${"0".repeat(64)}` },
      { ...base, revision: Number(unrelated.revision) + 100 },
    ]) {
      const refused = await cell.run(
        {
          kind: "task-start",
          taskId: "task-fence",
          executionId: "exe-fence",
          mirrorBaseCut: invalidBase,
          docChanges: [
            {
              path: logical,
              baseBlobSha256: sha(original),
              policyId,
              candidate: docClaim(root, `f8-invalid-${invalidBase.revision}`, realizedTaskPlan("Fence")),
            },
          ],
        },
        binding,
      );
      assert.equal(refused.code, "mirror_behind_center", "altered history and rolled-back center remain rejected");
    }
    const exact = await cell.run(
      {
        kind: "task-start",
        taskId: "task-fence",
        executionId: "exe-fence",
        mirrorBaseCut: base,
        docChanges: [
          {
            path: logical,
            baseBlobSha256: sha(original),
            policyId,
            candidate: docClaim(
              root,
              "f8-exact",
              `${realizedTaskPlan("Fence")}\n## Exact cut\n\nApply the matching mirror cut.\n`,
            ),
          },
        ],
      },
      binding,
    );
    assert.equal(exact.outcome, "applied", JSON.stringify(exact));
  } finally {
    await cell.close();
  }
});

function mirrorCutFixture(
  name: string,
  cuts: readonly { revision: number; entries: readonly { path: string; body: string }[] }[],
  current: number,
): { root: string; viewRoot: string; workspace: string; worktree: string } {
  const root = mkdtempSync(path.join(tmpdir(), `w3c-h-${name}-`)),
    repoId = "repo",
    viewDir = path.join(root, "view", "repos", repoId, "views", "edge-view"),
    workspace = path.join(root, "workspace"),
    worktree = path.join(workspace, "harness");
  mkdirSync(path.join(workspace, "harness"), { recursive: true });
  writeFileSync(
    path.join(workspace, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nname: mirror\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  for (const cut of cuts) {
    const entries = cut.entries.map((entry) => ({
      path: entry.path,
      blob: { sha256: sha(entry.body), size: Buffer.byteLength(entry.body), mediaType: "text/markdown" },
    }));
    const header = {
      cut: { revision: cut.revision, headDigest: `sha256:${sha(`head-${cut.revision}`)}`, schemaGeneration: 0 },
      schemaGeneration: 0,
      manifestDigest: fleetManifestDigest(entries),
    };
    commitEdgeManifest(
      viewDir,
      header,
      null,
      entries.map((entry) => ({ op: "put", ...entry })),
    );
    writeJson(path.join(viewDir, "cuts", `${cut.revision}-g0`, "manifest.json"), header);
    for (const entry of cut.entries) {
      writeBytes(path.join(viewDir, "../../cas/sha256", sha(entry.body).slice(0, 2), sha(entry.body)), entry.body);
    }
  }
  writeJson(path.join(viewDir, "current.json"), {
    schemaGeneration: 0,
    cut: { revision: current, headDigest: `sha256:${sha(`head-${current}`)}` },
    manifestDigest: `sha256:${sha(`manifest-${current}`)}`,
  });
  return { root, viewRoot: path.join(root, "view"), workspace, worktree };
}

test("mirror rejects unsafe manifest paths and corrupt CAS bytes", (t) => {
  const unsafe = mirrorCutFixture("unsafe-path", [{ revision: 1, entries: [] }], 1),
    unsafeView = path.join(unsafe.viewRoot, "repos", "repo", "views", "edge-view");
  t.after(() => rmSync(unsafe.root, { recursive: true, force: true }));
  withEdgeManifest(unsafeView, (db, viewId) => {
    const blob = { sha256: sha("outside"), size: 7, mediaType: "text/markdown" };
    db.prepare("INSERT INTO edge_entry VALUES (?,?,1,0,NULL,?,?)").run(
      viewId,
      "../outside.md",
      JSON.stringify(blob),
      blob.sha256,
    );
  });
  assert.throws(
    () => applyFleetMirrorCut(unsafe.viewRoot, "repo", unsafe.workspace, "pull"),
    (error: unknown) =>
      error instanceof Error && "code" in error && (error as { code: string }).code === "unsafe_conflict_path",
  );

  const body = "expected",
    corrupt = mirrorCutFixture("corrupt-cas", [{ revision: 1, entries: [{ path: "context/note.md", body }] }], 1),
    digest = sha(body);
  t.after(() => rmSync(corrupt.root, { recursive: true, force: true }));
  writeBytes(path.join(corrupt.viewRoot, "repos", "repo", "cas", "sha256", digest.slice(0, 2), digest), "bad");
  assert.throws(
    () => applyFleetMirrorCut(corrupt.viewRoot, "repo", corrupt.workspace, "pull"),
    (error: unknown) =>
      error instanceof Error && "code" in error && (error as { code: string }).code === "replica_corrupt",
  );
});

test("F3: a staged conflict keeps its base/ bytes after the base cut leaves the retention window", async (t) => {
  const logical = "context/notes.md",
    baseBody = "# Notes\n\nbase\n",
    centerBody = "# Notes\n\ncenter\n",
    localBody = "# Notes\n\nlocal\n";
  // Real flow shape: materialize at cut 1 (clean), edit locally, pull cut 2
  // (base bytes cached while cut 1 is still retained), then jump to cut 3
  // after retention dropped cut 1 — the cache must still supply base/.
  const fixture = mirrorCutFixture(
    "f3",
    [
      { revision: 1, entries: [{ path: logical, body: baseBody }] },
      { revision: 2, entries: [{ path: logical, body: baseBody }] },
      { revision: 3, entries: [{ path: logical, body: centerBody }] },
    ],
    1,
  );
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const dir = path.join(fixture.root, "view", "repos", "repo", "views", "edge-view");
  const legacyWorktree = path.join(dir, "worktree"),
    gitSentinel = path.join(fixture.worktree, ".git", "sentinel");
  writeBytes(path.join(legacyWorktree, "obsolete.md"), "obsolete view worktree\n");
  writeBytes(gitSentinel, "workspace git metadata\n");
  const setCurrent = (revision: number): void =>
    writeJson(path.join(dir, "current.json"), {
      schemaGeneration: 0,
      cut: { revision, headDigest: `sha256:${sha(`head-${revision}`)}` },
      manifestDigest: `sha256:${sha(`manifest-${revision}`)}`,
    });
  const initial = applyFleetMirrorCut(fixture.viewRoot, "repo", fixture.workspace, "pull", { kind: "shared-docs" });
  assert.equal(initial.outcome, "applied");
  assert.equal(
    readFileSync(path.join(fixture.worktree, ...logical.split("/")), "utf8"),
    baseBody,
    "the fresh materialize projects the cut",
  );
  assert.equal(existsSync(legacyWorktree), false, "the replaced view worktree is removed");
  assert.equal(
    readFileSync(gitSentinel, "utf8"),
    "workspace git metadata\n",
    "materialization must not touch .git metadata inside the authored root",
  );
  assert.equal(
    existsSync(path.join(fixture.worktree, ".materialized-cut.json")),
    false,
    "replica bookkeeping stays outside the authored harness",
  );
  writeBytes(path.join(fixture.worktree, ...logical.split("/")), localBody);
  // Doc sync caches the observed dirty base before pulling, including an unchanged center path.
  cacheFleetMirrorDirtyBases(fixture.viewRoot, "repo", fixture.workspace);
  setCurrent(2);
  const dirty = applyFleetMirrorCut(fixture.viewRoot, "repo", fixture.workspace, "pull", { kind: "shared-docs" });
  assert.equal(
    dirty.outcome,
    "applied",
    "a center that did not move the path leaves the local edit dirty but unblocked",
  );
  assert.deepEqual(dirty.dirtyPaths, [logical]);
  rmSync(path.join(dir, "cuts", "1-g0"), { recursive: true, force: true });
  setCurrent(3);
  const jumped = applyFleetMirrorCut(fixture.viewRoot, "repo", fixture.workspace, "pull", { kind: "shared-docs" });
  assert.equal(jumped.outcome, "pull_blocked");
  assert.equal(jumped.conflicts.length, 1);
  const conflictId = jumped.conflicts[0]!.conflictId;
  const baseFile = path.join(fixture.workspace, ".harness", "conflicts", conflictId, "base", logical);
  assert.equal(
    existsSync(baseFile),
    true,
    "base/ must be staged from the dirty-base cache after retention dropped cut 1",
  );
  assert.equal(readFileSync(baseFile, "utf8"), baseBody);
  assert.equal(
    readFileSync(path.join(fixture.workspace, ".harness", "conflicts", conflictId, "center", logical), "utf8"),
    centerBody,
  );
});
test("dirty scanning a newer replica does not invent a materialization base for another node's documents", (t) => {
  const logical = "tasks/task-1/reviews/review-other.md",
    report = "tasks/task-1/artifacts/reports/other.md";
  const fixture = mirrorCutFixture(
    "unmaterialized-review",
    [
      { revision: 1, entries: [{ path: "context/notes.md", body: "base\n" }] },
      {
        revision: 2,
        entries: [
          { path: "context/notes.md", body: "base\n" },
          { path: logical, body: "review\n" },
          { path: report, body: "report\n" },
        ],
      },
      {
        revision: 3,
        entries: [
          { path: "context/notes.md", body: "base\n" },
          { path: logical, body: "consented review\n" },
          { path: report, body: "report\n" },
        ],
      },
    ],
    1,
  );
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(applyFleetMirrorCut(fixture.viewRoot, "repo", fixture.workspace, "pull").outcome, "applied");
  const viewDir = path.join(fixture.viewRoot, "repos/repo/views/edge-view");
  const advance = (revision: number) =>
    writeJson(path.join(viewDir, "current.json"), {
      schemaGeneration: 0,
      cut: { revision, headDigest: `sha256:${sha(`head-${revision}`)}` },
      manifestDigest: `sha256:${sha(`manifest-${revision}`)}`,
    });
  advance(2);
  cacheFleetMirrorDirtyBases(fixture.viewRoot, "repo", fixture.workspace, "tasks/task-1");
  advance(3);
  const applied = applyFleetMirrorCut(fixture.viewRoot, "repo", fixture.workspace, "pull");
  assert.equal(applied.outcome, "applied", JSON.stringify(applied));
  assert.deepEqual(applied.dirtyPaths, []);
  assert.equal(readFileSync(path.join(fixture.worktree, logical), "utf8"), "consented review\n");
  assert.equal(readFileSync(path.join(fixture.worktree, report), "utf8"), "report\n");
});
test("F4: an unresolved conflict persists — the same divergence re-detects under the same record and never self-heals", async (t) => {
  const logical = "context/shared.md",
    baseBody = "base\n",
    centerBody = "center\n",
    localBody = "local\n";
  const fixture = mirrorCutFixture(
    "f4",
    [
      { revision: 1, entries: [{ path: logical, body: baseBody }] },
      { revision: 2, entries: [{ path: logical, body: centerBody }] },
    ],
    2,
  );
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const worktree = fixture.worktree;
  mkdirSync(path.dirname(path.join(worktree, ...logical.split("/"))), { recursive: true });
  writeFileSync(path.join(worktree, ...logical.split("/")), localBody);
  withEdgeManifest(path.join(fixture.viewRoot, "repos/repo/views/edge-view"), (db, viewId) => {
    db.prepare("INSERT INTO materialized_cut VALUES (?,1,0,'old')").run(viewId);
    db.prepare("INSERT INTO materialized_base VALUES (?,?,?,0)").run(viewId, logical, sha(baseBody));
  });
  const first = applyFleetMirrorCut(fixture.viewRoot, "repo", fixture.workspace, "pull", {
    kind: "shared-docs",
    code: "base_blob_changed",
  });
  assert.equal(first.outcome, "pull_blocked");
  assert.equal(first.conflicts.length, 1);
  const id = first.conflicts[0]!.conflictId;
  const second = applyFleetMirrorCut(fixture.viewRoot, "repo", fixture.workspace, "pull", {
    kind: "shared-docs",
    code: "base_blob_changed",
  });
  assert.equal(second.outcome, "pull_blocked", "an unresolved conflict must not self-heal into applied");
  assert.deepEqual(
    second.conflicts.map((conflict) => conflict.conflictId),
    [id],
    "a re-detected divergence reuses its record instead of staging a duplicate",
  );
  assert.equal(readFleetUnresolvedConflicts(fixture.workspace, "repo").length, 1);
  assert.equal(
    readFileSync(path.join(worktree, ...logical.split("/")), "utf8"),
    localBody,
    "the local bytes stay untouched",
  );
});

test("F7: a center deletion under a local modification stages a three-way conflict instead of reporting applied", async (t) => {
  const logical = "context/shared.md",
    oldBody = "old\n",
    localBody = "local edit\n";
  const fixture = mirrorCutFixture(
    "f7",
    [
      { revision: 1, entries: [{ path: logical, body: oldBody }] },
      { revision: 2, entries: [] },
    ],
    2,
  );
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const worktree = fixture.worktree;
  mkdirSync(path.dirname(path.join(worktree, ...logical.split("/"))), { recursive: true });
  writeFileSync(path.join(worktree, ...logical.split("/")), localBody);
  withEdgeManifest(path.join(fixture.viewRoot, "repos/repo/views/edge-view"), (db, viewId) => {
    db.prepare("INSERT INTO materialized_cut VALUES (?,1,0,'old')").run(viewId);
    db.prepare("INSERT INTO materialized_base VALUES (?,?,?,0)").run(viewId, logical, sha(oldBody));
  });
  const result = applyFleetMirrorCut(fixture.viewRoot, "repo", fixture.workspace, "pull", { kind: "shared-docs" });
  assert.equal(result.outcome, "pull_blocked", "center-delete × local-edit must block, not masquerade as applied");
  assert.equal(result.conflicts.length, 1);
  const record = readFleetUnresolvedConflicts(fixture.workspace, "repo")[0]!;
  assert.equal(record.paths[0]!.path, logical);
  assert.equal(record.paths[0]!.centerBlobSha256, null, "the center side is the deletion itself");
  const dir = path.join(fixture.workspace, ".harness", "conflicts", record.conflictId);
  assert.equal(readFileSync(path.join(dir, "base", logical), "utf8"), oldBody);
  assert.equal(readFileSync(path.join(dir, "local", logical), "utf8"), localBody);
  assert.equal(existsSync(path.join(dir, "center", logical)), false);
  assert.equal(
    readFileSync(path.join(worktree, ...logical.split("/")), "utf8"),
    localBody,
    "the local bytes survive untouched",
  );
});

test("F9: withFleetMirrorLock serializes overlapping rounds and reclaims a stale cross-process fence", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "w3c-h-f9-")),
    viewRoot = path.join(root, "view"),
    otherViewRoot = path.join(root, "other-view");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stale = path.join(viewRoot, "repos", "repo", ".mirror-round.lock");
  mkdirSync(path.dirname(stale), { recursive: true });
  writeFileSync(stale, "999999:stale\n");
  const order: string[] = [];
  const first = withFleetMirrorLock(viewRoot, "repo", async () => {
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push("first-end");
    return 1;
  });
  const second = withFleetMirrorLock(viewRoot, "repo", async () => {
    order.push("second-start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push("second-end");
    return 2;
  });
  const unrelated = withFleetMirrorLock(otherViewRoot, "repo", async () => {
    order.push("other");
    return 3;
  });
  assert.deepEqual(await Promise.all([first, second, unrelated]), [1, 2, 3]);
  assert.ok(order.indexOf("first-start") < order.indexOf("first-end"));
  assert.ok(order.indexOf("first-end") < order.indexOf("second-start"));
  assert.ok(order.indexOf("second-start") < order.indexOf("second-end"));
  assert.ok(order.includes("other"), "a different view must be admitted independently");
  assert.equal(existsSync(stale), false, "the stale file fence must be reclaimed and the owned fence released");
});

test("F10/F11: task-package containment covers plain and ULID ids with no id-shape heuristic", () => {
  assert.equal(
    fleetDocPathInTaskPackage("tasks/task-direct-direct/task_plan.md", "task-direct"),
    true,
    "plain ids with a slug folder must carry",
  );
  assert.equal(
    fleetDocPathInTaskPackage("tasks/task-direct/task_plan.md", "task-direct"),
    true,
    "plain ids without a slug folder must carry",
  );
  assert.equal(
    fleetDocPathInTaskPackage(
      "tasks/task_01kx5nenbbtc15nvrhjxb5f5s0-probe/title.md",
      "task_01kx5nenbbtc15nvrhjxb5f5s0",
    ),
    true,
    "lowercase derived ULID ids must carry",
  );
  assert.equal(
    fleetDocPathInTaskPackage(
      "tasks/task_01kx5NENBBTC15NVRHJXB5F5S0-probe/title.md",
      "task_01kx5nenbbtc15nvrhjxb5f5s0",
    ),
    false,
    "a different-cased id is a different task",
  );
  assert.equal(
    fleetDocPathInTaskPackage("tasks/task-other-direct/x.md", "task-direct"),
    false,
    "a longer id sharing the prefix is NOT this task's package",
  );
  assert.equal(
    fleetDocPathInTaskPackage("tasks/task_iiiiiiiiiiiiiiiiiiiiiiiiii-x/a.md", "task-direct"),
    false,
    "invalid-ULID folders never match an unrelated real task",
  );
  assert.equal(
    fleetDocPathInTaskPackage("context/shared.md", "task-direct"),
    false,
    "shared-surface paths belong to no task package",
  );
});
