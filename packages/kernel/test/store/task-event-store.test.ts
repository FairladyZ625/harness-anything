// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DOC_CODEC_ID, DOC_POLICY_ID, docSyncWritePlan, parseCanonicalEvent, serializeCanonicalEvent, type DocEventV1 } from "../../src/domain/doc-sync.contract.ts";
import { compileDecisionWrite, decisionWritePlan, type DecisionDocumentState, type DecisionEventDraftV1 } from "../../src/domain/decision-event.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import { serializeTaskEvent, type TaskCreatedEvent } from "../../src/domain/task-lifecycle.contract.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { freezeDeclaredWritePlan, serializeEventHead } from "../../src/domain/write-chain.contract.ts";
import { MIGRATION_DOCUMENT_POLICY_ID, migrationImportWritePlan, type MigrationImportEventV1 } from "../../src/domain/migration-import-event.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { contentObjectRelativePath, eventObjectRelativePath } from "../../src/layout/ledger-object-layout.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import { CANONICAL_EVENT_REF, makeTaskEventStore, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

const event: TaskCreatedEvent = { schema: "task-event/v1", eventId: "event-1", workspaceRevision: 1, opId: "op-1", taskId: "task-1", type: "task_created",
  actor: { principal: { personId: "person-1" }, executor: { kind: "agent", id: "codex" } }, source: "local", occurredAt: "2026-08-11T00:00:00.000Z",
  payload: { task: { schema: "task/v1", taskId: "task-1", title: "Replay task", taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0,
    createdBy: { principal: { personId: "person-1" }, executor: { kind: "agent", id: "codex" } }, completionGateIds: [], presetSnapshotDigest: null } } };

test("canonical schema registry parses task/doc once and rejects unknown or non-canonical bytes", () => {
  assert.deepEqual(parseCanonicalEvent(serializeTaskEvent(event)), event);
  assert.throws(() => parseCanonicalEvent(`${JSON.stringify({ ...event, schema: "unknown/v1" })}\n`), /unknown/u);
  assert.throws(() => parseCanonicalEvent(`${JSON.stringify(event)}\n`), /not canonical/u);
});

test("current writer rejects incomplete metadata with the exact missing field", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); const store = makeTaskEventStore({ repoId: "metadata-boundary", rootDir }), metadata = { idempotencyKey: null, parentTaskId: null, workKind: null, riskTier: null, urgency: null, verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", moduleKey: null, slug: "replay-task", surfaces: [] };
    const incomplete = { ...event, payload: { task: { ...event.payload.task, metadata } } } as unknown as TaskCreatedEvent;
    assert.throws(() => store.append(bundle(incomplete)), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "invalid_write_plan");
      assert.equal((error as Error).message, "canonical write requires the current event shape: task metadata is missing required fields: fromLegacyId");
      return true;
    });
    assert.equal(store.readHead(), null);
  });
});

test("Git object reads distinguish a missing commit path from repository failure", async () => {
  await withTempStoreAsync(async (rootDir) => {
    assert.throws(() => localGitObjectRefStore.readPath(rootDir, "0".repeat(40), "harness/events/head.json"), (error: unknown) => {
      assert.deepEqual({ code: (error as { code?: string }).code, origin: (error as { origin?: string }).origin }, { code: "vcs_command_failed", origin: "git" }); return true;
    });
    initRepo(rootDir); const commit = git(rootDir, "rev-parse", "HEAD");
    assert.equal(localGitObjectRefStore.readPath(rootDir, commit, "harness/events/head.json"), null);
    assert.throws(() => localGitObjectRefStore.readPath(rootDir, "f".repeat(40), "harness/events/head.json"), /git/u);
  });
});

test("opening a settled event store does not scan event or content trees", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); makeTaskEventStore({ repoId: "startup-budget", rootDir });
    const before = localGitObjectRefStore.processCount(); makeTaskEventStore({ repoId: "startup-budget", rootDir }); const openedProcesses = localGitObjectRefStore.processCount() - before;
    assert.equal(openedProcesses <= 2, true, `settled store startup opened ${openedProcesses} Git processes`);
  });
});

test("resident publication avoids redundant Git reads and leaves no prepared ref", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "resident-budget", rootDir });
    store.append(bundle(eventAt(1)));
    const receipt = store.append(bundle(eventAt(2)));
    assert.equal(receipt.metrics.gitProcesses, 4);
    assert.equal(
      git(rootDir, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/")
        .trim(),
      "",
    );
  });
});

test("reading the whole event stream validates every content blob in batches instead of one Git process per blob", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); const count = 40, writer = makeTaskEventStore({ repoId: "stream-budget", rootDir });
    for (let revision = 1; revision <= count; revision += 1) writer.append(docBundle(writer, `# Doc ${revision}\n`, revision, `op-doc-${String(revision).padStart(4, "0")}`, `context/doc-${revision}.md`));
    const store = makeTaskEventStore({ repoId: "stream-budget", rootDir }), before = localGitObjectRefStore.processCount(), stream = store.read(), readProcesses = localGitObjectRefStore.processCount() - before;
    assert.equal(stream.revision, count); assert.deepEqual(stream.events.map((value) => value.workspaceRevision), Array.from({ length: count }, (_value, index) => index + 1));
    assert.equal(readProcesses <= 6, true, `reading ${count} events with one content blob each opened ${readProcesses} Git processes`);
  });
});

test("batched stream validation still rejects an unreachable content blob", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); const writer = makeTaskEventStore({ repoId: "stream-corrupt", rootDir }); writer.append(docBundle(writer, "# Doc 1\n", 1, "op-doc-0001", "context/doc-1.md"));
    const hash = sha256Text("# Doc 1\n"), objectPath = path.join(rootDir, "harness", contentObjectRelativePath(hash)); writeFileSync(objectPath, "corrupt\n"); git(rootDir, "add", "harness/objects"); git(rootDir, "commit", "-qm", "corrupt blob"); git(rootDir, "update-ref", CANONICAL_EVENT_REF, "HEAD");
    const store = makeTaskEventStore({ repoId: "stream-corrupt", rootDir });
    assert.throws(() => store.read(), (error: unknown) => { assert.equal((error as { code?: string }).code, "invalid_store"); return new RegExp(`content blob ${hash} is not reachable and exact`, "u").test(String(error)); });
  });
});

