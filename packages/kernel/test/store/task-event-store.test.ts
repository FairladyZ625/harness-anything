// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DOC_CODEC_ID, DOC_POLICY_ID, docSyncWritePlan, parseCanonicalEvent, serializeCanonicalEvent, type DocEventV1 } from "../../src/domain/doc-sync.contract.ts";
import { compileDecisionWrite, decisionWritePlan, type DecisionDocumentState, type DecisionEventDraftV1 } from "../../src/domain/fact-event.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import { serializeTaskEvent, type TaskCreatedEvent } from "../../src/domain/task-lifecycle.contract.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { freezeDeclaredWritePlan, serializeEventHead } from "../../src/domain/write-chain.contract.ts";
import { MIGRATION_DOCUMENT_POLICY_ID, migrationImportWritePlan, type MigrationImportEventV1 } from "../../src/domain/migration-import-event.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
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

test("unified publication advances canonical and authored refs to one SHA while preserving index, prose, and every unrelated dirty path byte", async (context) => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); mkdirSync(path.join(rootDir, "harness/context"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/context/user.md"), "draft\n"); writeFileSync(path.join(rootDir, "dirty.txt"), "dirty\n"); git(rootDir, "add", "harness/context/user.md"); git(rootDir, "commit", "-qm", "user prose"); writeFileSync(path.join(rootDir, "harness/context/user.md"), "draft plus local edit\n");
    const before = snapshot(rootDir), head = git(rootDir, "rev-parse", "HEAD"), store = makeTaskEventStore({ repoId: "test-repo", rootDir }), receipt = store.append(bundle(event)), after = snapshot(rootDir);
    assert.deepEqual(after.bytes, before.bytes); assert.equal(after.status, before.status); assert.equal((after.index as string).includes(before.index as string), true); assert.notEqual(git(rootDir, "rev-parse", "HEAD"), head); assert.equal(store.currentCommit().sha, git(rootDir, "rev-parse", "HEAD")); assert.equal(existsSync(path.join(rootDir, "harness/events")), true);
    assert.equal(git(rootDir, "show", `${CANONICAL_EVENT_REF}:harness/events/op-1.json`), serializeCanonicalEvent(event).trimEnd()); assert.equal(store.readTaskEvent(event.opId)?.opId, event.opId);
    assert.deepEqual(store.append(bundle(event)).metrics.changedPaths, []); assert.throws(() => store.append(bundle({ ...event, payload: { task: { ...event.payload.task, title: "different" } } })), (error: unknown) => { assert.equal((error as { code?: string }).code, "op_conflict"); return /different event/u.test(String(error)); });
    assert.equal(receipt.metrics.nodeSyncs, 3); context.diagnostic(`unified-publisher-git-processes=${receipt.metrics.gitProcesses}`);
  });
});

