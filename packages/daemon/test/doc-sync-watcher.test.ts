// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, registerDaemonRepo, sha256Text, type WriteReceipt } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openDocSyncWatcher } from "../src/doc-sync-watcher.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

test("watch notifications are hints and two stable fingerprints admit one RepoCell submission", async () => {
  const actions: Array<{ kind: string; paths: readonly string[] }> = [], pathValue = "context/notes.md", bodyHash = "a".repeat(64), base = "b".repeat(40);
  const watcher = openDocSyncWatcher({ rootDir: process.cwd(), personId: "person-owner", watchFilesystem: false, startupScan: false, debounceMs: 1,
    run: async (action, attribution) => { actions.push(action as { kind: string; paths: readonly string[] }); if (action.kind === "doc-submit") { assert.deepEqual(attribution, { sessionId: watcher.status().sessionId, personId: "person-owner", path: pathValue, fingerprint: bodyHash }); return applied("submit"); }
      return scan(base, [{ path: pathValue, state: "eligible", candidateBlobSha256: bodyHash }]); } });
  try { watcher.wake(pathValue); watcher.wake(pathValue); watcher.wake(pathValue); await watcher.flush();
    assert.deepEqual(actions.map(({ kind }) => kind), ["doc-dry-run", "doc-dry-run", "doc-submit"]); assert.deepEqual(watcher.status().metrics, { scans: 2, intents: 1, commits: 1, writes: 1 });
    watcher.wake(pathValue); watcher.overflow(); watcher.wake(pathValue); await watcher.flush(); assert.equal(actions.filter(({ kind }) => kind === "doc-submit").length, 1);
  } finally { await watcher.close(); }
});

