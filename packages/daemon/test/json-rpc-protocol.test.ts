// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { canonicalEventWritePlan, makeTaskEventStore, readDaemonRegistry, type AgentRuntimeEventV1 } from "../../kernel/src/index.ts";
import { actionForDaemonMethod, canonicalRoot, commandClassForAction, parseDaemonRpcParams, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { openRepoCell } from "../src/repo-cell.ts";
const DOC_POLICY_ID = "markdown-body-replaceable/v1";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;

test("descriptor-derived RBAC preserves every preset, runtime, doc-sync, Fact, and Decision action class", () => {
  const expected = { "task-create": "repo-write", "preset-list": "repo-read", "preset-inspect": "repo-read", "preset-check": "repo-read", "preset-install": "repo-write", "preset-uninstall": "repo-write", "preset-run-start": "repo-write", "preset-run-status": "repo-read", "task-start": "repo-write", "task-progress-append": "repo-write", "task-submit": "repo-write", "task-review-execution": "arbiter", "task-complete": "repo-write", "task-show": "repo-read", "receipt-show": "repo-read", "doc-status": "repo-read", "doc-dry-run": "repo-read", "doc-submit": "repo-write", "doc-materialize": "repo-write", "doc-show": "repo-read", "fact-record": "repo-write", "fact-search": "repo-read", "fact-show": "repo-read", "decision-propose": "repo-write", "decision-accept": "arbiter", "decision-reject": "arbiter", "decision-defer": "arbiter", "decision-retire": "repo-write", "decision-claim-add": "repo-write", "decision-claim-fulfill": "repo-write", "decision-relate": "repo-write", "decision-relation-retire": "repo-write", "decision-reckon": "repo-write", "decision-search": "repo-read", "decision-show": "repo-read" } as const;
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((kind) => [kind, commandClassForAction(kind)])), expected);
});

test("task-create and preset RPC descriptors enforce closed payloads and retire the open route", () => {
  const params = { repo: { repoId: "alpha" }, payload: { title: "Closed", presetId: "standard-task" } };
  assert.equal(parseDaemonRpcParams("repo.task.create", params).ok, true); assert.equal(parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, dryRun: true } }).ok, true); assert.equal(parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, dryRun: "true" } }).ok, false); assert.equal(parseDaemonRpcParams("repo.task.create", { ...params, payload: { ...params.payload, completionGateIds: [] } }).ok, false); assert.deepEqual(actionForDaemonMethod("repo.task.create", params.payload), { kind: "task-create", ...params.payload }); assert.throws(() => actionForDaemonMethod("repo.task.run", { action: { kind: "task-create", title: "Open" } }), /closed method/u);
});

test("preset process RPC enforces object inputs and keeps status closed", () => {
  const start = { repo: { repoId: "alpha" }, payload: { presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "once" } }, status = { repo: { repoId: "alpha" }, payload: { runId: "run_1" } };
  assert.equal(parseDaemonRpcParams("repo.preset.run.start", start).ok, true); assert.equal(parseDaemonRpcParams("repo.preset.run.start", { ...start, payload: { ...start.payload, allowScripts: true } }).ok, false); assert.equal(parseDaemonRpcParams("repo.preset.run.start", { ...start, payload: { ...start.payload, inputs: "open" } }).ok, false); assert.equal(parseDaemonRpcParams("repo.preset.run.status", status).ok, true); assert.equal(parseDaemonRpcParams("repo.preset.run.status", { ...status, payload: { ...status.payload, retry: true } }).ok, false);
});

test("repo-bound ledger commit rejects cross-repo SHA", () => {
  const roots = ["a", "b"].map((name) => mkdtempSync(path.join(tmpdir(), `ha-ledger-${name}-`)));
  try { roots.forEach(initRepo); const left = makeTaskEventStore({ rootDir: roots[0]!, repoId: "repo-a" }), right = makeTaskEventStore({ rootDir: roots[1]!, repoId: "repo-b" });
    assert.match(left.currentCommit().sha, /^[0-9a-f]{40}$/u); assert.throws(() => right.revisionAt(left.currentCommit()), /repo/iu);
  } finally { roots.forEach((root) => rmSync(root, { recursive: true, force: true })); }
});