test("doc event, content blob, and authored file publish in one default-branch canonical commit", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const store = makeTaskEventStore({ repoId: "test-repo", rootDir }), base = store.currentCommit(), body = "# Notes\n\nMore prose.\n", hash = sha256Text(body);
    const doc: DocEventV1 = { schema: "doc-event/v1", eventId: "doc-event-1", workspaceRevision: 1, opId: "doc-op-1", type: "documents_written", actor: event.actor, source: "local", occurredAt: event.occurredAt,
      payload: { executionId: "execution-1", baseLedgerSha: base, changes: [{ path: "context/notes.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" }, regionProofs: [{ regionId: "heading/notes", policyId: DOC_POLICY_ID, codecId: DOC_CODEC_ID, baseSha256: sha256Text(""), candidateSha256: hash, insertBytes: Buffer.byteLength(body) }] }] } };
    const plan = docSyncWritePlan(doc); assert.equal(plan.targets.some((target) => (target as { readonly kind: string; readonly path?: string }).kind === "authored_file" && (target as { readonly path?: string }).path === "context/notes.md"), true);
    const extra = freezeDeclaredWritePlan({ commandType: "DocSyncSubmit", targets: [...plan.targets,
      { kind: "content_blob", sha256: "f".repeat(64), size: 1, mediaType: "text/plain" }] }, ["DocSyncSubmit"]), missing = freezeDeclaredWritePlan({ commandType: "DocSyncSubmit", targets: plan.targets.filter((target) => target.kind !== "content_blob") }, ["DocSyncSubmit"]), before = store.currentCommit();
    assert.throws(() => store.append({ event: doc, plan: extra, blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] }), /write plan/iu); assert.deepEqual(store.currentCommit(), before);
    assert.throws(() => store.append({ event: doc, plan: missing, blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] }), /write plan/iu); assert.deepEqual(store.currentCommit(), before);
    assert.throws(() => (plan.targets as unknown as unknown[]).push(extra.targets.at(-1))); assert.deepEqual(store.currentCommit(), before);
    const receipt = store.append({ event: doc, plan, blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] });
    const branchRef = git(rootDir, "symbolic-ref", "HEAD"); assert.equal(git(rootDir, "rev-parse", branchRef), receipt.commitSha.sha); assert.equal(git(rootDir, "rev-parse", CANONICAL_EVENT_REF), receipt.commitSha.sha);
    assert.deepEqual(store.readEvent(doc.opId), doc); assert.equal(Buffer.from(store.readContentBlob(hash)!).toString("utf8"), body); assert.equal(git(rootDir, "show", `${receipt.commitSha.sha}:harness/objects/sha256/${hash}`), body.trimEnd());
    assert.equal(git(rootDir, "show", `${receipt.commitSha.sha}:harness/context/notes.md`), body.trimEnd()); assert.equal(readFileSync(path.join(rootDir, "harness/context/notes.md"), "utf8"), body);
    assert.deepEqual(git(rootDir, "diff-tree", "--no-commit-id", "--name-only", "-r", receipt.commitSha.sha).split("\n").sort(), ["harness/context/notes.md", "harness/events/doc-op-1.json", "harness/events/head.json", `harness/objects/sha256/${hash}`]);
    assert.equal(git(rootDir, "status", "--porcelain", "-uall"), ""); assert.equal(git(rootDir, "ls-tree", "--name-only", `${receipt.commitSha.sha}^`, "harness/context/notes.md"), "");
    const clone = path.join(rootDir, "fresh-clone"); execFileSync("git", ["clone", "-q", rootDir, clone]); const cloned = makeTaskEventStore({ repoId: "test-repo", rootDir: clone }); assert.equal(cloned.currentCommit().sha, git(clone, "rev-parse", "HEAD")); assert.deepEqual(cloned.readEvent(doc.opId), doc); assert.equal(readFileSync(path.join(clone, "harness/context/notes.md"), "utf8"), body); assert.equal(git(clone, "status", "--porcelain", "-uall"), "");
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
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const store = makeTaskEventStore({ repoId: "decision-store", rootDir }), proposal = decisionProposal(), compiled = compileDecisionWrite({ event: proposal, currentDecision: null, currentRelations: [], currentDocument: null }), missing = { ...compiled, blobs: [] }, invalidPlan = freezeDeclaredWritePlan({ commandType: "DecisionWrite", targets: compiled.plan.targets.slice(0, -1) }, ["DecisionWrite"]), before = store.currentCommit();
    assert.throws(() => store.append({ ...compiled, plan: invalidPlan }), /decision write plan/u); assert.throws(() => store.append(missing), /content inputs/u); assert.deepEqual(store.currentCommit(), before); const receipt = store.append(compiled), documentTarget = `harness/${compiled.path}`, objectTarget = `harness/objects/sha256/${compiled.event.payload.decisionDocumentClaim.sha256}`; assert.deepEqual(receipt.metrics.changedPaths, [documentTarget, `harness/events/${proposal.opId}.json`, "harness/events/head.json", objectTarget].sort()); assert.equal(git(rootDir, "show", `${receipt.commitSha.sha}:${documentTarget}`), compiled.body.trimEnd()); assert.equal(git(rootDir, "show", `${receipt.commitSha.sha}:${objectTarget}`), compiled.body.trimEnd());
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
  test(`SIGKILL recovery handles ${killpoint} without duplicate publication`, async () => {
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

test("startup recovery is under 250ms and independent of 100 versus 10,000-event history", async (context) => {
  const fixture = async (count: number) => withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const eventsRoot = path.join(rootDir, "harness/events"); mkdirSync(eventsRoot, { recursive: true }); let last = event;
    for (let revision = 1; revision <= count; revision += 1) { last = eventAt(revision); writeFileSync(path.join(eventsRoot, `${last.opId}.json`), serializeTaskEvent(last)); }
    const bytes = serializeTaskEvent(last); writeFileSync(path.join(eventsRoot, "head.json"), serializeEventHead({ revision: count, opId: last.opId, eventDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` })); git(rootDir, "add", "harness/events"); git(rootDir, "commit", "-qm", `${count} events`);
    const next = eventAt(count + 1), interrupted = makeTaskEventStore({ repoId: "test-repo", rootDir, killpoint: (point) => { if (point === "after_head_write") throw new Error("crash"); } }); assert.throws(() => interrupted.append(bundle(next)), /crash/u);
    const started = performance.now(), recovered = makeTaskEventStore({ repoId: "test-repo", rootDir }).recover(), elapsed = performance.now() - started; assert.equal(recovered.status, "committed"); context.diagnostic(`recovery-${count} constructor=${(elapsed - recovered.elapsedMs).toFixed(3)}ms recover=${recovered.elapsedMs.toFixed(3)}ms`); assert.equal(elapsed < 250, true, `recovery ${elapsed}ms`); return elapsed; });
  const hundred = await fixture(100), tenThousand = await fixture(10_000), ratio = tenThousand / hundred; context.diagnostic(`recovery 100=${hundred.toFixed(3)}ms 10000=${tenThousand.toFixed(3)}ms ratio=${ratio.toFixed(3)}`); assert.equal(ratio < 2, true, `10k/100 ratio ${ratio}`);
});

function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Store Test"); git(rootDir, "config", "user.email", "store@example.invalid"); git(rootDir, "config", "gc.auto", "0"); git(rootDir, "config", "maintenance.auto", "false"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function eventAt(revision: number): TaskCreatedEvent { const suffix = String(revision).padStart(5, "0"); return { ...event, eventId: `event-${suffix}`, workspaceRevision: revision, opId: `op-${suffix}`, taskId: `task-${suffix}`, payload: { task: { ...event.payload.task, taskId: `task-${suffix}`, title: `Task ${suffix}` } } }; }
function decisionProposal(): Extract<DecisionEventDraftV1, { readonly type: "decision_proposed" }> { return { schema: "decision-event/v1", eventId: "event-decision-store-1", workspaceRevision: 1, opId: "op-decision-store-1", decisionId: "dec_STORE", type: "decision_proposed", actor: { principal: { personId: "person-proposer" }, executor: null }, source: "local", occurredAt: "2026-08-14T00:00:00.000Z", payload: { title: "Store Decision", question: "Does one bundle own every write?", riskTier: "medium", urgency: "medium", vertical: "software/coding", preset: "standard-task", appliesTo: { modules: ["kernel"], productLines: [] }, decisionClass: "ordinary", chosen: [{ id: "CH1", text: "Use one bundle" }], rejected: [{ id: "RJ1", text: "Split writes", whyNot: "They can diverge." }], body: "\n# Store Decision\n", claims: [], fulfillments: [], relations: [] } }; }
function bundle(value: TaskCreatedEvent): CanonicalWriteBundle { return { event: value, plan: taskLifecycleWritePlan(value), blobs: [] }; }
function repoLinkBundle(target: string, body: string): CanonicalWriteBundle { const hash = sha256Text(body), migration: MigrationImportEventV1 = { schema: "migration-import-event/v1", eventId: "event-link", workspaceRevision: 1, opId: "op-link", type: "entity_migrated", actor: event.actor, source: "migration-import/v1", occurredAt: event.occurredAt, payload: { migratedFrom: target, generation: "v0", entity: { kind: "repo-document", nodeKind: "symbolic-link", documentClaim: { path: target, sha256: hash, size: Buffer.byteLength(body), mediaType: "application/vnd.harness.symbolic-link", policyId: MIGRATION_DOCUMENT_POLICY_ID }, referencedContentClaims: [] } } }; return { event: migration, plan: migrationImportWritePlan(migration), blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "application/vnd.harness.symbolic-link", body }] }; }
function repoFileBundle(target: string, body: string, destinationBody: string): CanonicalWriteBundle { const hash = sha256Text(body), migration: MigrationImportEventV1 = { schema: "migration-import-event/v1", eventId: "event-file", workspaceRevision: 1, opId: "op-file", type: "entity_migrated", actor: event.actor, source: "migration-import/v1", occurredAt: event.occurredAt, payload: { migratedFrom: target, generation: "v0", entity: { kind: "repo-document", nodeKind: "file", documentClaim: { path: target, sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", policyId: MIGRATION_DOCUMENT_POLICY_ID }, referencedContentClaims: [], destinationPreimage: { nodeKind: "file", sha256: sha256Text(destinationBody), size: Buffer.byteLength(destinationBody) } } } }; return { event: migration, plan: migrationImportWritePlan(migration), blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] }; }
function snapshot(rootDir: string): unknown { const files = ["harness/context/user.md", "dirty.txt"]; return { status: git(rootDir, "status", "--porcelain", "-uall"), index: git(rootDir, "ls-files", "-s"), bytes: files.map((file) => readFileSync(path.join(rootDir, file)).toString("hex")) }; }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