test("unified publication advances canonical and authored refs to one SHA while preserving index, prose, and every unrelated dirty path byte", async (context) => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); mkdirSync(path.join(rootDir, "harness/context"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/context/user.md"), "draft\n"); writeFileSync(path.join(rootDir, "dirty.txt"), "dirty\n"); git(rootDir, "add", "harness/context/user.md"); git(rootDir, "commit", "-qm", "user prose"); writeFileSync(path.join(rootDir, "harness/context/user.md"), "draft plus local edit\n");
    const before = snapshot(rootDir), head = git(rootDir, "rev-parse", "HEAD"), store = makeTaskEventStore({ repoId: "test-repo", rootDir }), receipt = store.append(bundle(event)), after = snapshot(rootDir);
    assert.deepEqual(after.bytes, before.bytes); assert.equal(after.status, before.status); assert.equal((after.index as string).includes(before.index as string), true); assert.notEqual(git(rootDir, "rev-parse", "HEAD"), head); assert.equal(store.currentCommit().sha, git(rootDir, "rev-parse", "HEAD")); assert.equal(existsSync(path.join(rootDir, "harness/events")), true);
    assert.equal(git(rootDir, "show", `${CANONICAL_EVENT_REF}:harness/${eventObjectRelativePath(event.opId)}`), serializeCanonicalEvent(event).trimEnd()); assert.equal(store.readTaskEvent(event.opId)?.opId, event.opId);
    const reopened = makeTaskEventStore({ repoId: "test-repo", rootDir }); assert.deepEqual(reopened.append(bundle(event)).metrics.changedPaths, []); assert.throws(() => reopened.append(bundle({ ...event, payload: { task: { ...event.payload.task, title: "different" } } })), (error: unknown) => { assert.equal((error as { code?: string }).code, "op_conflict"); return /different event/u.test(String(error)); });
    assert.equal(receipt.metrics.nodeSyncs, 4); context.diagnostic(`unified-publisher-git-processes=${receipt.metrics.gitProcesses}`);
  });
});

test("doc event, content blob, and authored file publish in one default-branch canonical commit", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const store = makeTaskEventStore({ repoId: "test-repo", rootDir }), base = store.currentCut(), body = "# Notes\n\nMore prose.\n", hash = sha256Text(body);
    const doc: DocEventV1 = { schema: "doc-event/v1", eventId: "doc-event-1", workspaceRevision: 1, opId: "doc-op-1", type: "documents_written", actor: event.actor, source: "local", occurredAt: event.occurredAt,
      payload: { executionId: "execution-1", baseLedgerSha: base, changes: [{ path: "context/notes.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" }, regionProofs: [{ regionId: "heading/notes", policyId: DOC_POLICY_ID, codecId: DOC_CODEC_ID, baseSha256: sha256Text(""), candidateSha256: hash, insertBytes: Buffer.byteLength(body) }] }] } };
    const plan = docSyncWritePlan(doc); assert.equal(plan.targets.some((target) => (target as { readonly kind: string; readonly path?: string }).kind === "authored_file" && (target as { readonly path?: string }).path === "context/notes.md"), true);
    const baseTargets = plan.targets.filter((target) => target.kind !== "local_wal_file");
    const extra = freezeDeclaredWritePlan({ commandType: "DocSyncSubmit", targets: [...baseTargets,
      { kind: "content_blob", sha256: "f".repeat(64), size: 1, mediaType: "text/plain" }] }, ["DocSyncSubmit"]), missing = freezeDeclaredWritePlan({ commandType: "DocSyncSubmit", targets: baseTargets.filter((target) => target.kind !== "content_blob") }, ["DocSyncSubmit"]), before = store.currentCommit();
    assert.throws(() => store.append({ event: doc, plan: extra, blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] }), /write plan/iu); assert.deepEqual(store.currentCommit(), before);
    assert.throws(() => store.append({ event: doc, plan: missing, blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] }), /write plan/iu); assert.deepEqual(store.currentCommit(), before);
    assert.throws(() => (plan.targets as unknown as unknown[]).push(extra.targets.at(-1))); assert.deepEqual(store.currentCommit(), before);
    const receipt = store.append({ event: doc, plan, blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] });
    const branchRef = git(rootDir, "symbolic-ref", "HEAD"); assert.equal(git(rootDir, "rev-parse", branchRef), receipt.commitSha.sha); assert.equal(git(rootDir, "rev-parse", CANONICAL_EVENT_REF), receipt.commitSha.sha);
    assert.deepEqual(store.readEvent(doc.opId), doc); assert.equal(Buffer.from(store.readContentBlob(hash)!).toString("utf8"), body); assert.equal(git(rootDir, "show", `${receipt.commitSha.sha}:harness/${contentObjectRelativePath(hash)}`), body.trimEnd());
    assert.equal(git(rootDir, "show", `${receipt.commitSha.sha}:harness/context/notes.md`), body.trimEnd()); assert.equal(readFileSync(path.join(rootDir, "harness/context/notes.md"), "utf8"), body);
    assert.deepEqual(git(rootDir, "diff-tree", "--no-commit-id", "--name-only", "-r", receipt.commitSha.sha).split("\n").sort(), ["harness/context/notes.md", `harness/${eventObjectRelativePath(doc.opId)}`, "harness/events/head.json", `harness/${contentObjectRelativePath(hash)}`]);
    assert.equal(git(rootDir, "status", "--porcelain", "-uall"), ""); assert.equal(git(rootDir, "ls-tree", "--name-only", `${receipt.commitSha.sha}^`, "harness/context/notes.md"), "");
    const clone = path.join(rootDir, "fresh-clone"); execFileSync("git", ["clone", "-q", rootDir, clone]); const cloned = makeTaskEventStore({ repoId: "test-repo", rootDir: clone }); assert.equal(cloned.currentCommit().sha, git(clone, "rev-parse", "HEAD")); assert.deepEqual(cloned.readEvent(doc.opId), doc); assert.equal(readFileSync(path.join(clone, "harness/context/notes.md"), "utf8"), body); assert.equal(git(clone, "status", "--porcelain", "-uall"), "");
  });
});

test("document retirement preserves a local edit that races the canonical deletion", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const logical = "context/temporary.md", canonical = "# Temporary\n", local = "# Concurrent local edit\n", store = makeTaskEventStore({ repoId: "retirement-conflict", rootDir }); store.append(docBundle(store, canonical, 1, "op-retirement-base", logical)); writeFileSync(path.join(rootDir, "harness", logical), local);
    const retired: DocEventV1 = { schema: "doc-event/v1", eventId: "event-retirement-delete", workspaceRevision: 2, opId: "op-retirement-delete", type: "documents_written", actor: event.actor, source: "local", occurredAt: event.occurredAt, payload: { executionId: null, baseLedgerSha: store.currentCut(), retirementReason: "superseded temporary evidence", changes: [{ path: logical, baseBlobSha256: sha256Text(canonical), candidate: null, policyId: DOC_POLICY_ID, regionProofs: [] }] } };
    store.append({ event: retired, plan: docSyncWritePlan(retired), blobs: [] }); const directory = path.join(rootDir, "harness/context"), conflict = readdirSync(directory).find((name) => /^temporary\.conflict-[0-9a-f]{8}\.md$/u.test(name)); assert.equal(existsSync(path.join(rootDir, "harness", logical)), false); assert.ok(conflict); assert.equal(readFileSync(path.join(directory, conflict), "utf8"), local); assert.equal(git(rootDir, "ls-tree", "--name-only", "HEAD", `harness/${logical}`), "");
  });
});

