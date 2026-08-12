// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpc } from "../../daemon/src/client/local-json-rpc-client.ts";
import { canonicalRoot, workspaceId } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../../daemon/src/repo-cell.ts";

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
    assert.match(String(run(fixture.alpha, fixture.userRoot, ["task", "show", "task-alpha"]).evidence), /Alpha/u);
    for (const root of [fixture.alpha, fixture.beta]) {
      assert.equal(git(root, "rev-list", "--count", "HEAD"), "2");
      assert.equal(readdirSync(path.join(root, "harness/events")).filter((name) => name.startsWith("op_")).length, 1);
      assert.equal(existsSync(path.join(root, ".harness/cache/task.sqlite")), true);
      assert.equal(existsSync(path.join(root, ".harness/write-journal")), false);
    }
    const spoof = await requestLocalDaemonJsonRpc(fixture.alpha, "repo.task.run", { repo: { repoId: "alpha" },
      payload: { action: { kind: "task-create", taskId: "task-spoof", title: "Spoof", actor: { principal: { personId: "attacker" } } } } }, 100,
    { userRoot: fixture.userRoot });
    assert.equal(spoof.ok, false); assert.equal((spoof.error as { code?: string }).code, "ingress_binding_forbidden");
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
      const response = await requestLocalDaemonJsonRpc(fixture.alpha, "repo.task.run", { repo: { repoId: "alpha" },
        payload: { action: { kind: "task-create", taskId: `task-daemon-latency-${index}`, title: `Daemon latency ${index}` } } }, 1_000,
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
