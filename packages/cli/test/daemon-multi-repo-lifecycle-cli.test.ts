// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpc } from "../../daemon/src/client/local-json-rpc-client.ts";
import { canonicalRoot, workspaceId } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../../daemon/src/repo-cell.ts";
import { readDaemonPid } from "../../daemon/src/runtime.ts";
import { makeTaskEventStore } from "../../kernel/src/index.ts";

const cli = path.resolve("packages/cli/src/index.ts");
const builtCli = path.resolve("packages/cli/dist/cli/src/index.js");

test("real CLI reaches one resident multi-workspace daemon and publishes Git event -> SQLite -> receipt", async () => {
  const fixture = setup();
  try {
    const noDaemon = runMaybe(fixture.alpha, fixture.userRoot, ["daemon", "repo", "register", "--repo-id", "alpha", "--root", fixture.alpha, "--no-link"]);
    assert.notEqual(noDaemon.status, 0); assert.equal((noDaemon.receipt.error as { code?: string }).code, "daemon_unavailable");
    assert.equal(existsSync(path.join(fixture.userRoot, "registry.json")), false);
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.alpha, fixture.userRoot, "alpha"); register(fixture.beta, fixture.userRoot, "beta");
    const alpha = run(fixture.alpha, fixture.userRoot, ["task", "create", "--task-id", "task-alpha", "--title", "Alpha"]);
    const beta = run(fixture.beta, fixture.userRoot, ["task", "create", "--task-id", "task-beta", "--title", "Beta"]);
    assert.equal(alpha.outcome, "applied", JSON.stringify(alpha)); assert.equal(beta.outcome, "applied", JSON.stringify(beta));
    const factRecord = run(fixture.alpha, fixture.userRoot, ["fact", "record", "--task", "task-alpha", "--statement", "Canonical Fact from CLI", "--source", "integration"]);
    assert.equal(factRecord.outcome, "applied", JSON.stringify(factRecord)); const fact = JSON.parse(String(factRecord.evidence)) as { factId: string; state: string };
    assert.equal(fact.state, "live"); const factSearch = JSON.parse(String(run(fixture.alpha, fixture.userRoot, ["fact", "search", "Canonical", "--task", "task-alpha"]).evidence)) as { facts: readonly { factId: string }[] };
    assert.deepEqual(factSearch.facts.map((row) => row.factId), [fact.factId]); const factShow = JSON.parse(String(run(fixture.alpha, fixture.userRoot, ["fact", "show", "--task", "task-alpha", "--id", fact.factId]).evidence)) as { fact: { statement: string } };
    assert.equal(factShow.fact.statement, "Canonical Fact from CLI"); assert.equal(git(fixture.alpha, "grep", "-l", "fact-event/v1", "refs/ha/canonical", "--", "harness/events" ).includes("harness/events"), true);
    const decisionPropose = run(fixture.alpha, fixture.userRoot, ["decision", "propose", "--title", "Canonical Decision from CLI", "--question", "Should the real CLI own this Decision?", "--chosen", '{"id":"CH1","text":"Use events"}', "--rejected", '{"id":"RJ1","text":"Use files","whyNot":"Not canonical"}', "--module", "kernel"]); assert.equal(decisionPropose.outcome, "applied", JSON.stringify(decisionPropose));
    const decision = JSON.parse(String(decisionPropose.evidence)) as { decisionId: string; state: string }, beforeRejected = makeTaskEventStore({ rootDir: fixture.alpha, repoId: "alpha" }).readHead()!.revision; assert.equal(decision.state, "proposed");
    const rejectedDecision = runMaybe(fixture.alpha, fixture.userRoot, ["decision", "accept", decision.decisionId, "--rationale", "Self approval is forbidden"]); assert.notEqual(rejectedDecision.status, 0); assert.deepEqual({ outcome: rejectedDecision.receipt.outcome, code: (rejectedDecision.receipt.error as { code?: string }).code }, { outcome: "rejected", code: "invalid_transition" }); assert.equal(makeTaskEventStore({ rootDir: fixture.alpha, repoId: "alpha" }).readHead()?.revision, beforeRejected);
    const decisionSearch = JSON.parse(String(run(fixture.alpha, fixture.userRoot, ["decision", "search", "Canonical Decision"]).evidence)) as { decisions: readonly { decisionId: string }[] }; assert.deepEqual(decisionSearch.decisions.map((row) => row.decisionId), [decision.decisionId]);
    const decisionShow = JSON.parse(String(run(fixture.alpha, fixture.userRoot, ["decision", "show", decision.decisionId]).evidence)) as { decision: { decisionId: string; body: unknown } }; assert.equal(decisionShow.decision.decisionId, decision.decisionId); assert.equal(decisionShow.decision.body, null);
    const reckon = run(fixture.alpha, fixture.userRoot, ["decision", "reckon", decision.decisionId, "--task", "task-alpha"]); assert.equal(reckon.outcome, "applied", JSON.stringify(reckon)); const reckonFact = JSON.parse(String(reckon.evidence)) as { evidenceSource: string; statement: string };
    assert.match(reckonFact.evidenceSource, new RegExp(`^decision/${decision.decisionId}@\\d+$`, "u")); assert.match(reckonFact.statement, /no load-bearing claims/u); const canonicalEvents = makeTaskEventStore({ rootDir: fixture.alpha, repoId: "alpha" }).read().events; assert.equal(canonicalEvents.some((event) => event.schema === "decision-event/v1" && event.decisionId === decision.decisionId), true); assert.equal(canonicalEvents.some((event) => event.schema === "fact-event/v1" && event.payload.evidenceSource === reckonFact.evidenceSource), true);
    assert.match(String(run(fixture.alpha, fixture.userRoot, ["task", "show", "task-alpha"]).evidence), /Alpha/u);
    assert.equal(run(fixture.alpha, fixture.userRoot, ["task", "start", "task-alpha", "--execution-id", "exec-doc"]).outcome, "applied");
    const docPath = "tasks/task-alpha/INDEX.md", docBody = "# CLI canonical document\n", authored = path.join(fixture.alpha, "harness", docPath); mkdirSync(path.dirname(authored), { recursive: true }); writeFileSync(authored, docBody);
    const docStatus = run(fixture.alpha, fixture.userRoot, ["doc", "status", "--path", docPath]), base = (docStatus.detail as { baseLedgerSha: string }).baseLedgerSha;
    assert.equal(run(fixture.alpha, fixture.userRoot, ["doc", "sync", "--submit", "--execution-id", "exec-doc", "--base-ledger-sha", base, "--path", docPath]).outcome, "applied");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["doc", "show", "--path", docPath]).evidence, docBody);
    for (const root of [fixture.alpha, fixture.beta]) {
      assert.equal(git(root, "rev-list", "--count", "refs/ha/canonical"), root === fixture.alpha ? "7" : "2");
      assert.equal(git(root, "ls-tree", "--name-only", "refs/ha/canonical", "harness/events").includes("harness/events"), true);
      assert.equal(existsSync(path.join(root, ".harness/cache/task.sqlite")), true);
      assert.equal(existsSync(path.join(root, ".harness/write-journal")), false);
    }
    const spoof = await requestLocalDaemonJsonRpc(fixture.alpha, "repo.task.create", { repo: { repoId: "alpha" },
      payload: { taskId: "task-spoof", title: "Spoof", actor: { principal: { personId: "attacker" } } } }, 100,
    { userRoot: fixture.userRoot });
    assert.equal(spoof.ok, false); assert.equal((spoof.error as { code?: string }).code, "invalid_request");
  } finally { stop(fixture.alpha, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("explicit daemon bootstraps an empty workspace before its first lifecycle write", () => {
  const fixture = setupEmpty();
  try {
    const before = runMaybe(fixture.repo, fixture.userRoot,
      ["init", "--repo-id", "fresh", "--person-id", "owner", "--display-name", "Owner"]);
    assert.notEqual(before.status, 0); assert.equal(existsSync(path.join(fixture.repo, "harness")), false);
    assert.equal(run(fixture.repo, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const initialized = run(fixture.repo, fixture.userRoot,
      ["init", "--repo-id", "fresh", "--person-id", "owner", "--display-name", "Owner"]);
    assert.equal(initialized.ok, true); assert.equal(initialized.repoId, "fresh");
    assert.equal(existsSync(path.join(fixture.repo, "harness/harness.yaml")), true);
    assert.equal(git(fixture.repo, "rev-list", "--count", "HEAD"), "1");
    assert.equal(run(fixture.repo, fixture.userRoot,
      ["task", "create", "--task-id", "task-first", "--title", "First task"]).outcome, "applied");
  } finally { stop(fixture.repo, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("real CLI dogfoods a user-layer v3 preset through daemon phases and RepoCell produce", () => {
  const fixture = setup(), source = makeCanary(fixture.root);
  try {
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true); register(fixture.alpha, fixture.userRoot, "alpha"); assert.equal(run(fixture.alpha, fixture.userRoot, ["preset", "install", "--source", source]).outcome, "applied");
    const result = spawnSync(process.execPath, [cli, "--root", fixture.alpha, "script", "run", "preset:user-canary/create", "--idempotency-key", "dogfood", "--inputs", '{"title":"Daemon canary"}'], { encoding: "utf8", env: { ...process.env, HOME: path.join(fixture.alpha, ".home"), GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: fixture.userRoot } });
    assert.equal(result.status, 0, result.stderr); const output = result.stdout.trim().split("\n"); for (const phase of ["admitted", "spawned", "running", "publishing", "applied"]) assert.equal(output.some((line) => line.includes(`preset-run-start: ${phase}`)), true, `${phase}: ${result.stdout}`); assert.match(String(run(fixture.alpha, fixture.userRoot, ["task", "show", "task-canary"]).evidence), /Daemon canary/u);
    const childEvent = makeTaskEventStore({ rootDir: fixture.alpha, repoId: "alpha" }).read().events.find((event) => event.schema === "task-bootstrap-event/v1" && event.taskId === "task-canary"); assert.ok(childEvent); const producedReceipt = run(fixture.alpha, fixture.userRoot, ["receipt", "show", childEvent.opId]), directReceipt = run(fixture.alpha, fixture.userRoot, ["task", "create", "--task-id", "task-direct", "--title", "Direct"]), producedProof = producedReceipt.proof as Record<string, unknown>, directProof = directReceipt.proof as Record<string, unknown>; assert.deepEqual({ outcome: producedReceipt.outcome, visibility: producedReceipt.visibility, proofFields: Object.keys(producedProof).sort(), durable: producedProof.durable, canonicalVisible: producedProof.canonicalVisible }, { outcome: directReceipt.outcome, visibility: directReceipt.visibility, proofFields: Object.keys(directProof).sort(), durable: directProof.durable, canonicalVisible: directProof.canonicalVisible }); assert.equal(git(fixture.alpha, "rev-list", "--count", "refs/ha/canonical"), "3");
  } finally { stop(fixture.alpha, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("hard daemon crash projects an admitted child to outcome_unknown without respawn", async () => {
  const fixture = setup(), source = makeCanary(fixture.root, "setTimeout(() => process.exit(0), 2_000);", []);
  try {
    run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]); register(fixture.alpha, fixture.userRoot, "alpha"); run(fixture.alpha, fixture.userRoot, ["preset", "install", "--source", source]); const params = { repo: { repoId: "alpha" }, payload: { presetId: "user-canary", entrypoint: "create", inputs: { title: "Crash" }, idempotencyKey: "crash-once" } }, started = await requestLocalDaemonJsonRpc(fixture.alpha, "repo.preset.run.start", params, 1_000, { userRoot: fixture.userRoot }); assert.equal(started.phase, "admitted"); await waitForRun(fixture.alpha, fixture.userRoot, String(started.runId), "running"); const pid = readDaemonPid(fixture.userRoot, "default"); assert.ok(pid); process.kill(pid, "SIGKILL"); await new Promise((resolve) => setTimeout(resolve, 50)); run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]); const unknown = await requestLocalDaemonJsonRpc(fixture.alpha, "repo.preset.run.status", { repo: { repoId: "alpha" }, payload: { runId: started.runId } }, 1_000, { userRoot: fixture.userRoot }); assert.equal(unknown.outcome, "outcome_unknown", JSON.stringify(unknown)); assert.equal((unknown.phases as string[]).filter((phase) => phase === "spawned").length, 1);
  } finally { stop(fixture.alpha, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("one RepoCell lock failure closes only that repo admission", async () => {
  const fixture = setup(); let held: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    held = await openRepoCell({ repoId: workspaceId("held-alpha"), rootDir: canonicalRoot(fixture.alpha), ownerId: "external-writer" });
    run(fixture.beta, fixture.userRoot, ["daemon", "start", "--service"]);
    register(fixture.alpha, fixture.userRoot, "alpha"); register(fixture.beta, fixture.userRoot, "beta");
    const status = run(fixture.beta, fixture.userRoot, ["daemon", "status"]);
    const repos = status.repos as Array<{ repoId: string; state: string }>;
    assert.deepEqual(repos.map(({ repoId, state }) => [repoId, state]), [["alpha", "unavailable"], ["beta", "attached"]]);
    const blocked = runMaybe(fixture.alpha, fixture.userRoot, ["task", "create", "--task-id", "task-blocked", "--title", "Blocked"]);
    assert.notEqual(blocked.status, 0); assert.equal((blocked.receipt.error as { code?: string }).code, "repo_unavailable");
    assert.equal(run(fixture.beta, fixture.userRoot, ["task", "create", "--task-id", "task-live", "--title", "Live"]).outcome, "applied");
  } finally { stop(fixture.beta, fixture.userRoot); await held?.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("resident daemon CLI write p50 includes process startup through parsed receipt", async (context) => {
  const fixture = setup();
  try {
    execFileSync("npm", ["run", "build", "--workspace", "@harness-anything/cli"], { cwd: process.cwd(), stdio: "pipe" });
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"], builtCli).ok, true);
    register(fixture.alpha, fixture.userRoot, "alpha", builtCli);
    const daemonSamples: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const started = performance.now();
      const response = await requestLocalDaemonJsonRpc(fixture.alpha, "repo.task.create", { repo: { repoId: "alpha" },
        payload: { taskId: `task-daemon-latency-${index}`, title: `Daemon latency ${index}` } }, 1_000,
      { userRoot: fixture.userRoot });
      daemonSamples.push(performance.now() - started);
      assert.equal(response.ok, true, JSON.stringify(response));
    }
    const samples: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const started = performance.now();
      const receipt = run(fixture.alpha, fixture.userRoot,
        ["task", "create", "--task-id", `task-latency-${index}`, "--title", `Latency ${index}`], builtCli);
      samples.push(performance.now() - started);
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    }
    const ordered = [...samples].sort((left, right) => left - right), p50 = ordered[Math.floor(ordered.length / 2)]!;
    const daemonOrdered = [...daemonSamples].sort((left, right) => left - right), daemonP50 = daemonOrdered[Math.floor(daemonOrdered.length / 2)]!;
    context.diagnostic(`latency-window=before-cli-process-spawn-through-exit-and-parsed-receipt daemon=resident samples=${samples.length} p50=${p50.toFixed(3)}ms min=${ordered[0]!.toFixed(3)}ms max=${ordered.at(-1)!.toFixed(3)}ms`);
    context.diagnostic(`latency-segment=resident-daemon-socket-through-parsed-receipt samples=${daemonSamples.length} p50=${daemonP50.toFixed(3)}ms min=${daemonOrdered[0]!.toFixed(3)}ms max=${daemonOrdered.at(-1)!.toFixed(3)}ms inferred-cli-process-startup-parse-render-p50=${(p50 - daemonP50).toFixed(3)}ms`);
    assert.equal(p50 <= 300, true, `built resident daemon CLI write p50 was ${p50.toFixed(3)}ms`);
  } finally { stop(fixture.alpha, fixture.userRoot, builtCli); rmSync(fixture.root, { recursive: true, force: true }); }
});

function setup(): { root: string; userRoot: string; alpha: string; beta: string } { const root = mkdtempSync(path.join(tmpdir(), "ha-w3-"));
  const alpha = path.join(root, "alpha"), beta = path.join(root, "beta"), userRoot = path.join(root, "user");
  for (const repo of [alpha, beta]) initialize(repo); return { root, userRoot, alpha, beta }; }
function setupEmpty(): { root: string; userRoot: string; repo: string } { const root = mkdtempSync(path.join(tmpdir(), "ha-w3-init-"));
  const repo = path.join(root, "repo"), userRoot = path.join(root, "user"); mkdirSync(repo); return { root, userRoot, repo }; }
function makeCanary(root: string, script = 'const { title } = JSON.parse(process.env.HA_PRESET_INPUT); console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [{ capabilityId: "policy:task-create/v1", payload: { taskId: "task-canary", title } }] }));\n', produces: readonly Record<string, string>[] = [{ id: "policy:task-create/v1", kind: "command", version: "1" }]): string { const source = path.join(root, "user-canary"); mkdirSync(path.join(source, "scripts"), { recursive: true }); writeFileSync(path.join(source, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: Daemon canary\nwhenToUse: Verify the typed process route.\n---\n# Canary\n"); writeFileSync(path.join(source, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3", id: "user-canary", title: "User Canary", vertical: "software/coding", version: "3.0.0", kind: "process-action", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0" }, capabilityImports: [], entrypoints: { create: { type: "script", intent: "Create one task", inputs: [{ name: "title", type: "string", required: true }], requires: [], produces, sideEffects: [], command: "scripts/create.mjs" } }, profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }], defaultProfile: "baseline" })); writeFileSync(path.join(source, "scripts/create.mjs"), script); return source; }
async function waitForRun(root: string, userRoot: string, runId: string, phase: string): Promise<void> { for (let attempt = 0; attempt < 100; attempt += 1) { const status = await requestLocalDaemonJsonRpc(root, "repo.preset.run.status", { repo: { repoId: "alpha" }, payload: { runId } }, 1_000, { userRoot }); if (status.phase === phase) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error(`run ${runId} did not reach ${phase}`); }
function initialize(root: string): void { mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  writeFileSync(path.join(root, "harness/people.yaml"), `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`, "utf8");
  git(root, "init", "--quiet"); git(root, "config", "user.name", "W3 Test"); git(root, "config", "user.email", "w3@example.test");
  git(root, "add", "harness/harness.yaml", "harness/people.yaml"); git(root, "commit", "--quiet", "-m", "fixture"); }
function register(root: string, userRoot: string, repoId: string, entry = cli): void { assert.equal(run(root, userRoot,
  ["daemon", "repo", "register", "--repo-id", repoId, "--root", root, "--no-link"], entry).ok, true); }
function run(root: string, userRoot: string, args: readonly string[], entry = cli): Record<string, unknown> { const result = runMaybe(root, userRoot, args, entry);
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`); return result.receipt; }
function runMaybe(root: string, userRoot: string, args: readonly string[], entry = cli): { status: number | null; receipt: Record<string, unknown>; stderr: string } {
  const result = spawnSync(process.execPath, [entry, "--root", root, "--json", ...args], { encoding: "utf8", env: { ...process.env,
    HOME: path.join(root, ".home"), GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: userRoot } });
  return { status: result.status, receipt: JSON.parse(result.stdout) as Record<string, unknown>, stderr: result.stderr }; }
function stop(root: string, userRoot: string, entry = cli): void { spawnSync(process.execPath, [entry, "--root", root, "--json", "daemon", "stop"],
  { encoding: "utf8", env: { ...process.env, HARNESS_DAEMON_USER_ROOT: userRoot } }); }
function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