test("a reopened store verifies and reuses a reachable content blob", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const body = "# Shared\n", hash = sha256Text(body), first = makeTaskEventStore({ repoId: "blob-reuse", rootDir }); first.append(docBundle(first, body, 1, "blob-one", "context/one.md"));
    const reopened = makeTaskEventStore({ repoId: "blob-reuse", rootDir }), receipt = reopened.append(docBundle(reopened, body, 2, "blob-two", "context/two.md")), objectPath = `harness/${contentObjectRelativePath(hash)}`;
    assert.equal(receipt.metrics.changedPaths.includes(objectPath), false); assert.equal(git(rootDir, "diff-tree", "--no-commit-id", "--name-only", "-r", receipt.commitSha.sha).split("\n").includes(objectPath), false); assert.equal(Buffer.from(reopened.readContentBlob(hash)!).toString("utf8"), body);
  });
});

test("a reachable content blob is validated before reuse", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const body = "# Valid\n", hash = sha256Text(body), objectPath = path.join(rootDir, "harness", contentObjectRelativePath(hash)); mkdirSync(path.dirname(objectPath), { recursive: true }); writeFileSync(objectPath, "corrupt\n"); git(rootDir, "add", "harness/objects"); git(rootDir, "commit", "-qm", "corrupt fixture"); const store = makeTaskEventStore({ repoId: "blob-corrupt", rootDir });
    assert.throws(() => store.append(docBundle(store, body, 1, "blob-corrupt", "context/corrupt.md")), (error: unknown) => { assert.equal((error as { code?: string }).code, "invalid_store"); return /content blob.*corrupt/u.test(String(error)); });
  });
});

test("a committed symbolic link is replaced without a hidden conflict copy", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const directory = path.join(rootDir, "harness/context"), target = path.join(directory, "latest.md"); mkdirSync(directory, { recursive: true }); symlinkSync("old.md", target); git(rootDir, "add", "harness/context/latest.md"); git(rootDir, "commit", "-qm", "committed link");
    const store = makeTaskEventStore({ repoId: "symlink-store", rootDir }); store.append(repoLinkBundle("context/latest.md", "new.md"));
    assert.equal(readlinkSync(target), "new.md"); assert.equal(readdirSync(directory).some((name) => name.includes(".conflict-")), false);
  });
});

test("a symbolic link changed after its parent commit still gets a conflict copy", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const directory = path.join(rootDir, "harness/context"), target = path.join(directory, "latest.md"); mkdirSync(directory, { recursive: true }); symlinkSync("old.md", target); git(rootDir, "add", "harness/context/latest.md"); git(rootDir, "commit", "-qm", "committed link"); unlinkSync(target); symlinkSync("local-edit.md", target);
    const store = makeTaskEventStore({ repoId: "symlink-conflict-store", rootDir }); store.append(repoLinkBundle("context/latest.md", "new.md")); const conflict = readdirSync(directory).find((name) => name.includes(".conflict-"));
    assert.equal(readlinkSync(target), "new.md"); assert.ok(conflict); assert.equal(readlinkSync(path.join(directory, conflict)), "local-edit.md");
  });
});

test("an authorized migration replacement rejects a destination that changed after classification", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const directory = path.join(rootDir, "harness/context"), target = path.join(directory, "notes.md"), expected = "# Initialized\n", changed = "# Edited after dry-run\n"; mkdirSync(directory, { recursive: true }); writeFileSync(target, expected); git(rootDir, "add", "harness/context/notes.md"); git(rootDir, "commit", "-qm", "initialized document"); const store = makeTaskEventStore({ repoId: "preimage-store", rootDir }); writeFileSync(target, changed);
    assert.throws(() => store.append(repoFileBundle("context/notes.md", "# Legacy\n", expected)), /destination changed.*dry-run/iu); assert.equal(store.read().revision, 0); assert.equal(readFileSync(target, "utf8"), changed); assert.equal(readdirSync(directory).some((name) => name.includes(".conflict-")), false); assert.equal(git(rootDir, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/"), "");
  });
});

test("recovery rechecks the durable destination preimage instead of creating a hidden backup", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const directory = path.join(rootDir, "harness/context"), target = path.join(directory, "notes.md"), expected = "# Initialized\n", changed = "# Edited after preparation\n"; mkdirSync(directory, { recursive: true }); writeFileSync(target, expected); git(rootDir, "add", "harness/context/notes.md"); git(rootDir, "commit", "-qm", "initialized document"); const interrupted = makeTaskEventStore({ repoId: "preimage-recovery", rootDir, killpoint: (point) => { if (point === "after_head_write") throw new Error("crash"); } }); assert.throws(() => interrupted.append(repoFileBundle("context/notes.md", "# Legacy\n", expected)), /crash/u); writeFileSync(target, changed);
    const recovered = makeTaskEventStore({ repoId: "preimage-recovery", rootDir }).recover(); assert.equal(recovered.status, "indeterminate"); assert.equal(readFileSync(target, "utf8"), changed); assert.equal(readdirSync(directory).some((name) => name.includes(".conflict-")), false); assert.equal(git(rootDir, "rev-parse", CANONICAL_EVENT_REF), git(rootDir, "rev-parse", "HEAD"));
  });
});

test("recovery accepts the authorized result after refs and worktree replacement completed", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const directory = path.join(rootDir, "harness/context"), target = path.join(directory, "notes.md"), expected = "# Initialized\n", migrated = "# Legacy\n"; mkdirSync(directory, { recursive: true }); writeFileSync(target, expected); git(rootDir, "add", "harness/context/notes.md"); git(rootDir, "commit", "-qm", "initialized document"); const interrupted = makeTaskEventStore({ repoId: "preimage-published-recovery", rootDir, killpoint: (point) => { if (point === "after_worktree_rename") throw new Error("crash"); } }); assert.throws(() => interrupted.append(repoFileBundle("context/notes.md", migrated, expected)), /crash/u);
    const recovered = makeTaskEventStore({ repoId: "preimage-published-recovery", rootDir }).recover(); assert.equal(recovered.status, "already_committed"); assert.equal(readFileSync(target, "utf8"), migrated); assert.equal(readdirSync(directory).some((name) => name.includes(".conflict-")), false); assert.equal(git(rootDir, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/"), "");
  });
});