test("watch registration failure degrades to periodic full-scan polling instead of a silent dead zone", async () => {
  // Missing authored root makes every watch() registration throw, the same failure shape
  // as Linux inotify watch exhaustion (ENOSPC). The watcher must keep reconciling via
  // periodic wakes rather than silently reporting nothing.
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-watch-degrade-")); let scans = 0;
  const watcher = openDocSyncWatcher({ rootDir, personId: "person-owner", startupScan: false, debounceMs: 1, pollMs: 5,
    run: async () => { scans += 1; return scan("f".repeat(40), []); } });
  try {
    assert.equal(watcher.status().state, "blocked");
    await new Promise((resolve) => setTimeout(resolve, 60)); await watcher.flush();
    assert.ok(scans >= 1, `expected the poll fallback to trigger at least one scan, saw ${scans}`);
    const settled = scans; await watcher.close(); await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(scans, settled, "closed watcher must stop polling");
  } finally { await watcher.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("temporary and unnormalizable filesystem hints fall back to a full scan", async () => {
  const actions: Array<{ kind: string; paths: readonly string[] }> = [], canonical = "context/notes.md", fingerprint = "d".repeat(64);
  const watcher = openDocSyncWatcher({ rootDir: process.cwd(), personId: "person-owner", watchFilesystem: false, startupScan: false, debounceMs: 1,
    run: async (action) => { actions.push(action); return action.kind === "doc-submit" ? applied("atomic-save") : scan("e".repeat(40), [{ path: canonical, state: "eligible", candidateBlobSha256: fingerprint }]); } });
  try { watcher.wake(`${canonical}.vim-tmp`); await watcher.flush(); assert.deepEqual(actions, [{ kind: "doc-dry-run", paths: [] }, { kind: "doc-dry-run", paths: [canonical] }, { kind: "doc-submit", paths: [canonical] }]); }
  finally { await watcher.close(); }
});

test("vim save is harvested without a doc command and restart collects offline edits", async () => {
  const fixture = repoFixture("offline"); let host = await openDaemonHost({ daemonId: "watch-offline-one", userRoot: fixture.userRoot, watchOwnerUid: fixture.uid, watchDebounceMs: 2 });
  try {
    atomicSave(fixture.rootDir, "context/notes.md", "# Notes\n\nOnline edit.\n"); await waitFor(() => revision(fixture) === 1); const first = makeTaskEventStore({ repoId: fixture.repoId, rootDir: fixture.rootDir }).read().events[0]!;
    assert.equal(first.schema, "doc-event/v1"); assert.equal(first.actor.principal.personId, "person-owner"); assert.equal(first.actor.executor, null); assert.equal(typeof first.source === "object" && first.source.kind, "watch_session"); if (first.schema === "doc-event/v1") assert.equal(first.payload.executionId, null);
    await host.close(); atomicSave(fixture.rootDir, "context/offline.md", "# Offline\n\nSaved while stopped.\n"); host = await openDaemonHost({ daemonId: "watch-offline-two", userRoot: fixture.userRoot, watchOwnerUid: fixture.uid, watchDebounceMs: 2 });
    await waitFor(() => revision(fixture) === 2); assert.equal(git(fixture.rootDir, "diff", "--name-only", "--", "harness"), ""); assert.equal(git(fixture.rootDir, "status", "--porcelain", "-uall").includes("conflict-"), false); assert.equal(readFileSync(path.join(fixture.rootDir, "harness/context/offline.md"), "utf8"), "# Offline\n\nSaved while stopped.\n");
  } finally { await host.close(); fixture.close(); }
});

test("task progress appends canonically, reports its file, and watcher loopback stays zero-write", async () => {
  const fixture = repoFixture("task-binding"), host = await openDaemonHost({ daemonId: "watch-task-binding", userRoot: fixture.userRoot, watchOwnerUid: fixture.uid, watchDebounceMs: 2 }), auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: fixture.uid, source: "unix-socket-filesystem-owner-boundary" } } as const;
  try { assert.equal((await host.run(fixture.repoId, { kind: "task-create", taskId: "task-doc", title: "Docs" }, auth)).outcome, "applied"); const withoutLease = await host.run(fixture.repoId, { kind: "task-progress-append", taskId: "task-doc", text: "too early", evidence: [] }, auth); assert.equal(withoutLease.code, "progress_lease_required"); assert.equal(revision(fixture), 1); assert.equal((await host.run(fixture.repoId, { kind: "task-start", taskId: "task-doc", executionId: "execution-doc" }, auth)).outcome, "applied"); atomicSave(fixture.rootDir, "tasks/task-doc-docs/notes.md", "# Notes\n\nwatch me\n"); await waitFor(() => revision(fixture) === 3); const event = makeTaskEventStore({ repoId: fixture.repoId, rootDir: fixture.rootDir }).read().events[2]; assert.equal(event?.schema, "doc-event/v1"); if (event?.schema === "doc-event/v1") assert.equal(event.payload.executionId, "execution-doc");
    for (const rejected of [{ kind: "task-progress-append", taskId: "task-doc", executionId: "wrong", text: "wrong execution", evidence: [] }, { kind: "task-progress-append", taskId: "task-doc", text: "stale", evidence: [], baseDocumentSha256: "f".repeat(64) }, { kind: "task-progress-append", taskId: "task-doc", text: "bad evidence", evidence: [{ type: "test", path: "../escape", summary: "bad" }] }]) assert.equal((await host.run(fixture.repoId, rejected, auth)).outcome, "rejected"); assert.equal(revision(fixture), 3);
    const beforeCanonicalWake = watcherScans(host), progressAction = { kind: "task-progress-append", taskId: "task-doc", text: "Implemented exact progress.", evidence: [{ type: "test", path: "reports/check.txt", summary: "passed" }] }, receipt = await host.run(fixture.repoId, progressAction, auth) as WriteReceipt & { progressPath?: string; eventId?: string; commitSha?: string; worktreeVisible?: boolean }; assert.equal(receipt.outcome, "applied", JSON.stringify(receipt)); assert.equal(receipt.progressPath, "tasks/task-doc-docs/progress.md"); assert.match(receipt.eventId ?? "", /^event-/u); assert.match(receipt.commitSha ?? "", /^[0-9a-f]{40}$/u); assert.equal(receipt.worktreeVisible, true); assert.match(receipt.evidence ?? "", /file:tasks\/task-doc-docs\/progress\.md/u); assert.match(readFileSync(path.join(fixture.rootDir, "harness/tasks/task-doc-docs/progress.md"), "utf8"), /Implemented exact progress\..*Evidence: test:reports\/check\.txt:passed/su); const retry = await host.run(fixture.repoId, progressAction, auth); assert.deepEqual([retry.opId, retry.revision], [receipt.opId, receipt.revision]); assert.equal(revision(fixture), 4); assert.equal((readFileSync(path.join(fixture.rootDir, "harness/tasks/task-doc-docs/progress.md"), "utf8").match(/Implemented exact progress/gu) ?? []).length, 1); await waitFor(() => watcherScans(host) > beforeCanonicalWake); assert.equal(revision(fixture), 4); const clean = await host.run(fixture.repoId, { kind: "doc-status", paths: ["tasks/task-doc-docs/progress.md"] }, auth); assert.equal(JSON.parse(clean.evidence!.slice("doc-scan:".length)).rows[0].state, "clean");
    const before = watcherScans(host); atomicSave(fixture.rootDir, "tasks/task-doc-docs/progress.md", "# Progress\n\nmanual edit\n"); await waitFor(() => watcherScans(host) > before); assert.equal(revision(fixture), 4); const status = await host.run(fixture.repoId, { kind: "doc-status", paths: ["tasks/task-doc-docs/progress.md"] }, auth); assert.equal(JSON.parse(status.evidence!.slice("doc-scan:".length)).rows[0].state, "blocked"); assert.equal(status.detail?.unresolvedTouches[0]?.requiredRoute, "task-progress-append");
    for (const [file, route, body] of [["INDEX.md", "task-lifecycle", "# hand edit\n"], ["task-contract.json", "task-contract-upgrade", "{}\n"], ["facts.md", "ha fact record --help", "# hand edit\n"], ["executions/manual.md", "task-lifecycle", "# hand edit\n"], ["reviews/manual.md", "task-review-execution", "# hand edit\n"], ["code-doc-anchors.json", "task-code-doc-reconcile", "{}\n"]] as const) { const scans = watcherScans(host), logical = `tasks/task-doc-docs/${file}`; atomicSave(fixture.rootDir, logical, body); await waitFor(() => watcherScans(host) > scans); const blocked = await host.run(fixture.repoId, { kind: "doc-status", paths: [logical] }, auth); assert.equal(JSON.parse(blocked.evidence!.slice("doc-scan:".length)).rows[0].state, "blocked"); assert.equal(blocked.detail?.unresolvedTouches[0]?.requiredRoute, route); assert.equal(revision(fixture), 4); }
  } finally { await host.close(); fixture.close(); }
});

test("Decision watcher blocks new, frontmatter, and mixed edits but publishes body-only prose", async () => {
  const fixture = repoFixture("decision-regions"), host = await openDaemonHost({ daemonId: "watch-decision-regions", userRoot: fixture.userRoot, watchOwnerUid: fixture.uid, watchDebounceMs: 2 }), auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: fixture.uid, source: "unix-socket-filesystem-owner-boundary" } } as const;
  try { const proposal = { kind: "decision-propose", jsonInput: JSON.stringify({ title: "Watcher Decision", question: "May only prose pass the watcher?", riskTier: "medium", urgency: "medium", vertical: "default", preset: "default", decisionClass: "ordinary", appliesTo: { modules: ["daemon"], productLines: [] }, chosen: [{ id: "CH1", text: "Publish prose" }], rejected: [{ id: "RJ1", text: "Publish frontmatter", whyNot: "Typed events own it" }], claims: [], fulfillments: [], relations: [] }) } as const, proposed = await host.run(fixture.repoId, proposal, auth), decisionId = (JSON.parse(String(proposed.evidence)) as { decisionId: string }).decisionId, logical = `decisions/decision-${decisionId}/decision.md`, canonical = readFileSync(path.join(fixture.rootDir, "harness", logical), "utf8"), rogue = "decisions/decision-dec_ROGUE_E9_ALPHA/decision.md";
    const blocked = async (target: string, body: string) => { const before = watcherScans(host); atomicSave(fixture.rootDir, target, body); await waitFor(() => watcherScans(host) > before); const receipt = await host.run(fixture.repoId, { kind: "doc-status", paths: [target] }, auth), report = JSON.parse(String(receipt.evidence).slice("doc-scan:".length)) as { rows: readonly { state: string }[] }; assert.equal(report.rows[0]?.state, "blocked", target); assert.equal(receipt.detail?.unresolvedTouches[0]?.requiredRoute, "ha decision --help"); };
    await blocked(rogue, "# Rogue Decision\n"); rmSync(path.join(fixture.rootDir, "harness", rogue)); await blocked(logical, canonical.replace("state: proposed", "state: active")); await blocked(logical, canonical.replace("state: proposed", "state: active").replace("# Watcher Decision", "# Watcher Decision\n\nMixed prose"));
    const bodyOnly = canonical.replace("# Watcher Decision\n", "# Watcher Decision\n\nBody-only watcher prose.\n"); atomicSave(fixture.rootDir, logical, bodyOnly); await waitFor(() => revision(fixture) === 2); const shown = JSON.parse(String((await host.run(fixture.repoId, { kind: "decision-show", decisionId, includeBody: true }, auth)).evidence)) as { decision: { body: { body: string } } }; assert.match(shown.decision.body.body, /Body-only watcher prose/u); assert.equal(makeTaskEventStore({ repoId: fixture.repoId, rootDir: fixture.rootDir }).read().events[1]?.schema, "doc-event/v1");
  } finally { await host.close(); fixture.close(); }
});