test("task create dry-run validates the exact package without event, revision, commit, or authored writes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-create-preview-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); mkdirSync(path.join(rootDir, "harness/custom"), { recursive: true }); mkdirSync(path.join(rootDir, "harness/templates"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  scaffolds:\n    task: custom/task-scaffold.json\n"); writeFileSync(path.join(rootDir, "harness/templates/notes.md"), "# Notes\n\n## Project Notes\n\nCustom.\n"); writeFileSync(path.join(rootDir, "harness/custom/task-scaffold.json"), `${JSON.stringify({ schema: "task-scaffold/v1", replaceTemplate: [], addDocument: [{ slot: "project.notes", path: "notes.md", template: "templates/notes.md", requiredAnchors: ["## Project Notes"] }] })}\n`); cell = await openRepoCell({ repoId: workspaceId("preview"), rootDir: canonicalRoot(rootDir), ownerId: "preview-daemon" }); const action = { kind: "task-create", taskId: "task-preview", title: "Preview Package" } as const, before = git(rootDir, "rev-parse", "HEAD"), preview = await cell.run({ ...action, dryRun: true }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(preview.outcome, "applied"); assert.equal(preview.packagePath, "tasks/task-preview-preview-package"); assert.equal(preview.commitSha, null); assert.equal(preview.dryRun, true); assert.equal((preview.generatedPaths as string[]).length, 7); assert.equal((preview.generatedPaths as string[]).includes("tasks/task-preview-preview-package/notes.md"), true); assert.equal(makeTaskEventStore({ repoId: "preview", rootDir }).read().revision, 0); assert.equal(git(rootDir, "rev-parse", "HEAD"), before); assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-preview-preview-package")), false);
    const created = await cell.run(action, { actor, source: "local" }) as Record<string, unknown>; assert.equal(created.packagePath, preview.packagePath); assert.equal(created.presetDigest, preview.presetDigest); assert.equal(created.scaffoldDigest, preview.scaffoldDigest); assert.match(String(created.commitSha), /^[0-9a-f]{40}$/u); assert.match(String(created.nextAction), /task_plan\.md.*task start/u); assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-preview-preview-package/notes.md"), "utf8"), "# Notes\n\n## Project Notes\n\nCustom.\n"); assert.equal(makeTaskEventStore({ repoId: "preview", rootDir }).read().revision, 1); const duplicate = await cell.run({ ...action, title: "Different title" }, { actor, source: "local" }); assert.equal(duplicate.outcome, "rejected"); assert.equal(duplicate.code, "task_exists"); assert.equal(makeTaskEventStore({ repoId: "preview", rootDir }).read().revision, 1); writeFileSync(path.join(rootDir, "harness/tasks/task-preview-preview-package/INDEX.md"), "corrupt markdown\n"); const shown = await cell.run({ kind: "task-show", taskId: "task-preview" }, { actor, source: "local" }); const evidence = JSON.parse(String(shown.evidence)) as { packagePath: string; task: { title: string } }; assert.equal(evidence.packagePath, preview.packagePath); assert.equal(evidence.task.title, "Preview Package");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("RepoCell serializes identical lifecycle intents into one Git publication and one applied receipt", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId: workspaceId("alpha"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    const action = { kind: "task-create", verb: "create", commandType: "CreateReplayTask", taskId: "task-alpha",
      title: "Alpha task" } as const;

    const [left, right] = await Promise.all([
      cell.run(action, { actor, source: "local" }),
      cell.run(action, { actor, source: "local" })
    ]);

    assert.deepEqual([left.outcome, right.outcome], ["applied", "applied"], JSON.stringify([left, right]));
    assert.equal(left.opId, right.opId);
    assert.equal(left.revision, 1);
    assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), "2");
    const shown = await cell.run({ kind: "task-show", verb: "show", taskId: "task-alpha" }, { actor, source: "local" });
    assert.equal(shown.outcome, "applied");
    assert.match(String(shown.evidence), /Alpha task/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("invalid Fact input stays a typed rejection without disabling the RepoCell", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-invalid-fact-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("invalid-fact"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    const receipt = await cell.run({ kind: "fact-record", taskId: "task-fact", statement: "Observed", evidenceSource: "test", confidence: "high", memoryClass: "semantic", memoryTags: [],
      supersedes: { factRef: "fact/task-fact/F-ABCDEFGH", rationale: "x".repeat(200) } }, { actor, source: "local" });
    assert.deepEqual({ outcome: receipt.outcome, code: receipt.code, state: cell.status().state }, { outcome: "rejected", code: "invalid_command", state: "attached" });
    assert.equal(makeTaskEventStore({ repoId: "invalid-fact", rootDir }).readHead(), null);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("invalid Decision payload stays invalid_command and reckon records exact projected basis", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-decision-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("decision-cell"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const binding = { actor, source: "local" as const };
    assert.equal((await cell.run({ kind: "task-create", taskId: "task-decision", title: "Decision evidence" }, binding)).outcome, "applied");
    const beforeMissing = makeTaskEventStore({ repoId: "decision-cell", rootDir }).readHead()!.revision, missing = await cell.run({ kind: "decision-reckon", decisionId: "dec_MISSING", taskId: "task-decision" }, binding);
    assert.deepEqual({ outcome: missing.outcome, code: missing.code, state: cell.status().state }, { outcome: "rejected", code: "entity_not_found", state: "attached" }); assert.equal(makeTaskEventStore({ repoId: "decision-cell", rootDir }).readHead()?.revision, beforeMissing);
    const proposed = await cell.run({ kind: "decision-propose", title: "Canonical", question: "Should reckon use the exact basis?", riskTier: "medium", urgency: "medium", vertical: "default", preset: "default", decisionClass: "ordinary", appliesTo: { modules: ["daemon"], productLines: [] }, chosen: [{ id: "CH1", text: "Use events" }], rejected: [{ id: "RJ1", text: "Use files", whyNot: "They are not canonical" }] }, binding);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed)); const decisionId = (JSON.parse(proposed.evidence) as { decisionId: string }).decisionId, beforeInvalid = makeTaskEventStore({ repoId: "decision-cell", rootDir }).readHead()!.revision;
    const invalid = await cell.run({ kind: "decision-accept", decisionId, rationale: "x".repeat(200) }, { actor: { principal: { personId: "person-arbiter" }, executor: null }, source: "local", roles: ["$arbiter"] });
    assert.deepEqual({ outcome: invalid.outcome, code: invalid.code, state: cell.status().state }, { outcome: "rejected", code: "invalid_command", state: "attached" }); assert.equal(makeTaskEventStore({ repoId: "decision-cell", rootDir }).readHead()?.revision, beforeInvalid);
    const reckon = await cell.run({ kind: "decision-reckon", decisionId, taskId: "task-decision" }, binding); assert.equal(reckon.outcome, "applied", JSON.stringify(reckon)); const fact = JSON.parse(reckon.evidence) as { evidenceSource: string; statement: string; workspaceRevision: number };
    assert.equal(fact.evidenceSource, `decision/${decisionId}@${beforeInvalid}`); assert.match(fact.statement, new RegExp(`basisRevision ${beforeInvalid}`, "u")); assert.equal(fact.workspaceRevision, beforeInvalid + 1);
    const event = makeTaskEventStore({ repoId: "decision-cell", rootDir }).readEvent(reckon.opId); assert.equal(event?.schema, "fact-event/v1"); if (event?.schema === "fact-event/v1") assert.equal(event.payload.evidenceSource, fact.evidenceSource);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("receipt lookup reports Git object-store failure as indeterminate and marks the RepoCell unavailable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-corrupt-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("corrupt"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    const applied = await cell.run({ kind: "task-create", taskId: "task-corrupt", title: "Corrupt" }, { actor, source: "local" }); assert.equal(applied.outcome, "applied");
    rmSync(path.join(rootDir, ".git/objects"), { recursive: true, force: true });
    const receipt = await cell.run({ kind: "receipt-show", opId: applied.opId }, { actor, source: "local" });
    assert.deepEqual({ outcome: receipt.outcome, code: receipt.code, origin: receipt.origin }, { outcome: "indeterminate", code: "vcs_command_failed", origin: "git" });
    assert.match(receipt.nextAction ?? "", /repair.*object.*retry/iu); assert.equal(cell.status().state, "unavailable");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

for (const killpoint of ["before_event_write", "after_event_write", "after_head_write", "after_git_commit", "before_worktree_rename", "after_worktree_rename",
  "after_sqlite_commit", "before_response_write", "after_response_write"] as const) {
  test(`RepoCell new generation recovers ${killpoint} without a duplicate publication`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-crash-"));
    const action = { kind: "task-create", taskId: `task-${killpoint}`, title: killpoint } as const;
    let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined, recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initRepo(rootDir); crashed = await openRepoCell({ repoId: workspaceId("crash"), rootDir: canonicalRoot(rootDir), ownerId: "generation-one",
        killpoint: (point) => { if (point === killpoint) throw new Error(`crash:${point}`); } });
      const first = await crashed.run(action, { actor, source: "local" });
      assert.equal(first.outcome, "rejected"); assert.equal(crashed.status().state, "unavailable");
      const prePublicationCrash = ["before_event_write", "after_event_write", "after_head_write"].includes(killpoint); assert.equal(makeTaskEventStore({ repoId: "crash", rootDir }).read().revision, prePublicationCrash ? 0 : 1);
      await crashed.close(); crashed = undefined;
      recovered = await openRepoCell({ repoId: workspaceId("crash"), rootDir: canonicalRoot(rootDir), ownerId: "generation-two" });
      const retried = await recovered.run(action, { actor, source: "local" });
      assert.equal(retried.outcome, "applied", JSON.stringify(retried));
      assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), "2");
    } finally { await crashed?.close(); await recovered?.close(); rmSync(rootDir, { recursive: true, force: true }); }
  });
}