test("Decision bundle publishes one canonical document, enforces base CAS, and preserves a hand-edit conflict", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const store = makeTaskEventStore({ repoId: "decision-store", rootDir }), proposal = decisionProposal(), compiled = compileDecisionWrite({ event: proposal, currentDecision: null, currentRelations: [], currentDocument: null }), missing = { ...compiled, blobs: [] }, invalidPlan = freezeDeclaredWritePlan({ commandType: "DecisionWrite", targets: compiled.plan.targets.filter((target) => target.kind !== "content_blob" && target.kind !== "local_wal_file") }, ["DecisionWrite"]), before = store.currentCommit();
    assert.throws(() => store.append({ ...compiled, plan: invalidPlan }), /decision write plan/u); assert.throws(() => store.append(missing), /content inputs/u); assert.deepEqual(store.currentCommit(), before); const receipt = store.append(compiled), documentTarget = `harness/${compiled.path}`, objectTarget = `harness/${contentObjectRelativePath(compiled.event.payload.decisionDocumentClaim.sha256)}`; assert.deepEqual(receipt.metrics.changedPaths, [documentTarget, `harness/${eventObjectRelativePath(proposal.opId)}`, "harness/events/head.json", objectTarget].sort()); assert.equal(git(rootDir, "show", `${receipt.commitSha.sha}:${documentTarget}`), compiled.body.trimEnd()); assert.equal(git(rootDir, "show", `${receipt.commitSha.sha}:${objectTarget}`), compiled.body.trimEnd());
    const local = "# hand-edited Decision\n"; writeFileSync(path.join(rootDir, documentTarget), local); const materialized = store.materialize(); assert.deepEqual(materialized.changed, [compiled.path]); assert.equal(materialized.conflicts.length, 1); assert.equal(readFileSync(path.join(rootDir, materialized.conflicts[0]!), "utf8"), local); assert.equal(readFileSync(path.join(rootDir, documentTarget), "utf8"), compiled.body); assert.equal(readdirSync(path.dirname(path.join(rootDir, documentTarget))).some((name) => name.includes(".conflict-")), true);
    const current: Omit<DecisionDocumentState, "relations"> = { decisionId: proposal.decisionId, state: "proposed", title: proposal.payload.title, question: proposal.payload.question, riskTier: proposal.payload.riskTier, urgency: proposal.payload.urgency, vertical: proposal.payload.vertical, preset: proposal.payload.preset, decisionClass: proposal.payload.decisionClass, appliesTo: proposal.payload.appliesTo, proposer: proposal.actor, arbiter: null, proposedAt: proposal.occurredAt, decidedAt: null, workspaceRevision: 1, chosen: proposal.payload.chosen, rejected: proposal.payload.rejected, claims: [], judgmentConsents: [] }, acceptedDraft: DecisionEventDraftV1 = { ...proposal, eventId: "event-decision-store-2", workspaceRevision: 2, opId: "op-decision-store-2", type: "decision_accepted", actor: { principal: { personId: "person-arbiter" }, executor: null }, occurredAt: "2026-08-14T00:00:01.000Z", payload: { rationale: "Independent approval.", judgmentOnlyRationale: "Explicit judgment-only approval." } }, accepted = compileDecisionWrite({ event: acceptedDraft, currentDecision: current, currentRelations: [], currentDocument: { blobSha256: compiled.event.payload.decisionDocumentClaim.sha256, body: compiled.body } }), stale = { ...accepted.event, payload: { ...accepted.event.payload, baseDocumentSha256: "0".repeat(64) } };
    assert.throws(() => store.append({ ...accepted, event: stale, plan: decisionWritePlan(stale) }), /document base changed/u); assert.equal(store.read().revision, 1); const second = store.append(accepted); assert.equal(store.read().revision, 2); assert.equal(readFileSync(path.join(rootDir, documentTarget), "utf8"), accepted.body); assert.equal(git(rootDir, "rev-parse", "HEAD"), second.commitSha.sha);
  });
});

test("authored branch advancement outside the daemon fails closed", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const store = makeTaskEventStore({ repoId: "test-repo", rootDir }), canonical = store.currentCommit().sha; git(rootDir, "commit", "--allow-empty", "-qm", "external advance");
    assert.throws(() => store.append(bundle(event)), (error: unknown) => { assert.equal((error as { code?: string }).code, "publication_indeterminate"); const text = String(error); assert.ok(text.includes(canonical), `recovery guidance must name the target commit: ${text}`); assert.ok(text.includes(`update-ref refs/heads/master ${canonical}`), `recovery guidance must give an executable command: ${text}`); return true; }); assert.equal(git(rootDir, "rev-parse", CANONICAL_EVENT_REF), canonical); assert.equal(store.readHead(), null);
  });
});

for (const killpoint of ["before_event_write", "after_event_write", "after_head_write", "after_git_commit", "before_worktree_rename", "after_worktree_rename"] as const) {
  test(`Decision authored recovery handles ${killpoint} without duplicate publication`, async () => {
    await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const decision = compileDecisionWrite({ event: decisionProposal(), currentDecision: null, currentRelations: [], currentDocument: null }), interrupted = makeTaskEventStore({ repoId: "test-repo", rootDir, killpoint: (point) => { if (point === killpoint) throw new Error(`crash:${point}`); } });
      assert.throws(() => interrupted.append(decision), new RegExp(`crash:${killpoint}`, "u")); const recovery = makeTaskEventStore({ repoId: "test-repo", rootDir }).recover();
      if (killpoint === "after_head_write") assert.equal(recovery.status, "committed"); else if (["after_git_commit", "before_worktree_rename", "after_worktree_rename"].includes(killpoint)) assert.equal(recovery.status, "already_committed"); else assert.equal(recovery.status, "none");
      const resumed = makeTaskEventStore({ repoId: "test-repo", rootDir }); resumed.append(decision); assert.equal(resumed.read().revision, 1); assert.equal(resumed.read().events[0]?.schema, "decision-event/v1"); assert.equal(git(rootDir, "rev-list", "--count", CANONICAL_EVENT_REF), "2"); assert.equal(git(rootDir, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/"), "");
    });
  });
}