test("loopback duplicate and out-of-order wakes converge for two zero-work rounds", async () => {
  const current = "a".repeat(64); let canonical = "b".repeat(64); const actions: string[] = [];
  const watcher = openDocSyncWatcher({ rootDir: process.cwd(), personId: "person-owner", watchFilesystem: false, startupScan: false, debounceMs: 1,
    run: async (action) => { actions.push(action.kind); if (action.kind === "doc-submit") { canonical = current; return applied("submit"); } return scan("c".repeat(40), [{ path: "context/loop.md", state: current === canonical ? "clean" : "eligible", candidateBlobSha256: current }]); } });
  try { watcher.wake("context/loop.md"); await watcher.flush(); const afterWrite = watcher.status().metrics; watcher.wake("context/loop.md"); watcher.wake("context/loop.md"); watcher.overflow(); await watcher.flush(); watcher.overflow(); await watcher.flush();
    assert.deepEqual(watcher.status().metrics, { ...afterWrite, scans: afterWrite.scans + 2 }); assert.equal(actions.filter((kind) => kind === "doc-submit").length, 1);
  } finally { await watcher.close(); }
});

test("stale watch submission refreshes status and dry-run base before a new opId", async () => {
  let base = "a".repeat(40), submits = 0; const opIds: string[] = [], watcher = openDocSyncWatcher({ rootDir: process.cwd(), personId: "person-owner", watchFilesystem: false, startupScan: false, debounceMs: 1,
    run: async (action) => { if (action.kind === "doc-dry-run") return scan(base, [{ path: "context/rebase.md", state: "eligible", candidateBlobSha256: "c".repeat(64) }]); submits += 1; if (submits === 1) { base = "b".repeat(40); return { outcome: "rejected", opId: "op-stale", code: "base_ledger_changed", origin: "doc-sync-contract", evidence: "contract-rejection:base_ledger_changed", nextAction: "run ha doc status, then ha doc sync --dry-run with the path and resubmit a new opId" }; } opIds.push("op-rebased"); return applied("op-rebased"); } });
  try { watcher.wake("context/rebase.md"); await watcher.flush(); assert.equal(submits, 2); assert.deepEqual(opIds, ["op-rebased"]); assert.equal(watcher.status().lastReceipt?.opId, "op-rebased"); assert.deepEqual(watcher.status().metrics, { scans: 4, intents: 2, commits: 1, writes: 1 }); }
  finally { await watcher.close(); }
});