test("RepoCell doc mapping enforces strict dual CAS, holder receipts, deletion rejection, and worktree preservation", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-cell-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("docs"), rootDir: canonicalRoot(rootDir), ownerId: "doc-daemon" });
    assert.equal((await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, { actor, source: "local" })).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, { actor, source: "local" })).outcome, "applied");
    const claims = path.join(rootDir, ".harness/doc-sync-claims"), authored = path.join(rootDir, "harness/context/notes.md"); mkdirSync(claims, { recursive: true }); mkdirSync(path.dirname(authored), { recursive: true });
    let body = "# Notes\nA\n"; writeFileSync(authored, body);
    const statusBefore = await cell.run({ kind: "doc-status", paths: ["context/notes.md"] }, { actor, source: "local" }); assert.equal(statusBefore.outcome, "applied"); assert.equal(statusBefore.proof?.worktreeVisible, false);
    const action = { kind: "doc-submit", executionId: "execution-doc", paths: ["context/notes.md"] } as const;
    const before = { head: git(rootDir, "rev-parse", "HEAD"), bytes: readFileSync(authored).toString("hex") }, applied = await cell.run(action, { actor, source: "local" });
    assert.equal(applied.outcome, "applied", JSON.stringify(applied)); assert.equal(applied.detail?.kind, "doc_sync"); assert.equal(applied.proof?.worktreeVisible, true); assert.notEqual(git(rootDir, "rev-parse", "HEAD"), before.head); assert.equal(git(rootDir, "rev-parse", "HEAD"), git(rootDir, "rev-parse", "refs/ha/canonical")); assert.equal(readFileSync(authored).toString("hex"), before.bytes); assert.equal(git(rootDir, "status", "--porcelain", "-uall").includes("harness/context/notes.md"), false);
    const shown = await cell.run({ kind: "receipt-show", opId: applied.opId }, { actor, source: "local" }); assert.equal(shown.outcome, "applied"); assert.equal(shown.detail?.kind, "doc_sync"); assert.equal(shown.proof?.canonicalVisible, true);
    const commits = git(rootDir, "rev-list", "--count", "refs/ha/canonical"), retried = await cell.run(action, { actor, source: "local" }); assert.equal(retried.outcome, "applied"); assert.match(retried.opId, /^noop:/u); assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), commits);
    const next = `${body}B\n`; writeFileSync(authored, next);
    const updated = await cell.run(action, { actor, source: "local" }); assert.equal(updated.outcome, "applied", JSON.stringify(updated)); body = next;
    rmSync(authored); const deletion = await cell.run(action, { actor, source: "local" }); assert.equal(deletion.code, "deletion_forbidden"); writeFileSync(authored, body);
    const samples: number[] = []; for (let index = 0; index < 7; index += 1) { const candidate = `${body}${Array.from({ length: index + 1 }, (_, n) => `line-${n}\n`).join("")}`; writeFileSync(authored, candidate); const started = performance.now(), result = await cell.run(action, { actor, source: "local" }); samples.push(performance.now() - started); assert.equal(result.outcome, "applied", JSON.stringify(result)); body = candidate; }
    samples.sort((a, b) => a - b); const p50 = samples[Math.floor(samples.length / 2)]!; context.diagnostic(`doc-single-write-p50=${p50.toFixed(3)}ms samples=${samples.map((sample) => sample.toFixed(3)).join(",")}`); assert.equal(p50 < 500, true, `doc write p50 ${p50}ms`);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("doc ingress rejects symbolic links in claim and authored path chains", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-claim-link-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("claim-link"), rootDir: canonicalRoot(rootDir), ownerId: "doc-daemon" }); const source = { kind: "assignment", nodeId: "node", assignmentId: "assignment" } as const;
    await cell.run({ kind: "task-create", taskId: "task-doc", title: "Docs" }, { actor, source }); await cell.run({ kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, { actor, source });
    const body = "# Outside\n", hash = createHash("sha256").update(body).digest("hex"), claims = path.join(rootDir, ".harness/doc-sync-claims"); mkdirSync(claims, { recursive: true }); writeFileSync(path.join(rootDir, "outside.md"), body); symlinkSync("../../outside.md", path.join(claims, "linked"));
    const binding = { actor, source, assignmentScope: { repoId: "claim-link", taskId: "task-doc", executionId: "execution-doc", paths: ["context/link.md"] } }, base = git(rootDir, "rev-parse", "refs/ha/canonical"), result = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/link.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/linked", sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" } }] }, binding);
    assert.equal(result.code, "content_claim_mismatch"); assert.equal(git(rootDir, "rev-parse", "refs/ha/canonical"), base);
    writeFileSync(path.join(claims, "plain"), body); mkdirSync(path.join(rootDir, "harness/context"), { recursive: true }); symlinkSync("../../outside.md", path.join(rootDir, "harness/context/link.md"));
    const authoredLink = await cell.run({ kind: "doc-submit", executionId: "execution-doc", baseLedgerSha: base, changes: [{ path: "context/link.md", baseBlobSha256: null, policyId: DOC_POLICY_ID, candidate: { ref: "doc-sync-claims/plain", sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" } }] }, binding);
    assert.equal(authoredLink.code, "invalid_command"); assert.equal(git(rootDir, "rev-parse", "refs/ha/canonical"), base);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("bootstrap concurrent writer admission commits one complete workspace", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-writer-")), rootDir = path.join(parent, "repo");
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0,
    source: "unix-socket-filesystem-owner-boundary" } } as const;
  const hosts = await Promise.all(["one", "two"].map((daemonId) => openDaemonHost({ daemonId, userRoot: path.join(parent, daemonId) })));
  try { const results = await Promise.allSettled(hosts.map((host) => host.bootstrap({ rootDir, repoId: "fresh", personId: "owner", displayName: "Owner" }, auth)));
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1); assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    assert.equal(git(rootDir, "rev-list", "--count", "HEAD"), "1"); assert.equal(git(rootDir, "status", "--porcelain"), "?? .harness/"); }
  finally { await Promise.all(hosts.map((host) => host.close())); rmSync(parent, { recursive: true, force: true }); }
});

test("bootstrap binds registered default authored branch", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-branch-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0,
    source: "unix-socket-filesystem-owner-boundary" } } as const;
  mkdirSync(rootDir, { recursive: true }); initRepo(rootDir); git(rootDir, "branch", "-M", "main"); git(rootDir, "branch", "feature"); git(rootDir, "checkout", "--quiet", "feature");
  git(rootDir, "update-ref", "refs/remotes/origin/main", "refs/heads/main"); git(rootDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  let host = await openDaemonHost({ daemonId: "bootstrap-one", userRoot });
  try {
    const initialized = await host.bootstrap({ rootDir, repoId: "branch-bound", personId: "owner", displayName: "Owner" }, auth); assert.equal(initialized.outcome, "applied");
    const registered = readDaemonRegistry({ userRoot }).repos.find((repo) => repo.repoId === "branch-bound"); assert.equal(registered?.authoredBranch, "main");
    assert.equal(git(rootDir, "rev-parse", "refs/ha/canonical"), git(rootDir, "rev-parse", "refs/heads/main")); assert.equal(git(rootDir, "branch", "--show-current"), "main");
    await host.close(); host = await openDaemonHost({ daemonId: "bootstrap-two", userRoot });
    const afterRestart = await host.run("branch-bound", { kind: "task-create", taskId: "task-after-restart", title: "After restart" }, auth); assert.equal(afterRestart.outcome, "applied", JSON.stringify(afterRestart));
    assert.equal(git(rootDir, "rev-parse", "refs/ha/canonical"), git(rootDir, "rev-parse", "refs/heads/main")); assert.notEqual(git(rootDir, "rev-parse", "refs/heads/feature"), git(rootDir, "rev-parse", "refs/heads/main"));
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("bootstrap validates local identity before repository initialization", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-identity-")), rootDir = path.join(parent, "repo"), host = await openDaemonHost({ daemonId: "bootstrap-identity", userRoot: path.join(parent, "user") });
  try { await assert.rejects(host.bootstrap({ rootDir, repoId: "identity", personId: "owner", displayName: "Owner" }, { transportKind: "unix-socket" }), hasCode("bootstrap_identity_unavailable")); assert.equal(existsSync(path.join(rootDir, ".git")), false); }
  finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("unrelated workspace lock collision does not block either workspace", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-lock-collision-")), owners = new Map<number, string>(); let roots: string[] | undefined;
  for (let index = 0; index < 1_000 && !roots; index += 1) { const root = path.join(parent, `repo-${index}`), port = 40_000 + Number.parseInt(createHash("sha256").update(root).digest("hex").slice(0, 4), 16) % 20_000;
    const prior = owners.get(port); if (prior) roots = [prior, root]; else owners.set(port, root); }
  assert.ok(roots, "fixture must find roots that collide under the retired 16-bit TCP-port lock");
  roots.forEach((root) => { mkdirSync(root); initRepo(root); }); const cells = await Promise.all(roots.map((rootDir, index) => openRepoCell({ repoId: workspaceId(`repo-${index}`),
    rootDir: canonicalRoot(rootDir), ownerId: `daemon-${index}` })));
  try { assert.deepEqual(cells.map((cell) => cell.status().state), ["attached", "attached"]); }
  finally { await Promise.all(cells.map((cell) => cell.close())); rmSync(parent, { recursive: true, force: true }); }
});

test("JSON-RPC failure receipt carries formal operation identity and origin", async () => {
  const host = { run: async () => { throw new Error("unused"); }, read: async () => { throw new Error("unused"); }, attach: async () => { throw new Error("unused"); }, issueRuntimeWitness: async () => { throw new Error("unused"); }, bindRuntimeWitness: () => { throw new Error("unused"); }, publishRuntimeWitness: () => { throw new Error("unused"); }, bootstrap: async () => ({}), admin: async () => ({}),
    status: () => ({ daemonId: "test", pid: process.pid, repos: [] }), close: async () => undefined };
  const server = createJsonRpcProtocolServer({ host, authContext: { transportKind: "unix-socket" }, emit: async () => undefined });
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: -1 } });
  assert.ok(response && !Array.isArray(response) && "result" in response); if (response && !Array.isArray(response) && "result" in response) {
    const receipt = response.result as Record<string, unknown>; assert.equal(receipt.outcome, "rejected"); assert.equal(receipt.opId, "N/A"); assert.equal(receipt.origin, "daemon"); }
  await server.handle({ jsonrpc: "2.0", id: 2, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
  const malformed = await server.handle({ jsonrpc: "2.0", id: 3, method: "daemon.status", params: "not-an-object" });
  assert.ok(malformed && !Array.isArray(malformed) && "result" in malformed); if (malformed && !Array.isArray(malformed) && "result" in malformed) assert.equal((malformed.result as Record<string, unknown>).code, "invalid_request");
});

test("read-only principal cannot write or admin while semantic capabilities pass", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-rbac-surfaces-")), root = path.join(parent, "repo"), second = path.join(parent, "second"), userRoot = path.join(parent, "user");
  const ids = { reader: 4101, writer: 4102, arbiter: 4103, admin: 4104 }; [root, second].forEach((repo) => rbacRepo(repo, ids));
  const auth = (ownerUid: number) => ({ transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" } } as const);
  const host = await openDaemonHost({ daemonId: "rbac", userRoot });
  try {
    assert.equal((await rpc(host, auth(ids.admin), "daemon.repo.register", { rootDir: root, repoId: "rbac" })).outcome, "applied");
    const created = await host.run("rbac", { kind: "task-create", taskId: "task-rbac", title: "RBAC" }, auth(ids.writer)); assert.equal(created.outcome, "applied");
    const executionId = "exec-rbac", commitSha = "a".repeat(40); assert.equal((await host.run("rbac", { kind: "task-start", taskId: "task-rbac", executionId }, auth(ids.writer))).outcome, "applied");
    assert.equal((await host.run("rbac", { kind: "task-show", taskId: "task-rbac" }, auth(ids.reader))).outcome, "applied");
    const deniedWrite = await host.run("rbac", { kind: "task-create", taskId: "task-denied", title: "Denied" }, auth(ids.reader));
    assert.equal(deniedWrite.outcome, "rejected"); assert.equal(deniedWrite.code, "rbac_forbidden");
    const deniedPresetRun = await host.presetRun("rbac", { kind: "preset-run-start", presetId: "missing", entrypoint: "run", idempotencyKey: "denied" }, auth(ids.reader)), readableStatus = await host.presetRun("rbac", { kind: "preset-run-status", runId: "run_missing" }, auth(ids.reader)); assert.equal(deniedPresetRun.code, "rbac_forbidden"); assert.equal(readableStatus.code, "run_not_found");
    assert.equal((await host.run("rbac", { kind: "doc-status", paths: ["context/notes.md"] }, auth(ids.reader))).outcome, "applied");
    mkdirSync(path.join(root, "harness/context"), { recursive: true }); writeFileSync(path.join(root, "harness/context/notes.md"), "# Reader denied\n");
    const readerDoc = await host.run("rbac", { kind: "doc-submit", executionId, paths: ["context/notes.md"] }, auth(ids.reader));
    assert.equal(readerDoc.code, "rbac_forbidden"); assert.equal(readerDoc.detail?.holder?.personId, "writer");
    const deniedReview = await host.run("rbac", { kind: "task-review-execution", taskId: "task-rbac" }, auth(ids.reader));
    assert.equal(deniedReview.outcome, "rejected"); assert.equal(deniedReview.code, "rbac_forbidden");
    const deniedAdmin = await rpc(host, auth(ids.reader), "daemon.repo.register", { rootDir: second, repoId: "second" });
    assert.equal(deniedAdmin.outcome, "rejected"); assert.equal(deniedAdmin.code, "rbac_forbidden");
    assert.equal((await host.run("rbac", { kind: "task-submit", taskId: "task-rbac", executionId, claim: "done", commitSha }, auth(ids.writer))).outcome, "applied");
    const review = await host.run("rbac", { kind: "task-review-execution", taskId: "task-rbac", executionId, reviewKind: "anti_entropy", verdict: "approved",
      reviewId: "review-rbac", reason: "checked", commitSha, iteration: 0 }, auth(ids.arbiter)); assert.equal(review.outcome, "applied", JSON.stringify(review));
    assert.equal((await rpc(host, auth(ids.admin), "daemon.repo.register", { rootDir: second, repoId: "second" })).outcome, "applied");
    assert.equal((await rpc(host, auth(ids.reader), "daemon.repo.unregister", { repoId: "second" })).code, "rbac_forbidden");
    assert.equal((await rpc(host, auth(ids.admin), "daemon.repo.unregister", { repoId: "second" })).outcome, "applied");
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("runtime witness issuance uses the server principal and rejects admin or arbiter authority", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-witness-rbac-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user"), ids = { writer: 4201, admin: 4202, dualAdmin: 4203, dualArbiter: 4204 }; rbacRepo(root, ids); const auth = (ownerUid: number) => ({ transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" } } as const);
  const runtimeActor = { principal: { personId: "fixture" }, executor: null } as const, store = makeTaskEventStore({ repoId: "runtime-witness", rootDir: root }), events = [{ schema: "agent-runtime-event/v1", eventId: "runtime-installation", workspaceRevision: 1, opId: "runtime-installation", actor: runtimeActor, source: "local", occurredAt: "2026-08-13T00:00:00.000Z", type: "runtime_installation_observed", payload: { installationId: "installation-runtime", kindId: "codex", protocolFamily: "codex", hostRef: "host:local", version: "1.0.0", discoverySource: "wrapper", capabilities: ["structured_witness", "attach"], authState: "configured" } }, { schema: "agent-runtime-event/v1", eventId: "runtime-session", workspaceRevision: 2, opId: "runtime-session", actor: runtimeActor, source: "local", occurredAt: "2026-08-13T00:00:01.000Z", type: "runtime_session_started", payload: { runtimeSessionId: "session-runtime", installationId: "installation-runtime", kindId: "codex", launchGeneration: 1, attachable: true } }] as const satisfies readonly AgentRuntimeEventV1[]; for (const event of events) store.append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
  const host = await openDaemonHost({ daemonId: "runtime-witness", userRoot }); try { await host.admin({ kind: "register", rootDir: root, repoId: "runtime-witness" }, auth(ids.admin)); const issued = await host.issueRuntimeWitness("runtime-witness", "session-runtime", auth(ids.writer)), bound = host.bindRuntimeWitness("runtime-witness", issued.token); assert.equal(bound.actor.principal.personId, "writer"); assert.deepEqual(bound.actor.executor, { kind: "agent", id: "runtime-session:session-runtime" }); assert.equal(host.publishRuntimeWitness("runtime-witness", issued.token, { type: "activity", activity: "tool" }).type, "activity"); assert.throws(() => host.publishRuntimeWitness("runtime-witness", issued.token, { type: "heartbeat", actor: "provider-supplied" } as never), hasCode("invalid_provider_frame")); const assignment = { transportKind: "unix-socket", assignmentBinding: { nodeId: "node-runtime", repoId: "runtime-witness", taskId: "task-runtime", executionId: "execution-runtime", assignmentId: "assignment-runtime", paths: [], actor: { principal: { personId: "worker" }, executor: null } } } as const, assignmentToken = await host.issueRuntimeWitness("runtime-witness", "session-runtime", assignment), assignmentBound = host.bindRuntimeWitness("runtime-witness", assignmentToken.token); assert.deepEqual(assignmentBound.source, { kind: "assignment", nodeId: "node-runtime", assignmentId: "assignment-runtime" }); assert.deepEqual(assignmentBound.actor.executor, { kind: "agent", id: "runtime-session:session-runtime" }); await assert.rejects(host.issueRuntimeWitness("runtime-witness", "session-runtime", auth(ids.dualAdmin)), hasCode("rbac_forbidden")); await assert.rejects(host.issueRuntimeWitness("runtime-witness", "session-runtime", auth(ids.dualArbiter)), hasCode("rbac_forbidden")); } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}
function rbacRepo(rootDir: string, ids: Readonly<Record<string, number>>): void { mkdirSync(rootDir, { recursive: true }); initRepo(rootDir); mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), "schema: harness-anything/v1\nname: rbac\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  const people = Object.entries(ids).map(([role, uid]) => ({ personId: role, displayName: role, roles: [role], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }] }));
  const commands: Readonly<Record<string, readonly string[]>> = { reader: ["repo-read"], writer: ["repo-write"], arbiter: ["arbiter"], admin: ["admin"], dualAdmin: ["repo-write", "admin"], dualArbiter: ["repo-write", "arbiter"] }, roles = Object.keys(ids).map((roleId) => ({ roleId, commandClasses: commands[roleId] }));
  writeFileSync(path.join(rootDir, "harness/people.yaml"), `${JSON.stringify({ schema: "harness-people/v1", people, roles }, null, 2)}\n`); git(rootDir, "add", "harness"); git(rootDir, "commit", "--quiet", "-m", "add RBAC fixture"); }
async function rpc(host: Awaited<ReturnType<typeof openDaemonHost>>, auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2], method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createJsonRpcProtocolServer({ host, authContext: auth, emit: async () => undefined }); await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method, params }); assert.ok(response && !Array.isArray(response) && "result" in response); return (response as { result: Record<string, unknown> }).result; }
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function hasCode(expected: string): (error: unknown) => boolean { return (error) => typeof error === "object" && error !== null && "code" in error && error.code === expected; }