for (const killpoint of ["before_event_write", "after_event_write", "after_head_write", "after_git_commit", "before_worktree_rename", "after_worktree_rename"] as const) {
  test(`SIGKILL recovery handles ${killpoint} without duplicate publication`, { skip: process.platform === "win32" ? "requires POSIX SIGKILL kill-point semantics" : false }, async () => {
    await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const moduleUrl = new URL("../../src/store/task-event-store.ts", import.meta.url).href, child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", [
        `import { makeTaskEventStore } from ${JSON.stringify(moduleUrl)};`,
        `import { taskLifecycleWritePlan } from ${JSON.stringify(new URL("../../src/domain/task-lifecycle-publication.ts", import.meta.url).href)};`,
        "const event = JSON.parse(process.env.HA_KILL_EVENT);",
        "makeTaskEventStore({ repoId: 'test-repo', rootDir: process.env.HA_KILL_ROOT, killpoint: (point) => { if (point === process.env.HA_KILL_POINT) process.kill(process.pid, 'SIGKILL'); } }).append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });"
      ].join("\n")], { encoding: "utf8", env: { ...process.env, HA_KILL_EVENT: JSON.stringify(event), HA_KILL_POINT: killpoint, HA_KILL_ROOT: rootDir } });
      assert.equal(child.signal, "SIGKILL", child.stderr); const recovery = makeTaskEventStore({ repoId: "test-repo", rootDir }).recover();
      if (killpoint === "after_head_write") assert.equal(recovery.status, "committed"); else if (["after_git_commit", "before_worktree_rename", "after_worktree_rename"].includes(killpoint)) assert.equal(recovery.status, "already_committed"); else assert.equal(recovery.status, "none");
      const resumed = makeTaskEventStore({ repoId: "test-repo", rootDir }); resumed.append(bundle(event)); assert.equal(resumed.read().revision, 1); assert.equal(git(rootDir, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/"), ""); assert.equal(git(rootDir, "rev-parse", CANONICAL_EVENT_REF), git(rootDir, "rev-parse", "HEAD"));
    });
  });
}

test("flat ledger migration renames every event and blob, appends one event, and audits reachability", async () => {
  await withTempStoreAsync(async (rootDir) => { const { blobHash, parent } = flatLedgerFixture(rootDir, 2), store = makeTaskEventStore({ repoId: "layout-migrate", rootDir }), beforeTree = git(rootDir, "rev-parse", `${parent}:harness/events`), receipt = store.migrateLayout({ actor: event.actor, source: "local", occurredAt: "2026-08-16T00:00:00.000Z" }); assert.equal(receipt.event.schema, "ledger-layout-event/v1"); if (receipt.event.schema !== "ledger-layout-event/v1") return;
    assert.deepEqual(receipt.event.payload, { from: "flat/v1", to: "sharded-sha256-2/v1", eventCount: 2, blobCount: 1, preEventsTreeSha: beforeTree }); assert.equal(receipt.revision, 3); assert.equal(git(rootDir, "rev-list", "--count", receipt.commitSha.sha), String(Number(git(rootDir, "rev-list", "--count", parent)) + 1)); assert.equal(spawnSync("git", ["-C", rootDir, "merge-base", "--is-ancestor", parent, receipt.commitSha.sha]).status, 0);
    const rootEntries = git(rootDir, "ls-tree", "--name-only", `${receipt.commitSha.sha}:harness/events`).split("\n"); assert.deepEqual(rootEntries.filter((name) => name.endsWith(".json")), ["head.json"]); for (const oldEvent of [eventAt(1), eventAt(2)]) { assert.equal(git(rootDir, "ls-tree", "--name-only", receipt.commitSha.sha, "--", `harness/events/${oldEvent.opId}.json`), ""); assert.equal(git(rootDir, "show", `${receipt.commitSha.sha}:harness/${eventObjectRelativePath(oldEvent.opId)}`), serializeTaskEvent(oldEvent).trimEnd()); }
    assert.equal(git(rootDir, "show", `${receipt.commitSha.sha}:harness/${contentObjectRelativePath(blobHash)}`), "legacy blob"); assert.equal(store.read().revision, 3); const repeated = store.migrateLayout({ actor: event.actor, source: "local", occurredAt: "2026-08-16T00:00:00.000Z" }); assert.equal(repeated.commitSha.sha, receipt.commitSha.sha); assert.equal(git(rootDir, "rev-parse", "HEAD"), receipt.commitSha.sha);
  });
});

for (const killpoint of ["after_head_write", "after_worktree_rename"] as const) {
  test(`flat ledger migration recovers ${killpoint} through the prepared ref`, async () => {
    await withTempStoreAsync(async (rootDir) => { flatLedgerFixture(rootDir, 2); let settledRenames = 0; const interrupted = makeTaskEventStore({ repoId: "layout-recovery", rootDir, killpoint: (point) => { if (point !== killpoint || point === "after_worktree_rename" && ++settledRenames < 3) return; throw new Error(`crash:${point}`); } }); assert.throws(() => interrupted.migrateLayout({ actor: event.actor, source: "local", occurredAt: "2026-08-16T00:00:00.000Z" }), new RegExp(`crash:${killpoint}`, "u")); if (killpoint === "after_worktree_rename") { const first = eventAt(1); assert.equal(existsSync(path.join(rootDir, `harness/events/${first.opId}.json`)), false); assert.equal(existsSync(path.join(rootDir, "harness", eventObjectRelativePath(first.opId))), true); }
      const recoveredStore = makeTaskEventStore({ repoId: "layout-recovery", rootDir }), recovered = recoveredStore.recover(); assert.equal(recovered.status, killpoint === "after_head_write" ? "committed" : "already_committed"); assert.equal(recoveredStore.read().revision, 3); assert.deepEqual(git(rootDir, "ls-tree", "--name-only", "HEAD:harness/events").split("\n").filter((name) => name.endsWith(".json")), ["head.json"]);
    });
  });
}

test("append follows the ledger's existing flat layout, stays readable, and reuses flat blobs", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { blobHash } = flatLedgerFixture(rootDir, 2), store = makeTaskEventStore({ repoId: "flat-append", rootDir });
    assert.equal(store.layout(), "flat/v1");
    const third = eventAt(3);
    store.append(bundle(third));
    assert.equal(existsSync(path.join(rootDir, `harness/events/${third.opId}.json`)), true);
    assert.equal(git(rootDir, "ls-tree", "-d", "--name-only", "HEAD:harness/events"), "");
    assert.equal(store.read().revision, 3);
    assert.deepEqual(store.readEvent(third.opId), third);
    assert.deepEqual(store.append(bundle(third)).metrics.changedPaths, []);
    const doc = store.append(docBundle(store, "legacy blob\n", 4, "op-doc-flat", "context/flat.md"));
    assert.equal(doc.metrics.changedPaths.includes(`harness/objects/sha256/${blobHash}`), false);
    assert.equal(git(rootDir, "ls-tree", "--name-only", "HEAD:harness/objects/sha256").trim(), blobHash);
    assert.equal(store.read().revision, 4);
  });
});

test("append keeps the sharded layout on sharded ledgers", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "sharded-append", rootDir });
    assert.equal(store.layout(), "sharded-sha256-2/v1");
    store.append(bundle(eventAt(1)));
    assert.equal(existsSync(path.join(rootDir, "harness", eventObjectRelativePath(eventAt(1).opId))), true);
    assert.equal(existsSync(path.join(rootDir, `harness/events/${eventAt(1).opId}.json`)), false);
    assert.equal(store.read().revision, 1);
  });
});

