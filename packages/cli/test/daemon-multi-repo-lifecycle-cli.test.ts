// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const alphaPreview = run(fixture.alpha, fixture.userRoot, ["task", "create", "--task-id", "task-alpha", "--title", "Alpha", "--dry-run"]); assert.equal(alphaPreview.dryRun, true); assert.equal(alphaPreview.packagePath, "tasks/task-alpha-alpha"); assert.equal(existsSync(path.join(fixture.alpha, "harness/tasks/task-alpha-alpha")), false);
    const textPreview = spawnSync(process.execPath, [cli, "--root", fixture.alpha, "task", "create", "--task-id", "task-alpha", "--title", "Alpha", "--dry-run"], { encoding: "utf8", env: { ...process.env, HOME: path.join(fixture.alpha, ".home"), GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: fixture.userRoot } }); assert.equal(textPreview.status, 0, textPreview.stderr); assert.equal(textPreview.stdout.trim(), "would create task task-alpha at tasks/task-alpha-alpha");
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
    const progress = run(fixture.alpha, fixture.userRoot, ["task", "progress", "append", "task-alpha", "--text", "CLI progress is canonical.", "--evidence", "test:reports/cli.txt:passed"]); assert.equal(progress.progressPath, "tasks/task-alpha-alpha/progress.md"); assert.match(String(progress.commitSha), /^[0-9a-f]{40}$/u); assert.equal(progress.worktreeVisible, true); assert.match(String(progress.evidence), /file:tasks\/task-alpha-alpha\/progress\.md/u); assert.match(readFileSync(path.join(fixture.alpha, "harness/tasks/task-alpha-alpha/progress.md"), "utf8"), /CLI progress is canonical\..*Evidence: test:reports\/cli\.txt:passed/su);
    const docPath = "tasks/task-alpha-alpha/notes.md", docBody = "# CLI canonical document\n", authored = path.join(fixture.alpha, "harness", docPath); mkdirSync(path.dirname(authored), { recursive: true }); writeFileSync(authored, docBody);
    assert.equal(run(fixture.alpha, fixture.userRoot, ["doc", "status", "--path", docPath]).outcome, "applied");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["doc", "sync", "--submit", "--execution-id", "exec-doc", "--path", docPath]).outcome, "applied");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["doc", "show", "--path", docPath]).evidence, docBody);
    for (const root of [fixture.alpha, fixture.beta]) {
      assert.equal(git(root, "rev-list", "--count", "refs/ha/canonical"), root === fixture.alpha ? "8" : "2");
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

test("REQ-CTX-01..10 empty init publishes the canonical scaffold, authority parity, fixed receipt, and phantom-free Configure-Verify", () => {
  const fixture = setupEmpty();
  try {
    const before = runMaybe(fixture.repo, fixture.userRoot,
      ["init", "--repo-id", "fresh", "--person-id", "owner", "--display-name", "Owner"]);
    assert.notEqual(before.status, 0); assert.equal(existsSync(path.join(fixture.repo, "harness")), false);
    assert.equal(run(fixture.repo, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const initialized = run(fixture.repo, fixture.userRoot,
      ["init", "--repo-id", "fresh", "--person-id", "owner", "--display-name", "Owner", "--add-npm-scripts"]);
    assert.equal(initialized.ok, true); assert.equal(initialized.repoId, "fresh"); assert.equal(initialized.outcome, "applied"); assert.match(String(initialized.commit), /^[0-9a-f]{40}$/u);
    assert.deepEqual(initialized.created, ["harness/harness.yaml", "harness/people.yaml", "package.json", "harness/context/README.md", "harness/context/architecture/README.md", "harness/context/development/README.md", "harness/context/integrations/README.md", "harness/context/research/README.md", "harness/governance/standards/README.md", "harness/governance/standards/repository-governance.md", "harness/governance/standards/decision-writing.md", "harness/adr/README.md", "harness/milestones/README.md", "harness/governance/walls/walls.json", "harness/governance/walls/run-walls.mjs", "AGENTS.md", "CLAUDE.md"]); assert.deepEqual(initialized.updated, []); assert.deepEqual(initialized.preserved, []); assert.deepEqual(initialized.drifted, []);
    const plan = initialized.plan as { digest: string; baseScaffoldDigest: string; projectOverlayPath: string | null; projectOverlayDigest: string | null; documents: Array<{ path: string; contentSha256: string; disposition: string }> }; assert.match(plan.digest, /^sha256:[0-9a-f]{64}$/u); assert.match(plan.baseScaffoldDigest, /^sha256:[0-9a-f]{64}$/u); assert.equal(plan.projectOverlayPath, null); assert.equal(plan.projectOverlayDigest, null); assert.deepEqual(plan.documents.map(({ disposition }) => disposition), Array(14).fill("created")); assert.equal((initialized.publication as { ok: boolean }).ok, true);
    for (const target of initialized.created as string[]) assert.equal(existsSync(path.join(fixture.repo, target)), true, target); const defaultConfig = readFileSync(path.join(fixture.repo, "harness/harness.yaml"), "utf8"), people = readFileSync(path.join(fixture.repo, "harness/people.yaml"), "utf8"), architecture = readFileSync(path.join(fixture.repo, "harness/context/architecture/README.md"), "utf8"); assert.match(defaultConfig, /contextRoot: harness\/context\n  governanceRoot: harness\/governance\n  adrRoot: harness\/adr\n  milestonesRoot: harness\/milestones/u); assert.match(defaultConfig, /scaffolds:\n    task: governance\/task-scaffold\.json\n    repository: governance\/repository-scaffold\.json/u); assert.match(architecture, /Opt-in Boundary[\s\S]*does not create or enable an architecture manifest, model, or generated view/iu); assert.equal(existsSync(path.join(fixture.repo, "harness/context/architecture/manifest.json")), false); assert.equal(existsSync(path.join(fixture.repo, "harness/context/architecture/model")), false); assert.match(readFileSync(path.join(fixture.repo, "harness/adr/README.md"), "utf8"), /decision.*projection/isu); assert.match(readFileSync(path.join(fixture.repo, "harness/milestones/README.md"), "utf8"), /does not create.*status/isu); assert.match(readFileSync(path.join(fixture.repo, "AGENTS.md"), "utf8"), /harness\/governance\/standards\/README\.md/u); assert.match(readFileSync(path.join(fixture.repo, "CLAUDE.md"), "utf8"), /harness\/context\/README\.md/u); assert.equal(readFileSync(path.join(fixture.repo, "package.json"), "utf8"), `${JSON.stringify({ private: true, scripts: { "harness-anything": "harness-anything", ha: "ha", "harness-anything:check": "harness-anything check" } }, null, 2)}\n`); assert.equal(existsSync(path.join(fixture.repo, "harness/persons.yaml")), false); assert.equal(git(fixture.repo, "show", `${String(initialized.commit)}:harness/people.yaml`), people.trim());
    assert.equal(initialized.summary, "initialized harness at harness/harness.yaml"); assert.deepEqual((initialized.configureVerify as { ok: boolean; steps: string[] }).steps, ["publication-readback", "canonical-layout", "daemon-l2-readiness", "task-bootstrap-dry-run"]); assert.equal((initialized.configureVerify as { ok: boolean }).ok, true); assert.deepEqual((initialized.publication as { changedPaths: string[] }).changedPaths, initialized.created); assert.equal(git(fixture.repo, "ls-tree", "-r", "--name-only", "HEAD").split("\n").some((target) => target.startsWith("harness/tasks/") || target.startsWith("harness/events/")), false); assert.equal(makeTaskEventStore({ rootDir: fixture.repo, repoId: "fresh" }).read().revision, 0);
    const repeated = run(fixture.repo, fixture.userRoot, ["init", "--repo-id", "fresh", "--person-id", "owner", "--display-name", "Owner", "--add-npm-scripts"]); assert.equal(repeated.outcome, "noop"); assert.equal(repeated.commit, null); assert.deepEqual(repeated.created, []); assert.deepEqual(repeated.updated, []); assert.deepEqual(repeated.preserved, initialized.created); assert.equal(git(fixture.repo, "rev-list", "--count", "HEAD"), "1");
    const walls = spawnSync(process.execPath, [path.join(fixture.repo, "harness/governance/walls/run-walls.mjs")], { cwd: fixture.repo, encoding: "utf8" }); assert.equal(walls.status, 0, walls.stderr); assert.match(walls.stdout, /WALLS pass=0 red=0 expected=0 notice=0 info=0 total=0/u); assert.equal(existsSync(path.join(fixture.repo, "harness/governance/walls/reports")), false);
    const wallsPath = path.join(fixture.repo, "harness/governance/walls/walls.json"); writeFileSync(wallsPath, `${JSON.stringify({ schema: "walls/v1", walls: [{ id: "red", state: "guarding", cmd: "printf ''", expect: "hits>=1" }, { id: "notice", state: "known-issue", cmd: "printf 'fixed\\n'", expect: "hits>=1" }] }, null, 2)}\n`); const actionableWalls = spawnSync(process.execPath, [path.join(fixture.repo, "harness/governance/walls/run-walls.mjs")], { cwd: fixture.repo, encoding: "utf8" }); assert.equal(actionableWalls.status, 1, actionableWalls.stderr); assert.match(actionableWalls.stdout, /RED\s+red/u); assert.match(actionableWalls.stdout, /NOTICE\s+notice/u); assert.match(actionableWalls.stdout, /WALLS pass=0 red=1 expected=0 notice=1 info=0 total=2/u); assert.match(actionableWalls.stdout, /report: .*\/reports\/walls-/u); const reportsRoot = path.join(fixture.repo, "harness/governance/walls/reports"); assert.equal(existsSync(reportsRoot), true); assert.equal(execFileSync("find", [reportsRoot, "-type", "f"], { encoding: "utf8" }).trim().split("\n").length, 1);
    assert.equal(git(fixture.repo, "rev-list", "--count", "HEAD"), "1");
    const textReceipt = spawnSync(process.execPath, [cli, "--root", fixture.repo, "init", "--repo-id", "fresh", "--person-id", "owner", "--display-name", "Owner", "--add-npm-scripts"], { encoding: "utf8", env: { ...process.env, HOME: path.join(fixture.repo, ".home"), GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: fixture.userRoot } }); assert.equal(textReceipt.status, 0, textReceipt.stderr); assert.match(textReceipt.stdout, /^initialized harness at harness\/harness\.yaml\noutcome: noop\ncreated: \[\]\nupdated: \[\]\npreserved: \["harness\/harness.yaml"/u); assert.match(textReceipt.stdout, /drifted: \[\]\ncommit: none\nnext: ha daemon repo register --repo-id fresh --root/u); assert.match(textReceipt.stdout, /daemon status/u);
    assert.equal(run(fixture.repo, fixture.userRoot,
      ["task", "create", "--task-id", "task-first", "--title", "First task"]).outcome, "applied");
  } finally { stop(fixture.repo, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("REQ-CLI-016 adds only missing npm script keys while preserving existing package bytes", () => {
  const fixture = setup(), packagePath = path.join(fixture.alpha, "package.json"), original = "{\n\t\"name\": \"project-owned\",\n\t\"scripts\": {\n\t\t\"test\": \"node --test\",\n\t\t\"ha\": \"project-ha\"\n\t},\n\t\"marker\": \"keep exactly\"\n}\n";
  try {
    writeFileSync(packagePath, original); git(fixture.alpha, "add", "package.json"); git(fixture.alpha, "commit", "--quiet", "-m", "project package"); assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true); const receipt = run(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner", "--add-npm-scripts"]), expected = "{\n\t\"name\": \"project-owned\",\n\t\"scripts\": {\n\t\t\"test\": \"node --test\",\n\t\t\"ha\": \"project-ha\",\n\t\t\"harness-anything\": \"harness-anything\",\n\t\t\"harness-anything:check\": \"harness-anything check\"\n\t},\n\t\"marker\": \"keep exactly\"\n}\n"; assert.equal(readFileSync(packagePath, "utf8"), expected); assert.equal((receipt.updated as string[]).includes("package.json#scripts"), true); assert.equal((receipt.created as string[]).includes("package.json"), false); const repeated = run(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner", "--add-npm-scripts"]); assert.equal(repeated.outcome, "noop"); assert.equal((repeated.preserved as string[]).includes("package.json"), true); assert.equal(readFileSync(packagePath, "utf8"), expected);
  } finally { stop(fixture.alpha, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("U-12 Configure-Verify failure keeps the canonical publication and returns an honest partial receipt", () => {
  const fixture = setup(), configPath = path.join(fixture.alpha, "harness/harness.yaml"), overlayPath = path.join(fixture.alpha, "harness/governance/task-scaffold.json");
  try {
    writeFileSync(configPath, "layout:\n  authoredRoot: harness\nsettings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n  locale: en-US\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: governance/repository-scaffold.json\n"); mkdirSync(path.dirname(overlayPath), { recursive: true }); writeFileSync(overlayPath, "{}\n"); git(fixture.alpha, "add", "harness"); git(fixture.alpha, "commit", "--quiet", "-m", "invalid task overlay"); assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true); const before = git(fixture.alpha, "rev-parse", "HEAD"), result = runMaybe(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"]); assert.notEqual(result.status, 0); assert.equal(result.receipt.outcome, "partial"); assert.equal((result.receipt.error as { code?: string }).code, "configure_verify_failed"); assert.match(String((result.receipt.error as { hint?: string }).hint), /^init Configure-Verify smoke failed:/u); assert.equal((result.receipt.publication as { ok: boolean }).ok, true); assert.match(String(result.receipt.commit), /^[0-9a-f]{40}$/u); assert.notEqual(result.receipt.commit, before); assert.equal((result.receipt.created as string[]).length > 0, true); assert.match(String(result.receipt.next), /daemon status/u); assert.equal(git(fixture.alpha, "rev-parse", "HEAD"), result.receipt.commit); assert.equal(git(fixture.alpha, "ls-tree", "-r", "--name-only", "HEAD").split("\n").some((target) => target.startsWith("harness/tasks/") || target.startsWith("harness/events/")), false); assert.equal(makeTaskEventStore({ rootDir: fixture.alpha, repoId: "alpha" }).read().revision, 0);
  } finally { stop(fixture.alpha, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("existing c606 pair upgrades additively and explicit name is the only config byte change", () => {
  const fixture = setup();
  try {
    const configPath = path.join(fixture.alpha, "harness/harness.yaml"), peoplePath = path.join(fixture.alpha, "harness/people.yaml"), originalConfig = readFileSync(configPath, "utf8"), originalPeople = readFileSync(peoplePath, "utf8"); assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const additive = run(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"]); assert.equal(additive.outcome, "applied"); assert.deepEqual(additive.updated, []); assert.equal((additive.created as string[]).includes("harness/harness.yaml"), false); assert.equal((additive.created as string[]).includes("harness/people.yaml"), false); assert.equal(readFileSync(configPath, "utf8"), originalConfig); assert.equal(readFileSync(peoplePath, "utf8"), originalPeople);
    const named = run(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner", "--name", "Alpha Project"]); assert.equal(named.outcome, "applied"); assert.deepEqual(named.created, []); assert.deepEqual(named.updated, ["harness/harness.yaml#name"]); assert.equal(readFileSync(configPath, "utf8"), `name: "Alpha Project"\n${originalConfig}`); assert.equal(readFileSync(peoplePath, "utf8"), originalPeople);
    const same = run(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner", "--name", "Alpha Project"]); assert.equal(same.outcome, "noop"); assert.deepEqual(same.created, []); assert.deepEqual(same.updated, []); assert.equal(same.commit, null); assert.equal(readFileSync(configPath, "utf8"), `name: "Alpha Project"\n${originalConfig}`);
    const renamed = run(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner", "--name", "Renamed"]); assert.deepEqual(renamed.updated, ["harness/harness.yaml#name"]); assert.equal(readFileSync(configPath, "utf8"), `name: "Renamed"\n${originalConfig}`);
  } finally { stop(fixture.alpha, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("partial bootstrap pair fails closed before any scaffold write", () => {
  const fixture = setupEmpty();
  try {
    mkdirSync(path.join(fixture.repo, "harness")); writeFileSync(path.join(fixture.repo, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n"); assert.equal(run(fixture.repo, fixture.userRoot, ["daemon", "start", "--service"]).ok, true); const before = readFileSync(path.join(fixture.repo, "harness/harness.yaml"), "utf8"), rejected = runMaybe(fixture.repo, fixture.userRoot, ["init", "--repo-id", "partial", "--person-id", "owner", "--display-name", "Owner"]); assert.notEqual(rejected.status, 0); assert.equal((rejected.receipt.error as { code?: string }).code, "bootstrap_incomplete"); assert.equal(readFileSync(path.join(fixture.repo, "harness/harness.yaml"), "utf8"), before); assert.equal(existsSync(path.join(fixture.repo, "harness/people.yaml")), false); assert.equal(existsSync(path.join(fixture.repo, "harness/context")), false); assert.equal(existsSync(path.join(fixture.repo, ".git")), false);
  } finally { stop(fixture.repo, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("existing architecture assets remain byte-owned and a half model is not completed", () => {
  const fixture = setup();
  try {
    const architectureRoot = path.join(fixture.alpha, "harness/context/architecture"), readme = "# Project Architecture\n\nProject-owned without builtin anchors.\n", manifest = "{\"schema\":\"project-architecture/v1\"}\n", nodes = "{\"nodes\":[\"owned\"]}\n"; mkdirSync(path.join(architectureRoot, "model"), { recursive: true }); writeFileSync(path.join(architectureRoot, "README.md"), readme); writeFileSync(path.join(architectureRoot, "manifest.json"), manifest); writeFileSync(path.join(architectureRoot, "model/nodes.json"), nodes); git(fixture.alpha, "add", "harness/context/architecture"); git(fixture.alpha, "commit", "--quiet", "-m", "partial architecture"); assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const initialized = run(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"]); assert.equal(readFileSync(path.join(architectureRoot, "README.md"), "utf8"), readme); assert.equal(readFileSync(path.join(architectureRoot, "manifest.json"), "utf8"), manifest); assert.equal(readFileSync(path.join(architectureRoot, "model/nodes.json"), "utf8"), nodes); assert.equal(existsSync(path.join(architectureRoot, "model/edges.json")), false); assert.equal(existsSync(path.join(architectureRoot, "view")), false); assert.equal((initialized.preserved as string[]).includes("harness/context/architecture/README.md"), true); assert.equal((initialized.drifted as string[]).includes("harness/context/architecture/README.md"), true);
  } finally { stop(fixture.alpha, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("repository overlay is additive, preserves authored prose, and rejects an invalid plan before publication", () => {
  const fixture = setup();
  try {
    const custom = "# Existing Context\n\nOwned by the project.\n", customAgents = "# Existing Agents\n\nProject-owned.\n", customClaude = "# Existing Claude\n\nProject-owned.\n", config = "layout:\n  authoredRoot: harness\nsettings:\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: governance-repository-scaffold.json\n", people = readFileSync(path.join(fixture.alpha, "harness/people.yaml"), "utf8"); mkdirSync(path.join(fixture.alpha, "harness/context"), { recursive: true }); writeFileSync(path.join(fixture.alpha, "harness/context/README.md"), custom); writeFileSync(path.join(fixture.alpha, "AGENTS.md"), customAgents); writeFileSync(path.join(fixture.alpha, "CLAUDE.md"), customClaude); writeFileSync(path.join(fixture.alpha, "harness/templates-architecture.md"), "# Architecture\n\n## Purpose\n\nCustom.\n\n## Opt-in Boundary\n\nNo model.\n"); writeFileSync(path.join(fixture.alpha, "harness/templates-project.md"), "# Project\n\n## Project Notes\n\nCustom.\n");
    writeFileSync(path.join(fixture.alpha, "harness/governance-repository-scaffold.json"), `${JSON.stringify({ schema: "repository-scaffold/v1", replaceTemplate: [{ slot: "repository.context.architecture", template: "templates-architecture.md" }], addDocument: [{ slot: "repository.context.project", path: "harness/context/project.md", template: "templates-project.md", requiredAnchors: ["## Project Notes"] }] })}\n`); writeFileSync(path.join(fixture.alpha, "harness/harness.yaml"), config); git(fixture.alpha, "add", "harness", "AGENTS.md", "CLAUDE.md"); git(fixture.alpha, "commit", "--quiet", "-m", "repository overlay");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true); const before = git(fixture.alpha, "rev-parse", "HEAD"), initialized = run(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"]); assert.equal(initialized.outcome, "applied"); assert.equal(readFileSync(path.join(fixture.alpha, "harness/harness.yaml"), "utf8"), config); assert.equal(readFileSync(path.join(fixture.alpha, "harness/people.yaml"), "utf8"), people); assert.equal(readFileSync(path.join(fixture.alpha, "harness/context/README.md"), "utf8"), custom); assert.equal(readFileSync(path.join(fixture.alpha, "AGENTS.md"), "utf8"), customAgents); assert.equal(readFileSync(path.join(fixture.alpha, "CLAUDE.md"), "utf8"), customClaude); for (const target of ["harness/context/README.md", "AGENTS.md", "CLAUDE.md"]) assert.equal((initialized.drifted as string[]).includes(target), true, target); assert.equal(readFileSync(path.join(fixture.alpha, "harness/context/architecture/README.md"), "utf8").includes("Custom."), true); assert.equal(readFileSync(path.join(fixture.alpha, "harness/context/project.md"), "utf8").includes("Project Notes"), true); assert.match(String((initialized.plan as { projectOverlayDigest?: string }).projectOverlayDigest), /^sha256:/u); assert.notEqual(initialized.commit, before);
    stop(fixture.alpha, fixture.userRoot); const invalid = setup(); writeFileSync(path.join(invalid.alpha, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\nsettings:\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: invalid.json\n"); writeFileSync(path.join(invalid.alpha, "harness/invalid.json"), "{}\n"); git(invalid.alpha, "add", "harness"); git(invalid.alpha, "commit", "--quiet", "-m", "invalid overlay"); assert.equal(run(invalid.alpha, invalid.userRoot, ["daemon", "start", "--service"]).ok, true); const invalidHead = git(invalid.alpha, "rev-parse", "HEAD"), invalidStatus = git(invalid.alpha, "status", "--porcelain"), rejected = runMaybe(invalid.alpha, invalid.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"]); assert.notEqual(rejected.status, 0); assert.equal((rejected.receipt.error as { code?: string }).code, "invalid_repository_scaffold"); assert.equal(git(invalid.alpha, "rev-parse", "HEAD"), invalidHead); assert.equal(git(invalid.alpha, "status", "--porcelain"), invalidStatus); assert.equal(existsSync(path.join(invalid.alpha, "harness/context")), false); stop(invalid.alpha, invalid.userRoot); rmSync(invalid.root, { recursive: true, force: true });
  } finally { stop(fixture.alpha, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a changed overlay path leaves the prior authored document and reports it as governance drift", () => {
  const fixture = setup();
  try {
    const config = "layout:\n  authoredRoot: harness\nsettings:\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: governance/repository-scaffold.json\n", overlayPath = path.join(fixture.alpha, "harness/governance/repository-scaffold.json"), templatePath = path.join(fixture.alpha, "harness/project-notes.md"), overlay = (target: string) => `${JSON.stringify({ schema: "repository-scaffold/v1", replaceTemplate: [], addDocument: [{ slot: "repository.context.project", path: target, template: "project-notes.md", requiredAnchors: ["## Project Notes"] }] })}\n`; mkdirSync(path.dirname(overlayPath), { recursive: true }); writeFileSync(path.join(fixture.alpha, "harness/harness.yaml"), config); writeFileSync(templatePath, "# Project\n\n## Project Notes\n\nOwned.\n"); writeFileSync(overlayPath, overlay("harness/context/old-project.md")); git(fixture.alpha, "add", "harness"); git(fixture.alpha, "commit", "--quiet", "-m", "add project document"); assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const first = run(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"]); assert.equal((first.created as string[]).includes("harness/context/old-project.md"), true); const oldBody = readFileSync(path.join(fixture.alpha, "harness/context/old-project.md"), "utf8"); stop(fixture.alpha, fixture.userRoot); writeFileSync(overlayPath, overlay("harness/context/new-project.md")); git(fixture.alpha, "add", "harness/governance/repository-scaffold.json"); git(fixture.alpha, "commit", "--quiet", "-m", "change project document path"); git(fixture.alpha, "update-ref", "refs/ha/canonical", "HEAD"); assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const changed = run(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"]); assert.deepEqual(changed.created, ["harness/context/new-project.md"]); assert.equal((changed.drifted as string[]).includes("harness/context/old-project.md"), true); assert.match(String(changed.next), /governance/iu); assert.equal(readFileSync(path.join(fixture.alpha, "harness/context/old-project.md"), "utf8"), oldBody); assert.equal(readFileSync(path.join(fixture.alpha, "harness/context/new-project.md"), "utf8"), oldBody);
  } finally { stop(fixture.alpha, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("old-only standards fail closed before repository scaffold publication", () => {
  const fixture = setup();
  try {
    mkdirSync(path.join(fixture.alpha, "harness/standards"), { recursive: true }); writeFileSync(path.join(fixture.alpha, "harness/standards/README.md"), "# Legacy standards\n"); git(fixture.alpha, "add", "harness/standards"); git(fixture.alpha, "commit", "--quiet", "-m", "legacy standards");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true); const before = git(fixture.alpha, "rev-parse", "HEAD"), status = git(fixture.alpha, "status", "--porcelain"), rejected = runMaybe(fixture.alpha, fixture.userRoot, ["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"]); assert.notEqual(rejected.status, 0); const error = rejected.receipt.error as { code?: string; hint?: string }; assert.equal(error.code, "standards_migration_required"); assert.match(error.hint ?? "", /explicit governance task/u); assert.equal(git(fixture.alpha, "rev-parse", "HEAD"), before); assert.equal(git(fixture.alpha, "status", "--porcelain"), status); assert.equal(existsSync(path.join(fixture.alpha, "harness/governance")), false); assert.equal(existsSync(path.join(fixture.alpha, "harness/context")), false);
  } finally { stop(fixture.alpha, fixture.userRoot); rmSync(fixture.root, { recursive: true, force: true }); }
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