test("watch admission fails closed when the queued path fingerprint changes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-watch-fingerprint-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("watch-fingerprint"), rootDir: canonicalRoot(rootDir), ownerId: "watch-fingerprint" }), body = "# Current\n", action = { kind: "doc-submit", paths: ["context/current.md"] } as const, source = { kind: "watch_session", sessionId: "watch-session", path: "context/current.md", fingerprint: "f".repeat(64) } as const;
  try { atomicSave(rootDir, "context/current.md", body); const rejected = await cell.run(action, { actor: { principal: { personId: "person-owner" }, executor: null }, source }); assert.equal(rejected.outcome, "rejected"); assert.equal(rejected.code, "watch_fingerprint_changed"); assert.equal(makeTaskEventStore({ repoId: "watch-fingerprint", rootDir }).read().revision, 0); const accepted = await cell.run(action, { actor: { principal: { personId: "person-owner" }, executor: null }, source: { ...source, fingerprint: sha256Text(body) } }); assert.equal(accepted.outcome, "applied", JSON.stringify(accepted)); }
  finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("canonical publication preserves a concurrent local copy and status gives the rebase route", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-watch-conflict-")); initRepo(rootDir); const cell = await openRepoCell({ repoId: workspaceId("watch-conflict"), rootDir: canonicalRoot(rootDir), ownerId: "watch-conflict" }), binding = { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const }, logical = "tasks/task-conflict-canonical/task_plan.md", local = "# Local draft\n\nKeep me.\n";
  try { atomicSave(rootDir, logical, local); const created = await cell.run({ kind: "task-create", taskId: "task-conflict", title: "Canonical" }, binding); assert.equal(created.outcome, "applied", JSON.stringify(created)); const directory = path.join(rootDir, "harness/tasks/task-conflict-canonical"), scratch = readdirSync(directory).find((name) => /^task_plan\.conflict-[0-9a-f]{8}\.md$/u.test(name)); assert.ok(scratch); assert.equal(readFileSync(path.join(directory, scratch), "utf8"), local); assert.equal(git(rootDir, "status", "--porcelain", "-uall").includes("conflict-"), false);
    const status = await cell.run({ kind: "doc-status", paths: [logical] }, binding), report = JSON.parse(status.evidence!.slice("doc-scan:".length)) as { rows: readonly { state: string; conflicts: readonly string[] }[] }; assert.equal(report.rows[0]?.state, "conflict"); assert.equal(report.rows[0]?.conflicts[0]?.endsWith(scratch), true); assert.match(status.detail?.nextAction ?? "", /dry-run.*new opId|conflict/iu);
  } finally { await cell.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("SIGKILL after canonical ref advance restarts the watcher and converges without a duplicate", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-watch-kill-")); initRepo(rootDir); atomicSave(rootDir, "context/kill.md", "# Kill\n\nrecover me\n"); const repoCellUrl = new URL("../src/repo-cell.ts", import.meta.url).href, watcherUrl = new URL("../src/doc-sync-watcher.ts", import.meta.url).href, protocolUrl = new URL("../src/protocol/daemon-protocol.contract.ts", import.meta.url).href;
  try { const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", [`import { openRepoCell } from ${JSON.stringify(repoCellUrl)};`, `import { openDocSyncWatcher } from ${JSON.stringify(watcherUrl)};`, `import { canonicalRoot, workspaceId } from ${JSON.stringify(protocolUrl)};`, "const actor={principal:{personId:'person-owner'},executor:null};", "const cell=await openRepoCell({repoId:workspaceId('watch-kill'),rootDir:canonicalRoot(process.env.HA_WATCH_ROOT),ownerId:'killed',killpoint:(point)=>{if(point==='after_git_commit')process.kill(process.pid,'SIGKILL')}});", "const watcher=openDocSyncWatcher({rootDir:process.env.HA_WATCH_ROOT,personId:'person-owner',watchFilesystem:false,debounceMs:1,run:(action,attribution)=>cell.run(action,attribution?{actor,source:{kind:'watch_session',sessionId:attribution.sessionId,path:attribution.path,fingerprint:attribution.fingerprint}}:{actor,source:'local'})});", "await watcher.flush();"].join("\n")], { encoding: "utf8", env: { ...process.env, HA_WATCH_ROOT: rootDir } }); assert.equal(child.signal, "SIGKILL", child.stderr);
    const cell = await openRepoCell({ repoId: workspaceId("watch-kill"), rootDir: canonicalRoot(rootDir), ownerId: "restarted" }); try { const watcher = openDocSyncWatcher({ rootDir, personId: "person-owner", watchFilesystem: false, debounceMs: 1, run: (action, attribution) => cell.run(action, attribution ? { actor: { principal: { personId: "person-owner" }, executor: null }, source: { kind: "watch_session", sessionId: attribution.sessionId, path: attribution.path, fingerprint: attribution.fingerprint } } : { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" }) }); await watcher.flush(); assert.equal(makeTaskEventStore({ repoId: "watch-kill", rootDir }).read().revision, 1); assert.deepEqual(watcher.status().metrics, { scans: 1, intents: 0, commits: 0, writes: 0 }); assert.equal(git(rootDir, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/"), ""); await watcher.close(); } finally { await cell.close(); }
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("watch session concurrent editing soak remains single-writer and convergent", async (context) => {
  const fixture = repoFixture("soak"), host = await openDaemonHost({ daemonId: "watch-soak", userRoot: fixture.userRoot, watchOwnerUid: fixture.uid, watchDebounceMs: 1 }), rounds = 24, started = performance.now();
  try { for (let round = 1; round <= rounds; round += 1) { atomicSave(fixture.rootDir, "context/soak.md", `# Soak\n\neditor-a ${round}\n`); atomicSave(fixture.rootDir, "context/soak.md", `# Soak\n\neditor-b ${round}\n`); await waitFor(() => watcherCommits(host) === round); }
    await waitFor(() => git(fixture.rootDir, "diff", "--name-only", "--", "harness") === ""); const elapsedMs = performance.now() - started; context.diagnostic(`watch-soak rounds=${rounds} edits=${rounds * 2} durationMs=${elapsedMs.toFixed(1)}`); assert.equal(revision(fixture), rounds); assert.equal(makeTaskEventStore({ repoId: fixture.repoId, rootDir: fixture.rootDir }).read().events.every((event) => typeof event.source === "object" && event.source.kind === "watch_session"), true);
  } finally { await host.close(); fixture.close(); }
});

function scan(baseLedgerSha: string, rows: readonly { path: string; state: string; candidateBlobSha256: string }[]): WriteReceipt { return { outcome: "applied", opId: `scan:${baseLedgerSha}`, revision: 0, evidence: `doc-scan:${JSON.stringify({ baseLedgerSha, rows: rows.map((row) => ({ ...row, reason: null, baseBlobSha256: null, size: 1, mediaType: "text/markdown" })) })}`, visibility: "center", proof: { committedRevision: 0, appliedCut: 0, durable: true, canonicalVisible: true, worktreeVisible: false } }; }
function applied(opId: string): WriteReceipt { return { outcome: "applied", opId, revision: 1, evidence: `event-object:${opId}`, visibility: "center", proof: { committedRevision: 1, appliedCut: 1, durable: true, canonicalVisible: true, worktreeVisible: true } }; }
function repoFixture(repoId: string) { const parent = mkdtempSync(path.join(tmpdir(), `ha-watch-${repoId}-`)), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"), uid = process.getuid?.() ?? 0; mkdirSync(path.join(rootDir, "harness/context"), { recursive: true }); initRepo(rootDir);
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`); writeFileSync(path.join(rootDir, "harness/people.yaml"), `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "person-owner", displayName: "Owner", roles: ["writer"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }] }], roles: [{ roleId: "writer", commandClasses: ["repo-read", "repo-write"] }] }, null, 2)}\n`); git(rootDir, "add", "harness"); git(rootDir, "commit", "-qm", "harness"); registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false }); return { repoId, rootDir, userRoot, uid, close: () => rmSync(parent, { recursive: true, force: true }) }; }
function atomicSave(rootDir: string, relative: string, body: string): void { const target = path.join(rootDir, "harness", relative), temporary = `${target}.vim-tmp`; mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(temporary, body); renameSync(temporary, target); }
function revision(fixture: { repoId: string; rootDir: string }): number { return makeTaskEventStore({ repoId: fixture.repoId, rootDir: fixture.rootDir }).readHead()?.revision ?? 0; }
function watcherCommits(host: Awaited<ReturnType<typeof openDaemonHost>>): number { return (host.status().repos[0] as { docSync?: { metrics: { commits: number } } } | undefined)?.docSync?.metrics.commits ?? -1; }
function watcherScans(host: Awaited<ReturnType<typeof openDaemonHost>>): number { return (host.status().repos[0] as { docSync?: { metrics: { scans: number } } } | undefined)?.docSync?.metrics.scans ?? -1; }
async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> { const deadline = Date.now() + timeoutMs; while (!check()) { if (Date.now() >= deadline) assert.fail("watcher did not converge before timeout"); await new Promise((resolve) => setTimeout(resolve, 10)); } }
function initRepo(rootDir: string): void { git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Watcher Test"); git(rootDir, "config", "user.email", "watcher@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