test("content blob writes dedupe against both the flat and the sharded spelling", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventsRoot = path.join(rootDir, "harness/events"), objectsRoot = path.join(rootDir, "harness/objects/sha256");
    mkdirSync(eventsRoot, { recursive: true }); mkdirSync(objectsRoot, { recursive: true });
    const first = eventAt(1), second = eventAt(2);
    writeFileSync(path.join(eventsRoot, `${first.opId}.json`), serializeTaskEvent(first));
    writeFileSync(path.join(eventsRoot, `${second.opId}.json`), serializeTaskEvent(second));
    writeFileSync(path.join(eventsRoot, "head.json"), serializeEventHead({ revision: 2, opId: second.opId, eventDigest: `sha256:${sha256Text(serializeTaskEvent(second))}` }));
    const body = "# Twin body\n", hash = sha256Text(body), sharded = path.join(objectsRoot, hash.slice(0, 2), hash.slice(2));
    mkdirSync(path.dirname(sharded), { recursive: true });
    writeFileSync(sharded, body);
    git(rootDir, "add", "harness"); git(rootDir, "commit", "-qm", "flat events with one sharded blob");
    const store = makeTaskEventStore({ repoId: "blob-dual-dedupe", rootDir });
    assert.equal(store.layout(), "flat/v1");
    const receipt = store.append(docBundle(store, body, 3, "op-doc-twin", "context/twin.md"));
    assert.equal(receipt.metrics.changedPaths.includes(`harness/objects/sha256/${hash}`), false);
    assert.equal(git(rootDir, "ls-tree", "--name-only", "HEAD:harness/objects/sha256").includes(hash), false);
    assert.equal(Buffer.from(store.readContentBlob(hash)!).toString("utf8"), body);
    assert.equal(store.read().revision, 3);
  });
});

test("mixed ledger migration normalizes shards and twins, then migrates, audits, and replays idempotently", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const fixture = mixedLedgerFixture(rootDir), store = makeTaskEventStore({ repoId: "mixed-migrate", rootDir });
    const beforeCommitCount = Number(git(rootDir, "rev-list", "--count", fixture.parent));
    const beforeEventBytes = [...fixture.flatEvents, fixture.shardedEvent].map((value) => serializeTaskEvent(value));
    const beforeDistinctBlobs = new Set(fixture.blobBodies.map((body) => sha256Text(body)));
    const receipt = store.migrateLayout({ actor: event.actor, source: "local", occurredAt: "2026-08-18T00:00:00.000Z" });
    assert.equal(receipt.event.schema, "ledger-layout-event/v1"); if (receipt.event.schema !== "ledger-layout-event/v1") return;
    assert.deepEqual(receipt.event.payload, { from: "flat/v1", to: "sharded-sha256-2/v1", eventCount: 3, blobCount: beforeDistinctBlobs.size, preEventsTreeSha: git(rootDir, "rev-parse", `${receipt.commitSha.sha}^:harness/events`) });
    assert.equal(receipt.revision, 4);
    assert.deepEqual(git(rootDir, "ls-tree", "--name-only", "HEAD:harness/events").split("\n").filter((name) => name.endsWith(".json")), ["head.json"]);
    assert.equal(git(rootDir, "ls-tree", "--name-only", "-d", "HEAD:harness/events").split("\n").filter(Boolean).length > 0, true);
    assert.equal(git(rootDir, "ls-tree", "--name-only", "HEAD:harness/objects/sha256").split("\n").filter((name) => /^[0-9a-f]{64}$/u.test(name)).length, 0);
    for (const value of [...fixture.flatEvents, fixture.shardedEvent]) assert.equal(git(rootDir, "show", `HEAD:harness/${eventObjectRelativePath(value.opId)}`), serializeTaskEvent(value).trimEnd());
    const reachableBlobs = git(rootDir, "ls-tree", "-r", "HEAD:harness/objects/sha256").split("\n").map((row) => row.split(/\s/u).at(-1)!.replace("/", ""));
    assert.equal(reachableBlobs.includes(fixture.twinHash), true);
    assert.equal(new Set(reachableBlobs).size, beforeDistinctBlobs.size);
    assert.equal(Number(git(rootDir, "rev-list", "--count", "HEAD")), beforeCommitCount + 2);
    assert.equal(store.read().revision, 4);
    assert.deepEqual(new Set(store.read().events.filter((value) => value.schema === "task-event/v1").map((value) => (value as TaskCreatedEvent).taskId)), new Set(["task-00001", "task-00002", "task-00003"]));
    const beforeBytes = new Set(beforeEventBytes.map((bytes) => sha256Text(bytes)));
    assert.equal(store.read().events.filter((value) => value.schema === "task-event/v1").every((value) => beforeBytes.has(sha256Text(serializeTaskEvent(value as TaskCreatedEvent)))), true);
    const repeated = store.migrateLayout({ actor: event.actor, source: "local", occurredAt: "2026-08-18T00:00:00.000Z" });
    assert.equal(repeated.commitSha.sha, receipt.commitSha.sha);
    assert.equal(store.layout(), "sharded-sha256-2/v1");
  });
});

test("startup recovery is independent of 100 versus 10,000-event history", async (context) => {
  const prepare = (rootDir: string, count: number) => { initRepo(rootDir); const eventsRoot = path.join(rootDir, "harness/events"); mkdirSync(eventsRoot, { recursive: true }); let last = event;
    for (let revision = 1; revision <= count; revision += 1) { last = eventAt(revision); const target = path.join(rootDir, "harness", eventObjectRelativePath(last.opId)); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, serializeTaskEvent(last)); }
    const bytes = serializeTaskEvent(last); writeFileSync(path.join(eventsRoot, "head.json"), serializeEventHead({ revision: count, opId: last.opId, eventDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` })); git(rootDir, "add", "harness/events"); git(rootDir, "commit", "-qm", `${count} events`);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }), appendParent = store.currentCommit().sha, appendReceipt = store.append(bundle(eventAt(count + 1))), objectBytes = incrementalObjectBytes(rootDir, appendParent, appendReceipt.commitSha.sha);
    return { rootDir, count, nextRevision: count + 2, appendProcesses: appendReceipt.metrics.gitProcesses, objectBytes };
  };
  const recoverOnce = (fixture: ReturnType<typeof prepare>) => { const next = eventAt(fixture.nextRevision); fixture.nextRevision += 1; const interrupted = makeTaskEventStore({ repoId: "test-repo", rootDir: fixture.rootDir, killpoint: (point) => { if (point === "after_head_write") throw new Error("crash"); } }); assert.throws(() => interrupted.append(bundle(next)), /crash/u);
    const started = performance.now(), store = makeTaskEventStore({ repoId: "test-repo", rootDir: fixture.rootDir }), constructorMs = performance.now() - started, recovered = store.recover(); assert.equal(recovered.status, "committed"); return { totalMs: constructorMs + recovered.elapsedMs, constructorMs, recoverMs: recovered.elapsedMs };
  };
  await withTempStoreAsync(async (hundredRoot) => withTempStoreAsync(async (thousandRoot) => withTempStoreAsync(async (tenThousandRoot) => {
    const hundred = prepare(hundredRoot, 100), thousand = prepare(thousandRoot, 1_000), tenThousand = prepare(tenThousandRoot, 10_000), hundredSamples: ReturnType<typeof recoverOnce>[] = [], tenThousandSamples: ReturnType<typeof recoverOnce>[] = [], ratios: number[] = [];
    for (let round = 0; round < 11; round += 1) {
      let hundredSample: ReturnType<typeof recoverOnce> | undefined, tenThousandSample: ReturnType<typeof recoverOnce> | undefined;
      const order = round % 2 === 0 ? [hundred, tenThousand] : [tenThousand, hundred];
      for (const fixture of order) { const sample = recoverOnce(fixture); if (fixture.count === 100) hundredSample = sample; else tenThousandSample = sample; }
      assert.ok(hundredSample); assert.ok(tenThousandSample); hundredSamples.push(hundredSample); tenThousandSamples.push(tenThousandSample); ratios.push(tenThousandSample.totalMs / hundredSample.totalMs);
    }
    const totals = (samples: readonly ReturnType<typeof recoverOnce>[]) => samples.map((sample) => sample.totalMs), constructors = (samples: readonly ReturnType<typeof recoverOnce>[]) => samples.map((sample) => sample.constructorMs), recoveries = (samples: readonly ReturnType<typeof recoverOnce>[]) => samples.map((sample) => sample.recoverMs), describe = (values: readonly number[]) => `p50=${median(values).toFixed(3)}ms min=${Math.min(...values).toFixed(3)}ms max=${Math.max(...values).toFixed(3)}ms`;
    context.diagnostic(`recovery-samples history=100 samples=${hundredSamples.length} total(${describe(totals(hundredSamples))}) constructor(${describe(constructors(hundredSamples))}) recover(${describe(recoveries(hundredSamples))})`);
    context.diagnostic(`recovery-samples history=10000 samples=${tenThousandSamples.length} total(${describe(totals(tenThousandSamples))}) constructor(${describe(constructors(tenThousandSamples))}) recover(${describe(recoveries(tenThousandSamples))})`);
    const orderedRatios = [...ratios].sort((left, right) => left - right), ratio = median(ratios), objectRatio = tenThousand.objectBytes / thousand.objectBytes; context.diagnostic(`recovery-ratio=paired-10000-over-100 samples=${ratios.length} p50=${ratio.toFixed(3)}x min=${orderedRatios[0]!.toFixed(3)}x max=${orderedRatios.at(-1)!.toFixed(3)}x appendObjectBytes1000=${thousand.objectBytes} appendObjectBytes10000=${tenThousand.objectBytes} objectRatio=${objectRatio.toFixed(3)}`);
    assert.equal(ratio < 2, true, `10k/100 paired p50 ratio ${ratio} (spread ${orderedRatios[0]}-${orderedRatios.at(-1)})`); assert.equal(tenThousand.appendProcesses, hundred.appendProcesses, "append Git subprocess count must be history-independent"); assert.equal(objectRatio < 2, true, `10k/1k append object-byte ratio ${objectRatio}`);
  })));
});

// #1588: a bootstrapped repository carries harness/.gitattributes, which is what keeps a clone
// byte-faithful when the host global is core.autocrlf=true. The fixture builds its repository by
// hand, so it has to seed the same file or it measures the developer's git config, not the product.
function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); mkdirSync(path.join(rootDir, "harness"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/.gitattributes"), "* -text\n"); git(rootDir, "config", "user.name", "Store Test"); git(rootDir, "config", "user.email", "store@example.invalid"); git(rootDir, "config", "gc.auto", "0"); git(rootDir, "config", "maintenance.auto", "false"); git(rootDir, "add", "harness/.gitattributes"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function flatLedgerFixture(rootDir: string, count: number): { readonly parent: string; readonly blobHash: string } { initRepo(rootDir); const eventsRoot = path.join(rootDir, "harness/events"), objectsRoot = path.join(rootDir, "harness/objects/sha256"); mkdirSync(eventsRoot, { recursive: true }); mkdirSync(objectsRoot, { recursive: true }); let last = event; for (let revision = 1; revision <= count; revision += 1) { last = eventAt(revision); writeFileSync(path.join(eventsRoot, `${last.opId}.json`), serializeTaskEvent(last)); } const bytes = serializeTaskEvent(last); writeFileSync(path.join(eventsRoot, "head.json"), serializeEventHead({ revision: count, opId: last.opId, eventDigest: `sha256:${sha256Text(bytes)}` })); const blobBody = "legacy blob\n", blobHash = sha256Text(blobBody); writeFileSync(path.join(objectsRoot, blobHash), blobBody); git(rootDir, "add", "harness"); git(rootDir, "commit", "-qm", "flat ledger"); return { parent: git(rootDir, "rev-parse", "HEAD"), blobHash }; }
function mixedLedgerFixture(rootDir: string): { readonly parent: string; readonly flatEvents: readonly TaskCreatedEvent[]; readonly shardedEvent: TaskCreatedEvent; readonly blobBodies: readonly string[]; readonly twinHash: string } {
  initRepo(rootDir);
  const eventsRoot = path.join(rootDir, "harness/events"), objectsRoot = path.join(rootDir, "harness/objects/sha256");
  mkdirSync(eventsRoot, { recursive: true }); mkdirSync(objectsRoot, { recursive: true });
  const flatEvents = [eventAt(1), eventAt(2)];
  for (const value of flatEvents) writeFileSync(path.join(eventsRoot, `${value.opId}.json`), serializeTaskEvent(value));
  const twinBody = "legacy blob\n", twinHash = sha256Text(twinBody);
  writeFileSync(path.join(objectsRoot, twinHash), twinBody);
  const shardedEvent = eventAt(3), shardedEventPath = path.join(rootDir, "harness", eventObjectRelativePath(shardedEvent.opId));
  mkdirSync(path.dirname(shardedEventPath), { recursive: true }); writeFileSync(shardedEventPath, serializeTaskEvent(shardedEvent));
  const shardedOnlyBody = "sharded only\n", shardedOnlyHash = sha256Text(shardedOnlyBody), shardedOnlyPath = path.join(objectsRoot, shardedOnlyHash.slice(0, 2), shardedOnlyHash.slice(2));
  mkdirSync(path.dirname(shardedOnlyPath), { recursive: true }); writeFileSync(shardedOnlyPath, shardedOnlyBody);
  const twinShardedPath = path.join(objectsRoot, twinHash.slice(0, 2), twinHash.slice(2));
  mkdirSync(path.dirname(twinShardedPath), { recursive: true }); writeFileSync(twinShardedPath, twinBody);
  const bytes = serializeTaskEvent(shardedEvent);
  writeFileSync(path.join(eventsRoot, "head.json"), serializeEventHead({ revision: 3, opId: shardedEvent.opId, eventDigest: `sha256:${sha256Text(bytes)}` }));
  git(rootDir, "add", "harness"); git(rootDir, "commit", "-qm", "mixed ledger");
  return { parent: git(rootDir, "rev-parse", "HEAD"), flatEvents, shardedEvent, blobBodies: [twinBody, shardedOnlyBody], twinHash };
}
function incrementalObjectBytes(rootDir: string, parent: string, commit: string): number { const objects = git(rootDir, "rev-list", "--objects", "--no-object-names", `${parent}..${commit}`).split("\n").filter(Boolean); if (!objects.length) return 0; const sizes = execFileSync("git", ["-C", rootDir, "cat-file", "--batch-check=%(objectsize:disk)"], { input: `${objects.join("\n")}\n`, encoding: "utf8" }); return sizes.trim().split(/\r?\n/u).reduce((sum, value) => sum + Number(value), 0); }
function median(values: readonly number[]): number { const ordered = [...values].sort((left, right) => left - right); return ordered[Math.floor(ordered.length / 2)]!; }
function eventAt(revision: number): TaskCreatedEvent { const suffix = String(revision).padStart(5, "0"); return { ...event, eventId: `event-${suffix}`, workspaceRevision: revision, opId: `op-${suffix}`, taskId: `task-${suffix}`, payload: { task: { ...event.payload.task, taskId: `task-${suffix}`, title: `Task ${suffix}` } } }; }
function decisionProposal(): Extract<DecisionEventDraftV1, { readonly type: "decision_proposed" }> { return { schema: "decision-event/v1", eventId: "event-decision-store-1", workspaceRevision: 1, opId: "op-decision-store-1", decisionId: "dec_STORE", type: "decision_proposed", actor: { principal: { personId: "person-proposer" }, executor: null }, source: "local", occurredAt: "2026-08-14T00:00:00.000Z", payload: { title: "Store Decision", question: "Does one bundle own every write?", riskTier: "medium", urgency: "medium", vertical: "software/coding", preset: "standard-task", appliesTo: { modules: ["kernel"], productLines: [] }, decisionClass: "ordinary", chosen: [{ id: "CH1", text: "Use one bundle" }], rejected: [{ id: "RJ1", text: "Split writes", whyNot: "They can diverge." }], body: "\n# Store Decision\n", claims: [], fulfillments: [], relations: [] } }; }
function bundle(value: TaskCreatedEvent): CanonicalWriteBundle { return { event: value, plan: taskLifecycleWritePlan(value), blobs: [] }; }
function docBundle(store: ReturnType<typeof makeTaskEventStore>, body: string, revision: number, opId: string, target: string): CanonicalWriteBundle { const hash = sha256Text(body), value: DocEventV1 = { schema: "doc-event/v1", eventId: `event-${opId}`, workspaceRevision: revision, opId, type: "documents_written", actor: event.actor, source: "local", occurredAt: event.occurredAt, payload: { executionId: "execution-1", baseLedgerSha: store.currentCut(), changes: [{ path: target, baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" }, regionProofs: [{ regionId: "heading/shared", policyId: DOC_POLICY_ID, codecId: DOC_CODEC_ID, baseSha256: sha256Text(""), candidateSha256: hash, insertBytes: Buffer.byteLength(body) }] }] } }; return { event: value, plan: docSyncWritePlan(value), blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] }; }
function repoLinkBundle(target: string, body: string): CanonicalWriteBundle { const hash = sha256Text(body), migration: MigrationImportEventV1 = { schema: "migration-import-event/v1", eventId: "event-link", workspaceRevision: 1, opId: "op-link", type: "entity_migrated", actor: event.actor, source: "migration-import/v1", occurredAt: event.occurredAt, payload: { migratedFrom: target, generation: "v0", entity: { kind: "repo-document", nodeKind: "symbolic-link", documentClaim: { path: target, sha256: hash, size: Buffer.byteLength(body), mediaType: "application/vnd.harness.symbolic-link", policyId: MIGRATION_DOCUMENT_POLICY_ID }, referencedContentClaims: [] } } }; return { event: migration, plan: migrationImportWritePlan(migration), blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "application/vnd.harness.symbolic-link", body }] }; }
function repoFileBundle(target: string, body: string, destinationBody: string): CanonicalWriteBundle { const hash = sha256Text(body), migration: MigrationImportEventV1 = { schema: "migration-import-event/v1", eventId: "event-file", workspaceRevision: 1, opId: "op-file", type: "entity_migrated", actor: event.actor, source: "migration-import/v1", occurredAt: event.occurredAt, payload: { migratedFrom: target, generation: "v0", entity: { kind: "repo-document", nodeKind: "file", documentClaim: { path: target, sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", policyId: MIGRATION_DOCUMENT_POLICY_ID }, referencedContentClaims: [], destinationPreimage: { nodeKind: "file", sha256: sha256Text(destinationBody), size: Buffer.byteLength(destinationBody) } } } }; return { event: migration, plan: migrationImportWritePlan(migration), blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] }; }
function snapshot(rootDir: string): unknown { const files = ["harness/context/user.md", "dirty.txt"]; return { status: git(rootDir, "status", "--porcelain", "-uall"), index: git(rootDir, "ls-files", "-s"), bytes: files.map((file) => readFileSync(path.join(rootDir, file)).toString("hex")) }; }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

// #1587: the predicate passing is not the same as the predicate being wired into publication.
// This drives a real append, so removing the assertion from assertBundle turns it red — the
// unit test over assertPublishableOpId alone stayed green when the call site was deleted.
test("#1587: publishing an event whose opId cannot be a filename is refused, and nothing is written", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }), before = store.currentCommit();
    const unportable = { ...event, opId: "runtime-spawn-abcdef:installation" } as typeof event;
    assert.throws(() => store.append({ event: unportable, plan: taskLifecycleWritePlan(unportable), blobs: [] }), /cannot be a filename/u);
    assert.deepEqual(store.currentCommit(), before);
    assert.equal(store.readEvent(unportable.opId), null);
    // The legal spelling of the same publication still goes through.
    const portable = { ...event, opId: "runtime-spawn-abcdef-installation" } as typeof event;
    assert.equal(store.append({ event: portable, plan: taskLifecycleWritePlan(portable), blobs: [] }).commitSha.sha.length, 40);
  });
});
