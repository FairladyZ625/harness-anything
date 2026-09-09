// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readDaemonPid } from "../../daemon/src/runtime.ts";
import {
  activateEmptyCanonicalGeneration,
  compileSettingsChangedEvent,
  makeTaskEventReader,
  makeTaskEventStore,
  readSettingsFacet,
  repositorySettings,
} from "../../kernel/src/index.ts";

import { cli, git, register, run, setup, setupEmpty, stop } from "./daemon-multi-repo-lifecycle-cli.fixtures.ts";
test("REQ-CTX-01..10 empty init publishes the canonical scaffold, authority parity, fixed receipt, and phantom-free Configure-Verify", () => {
  const fixture = setupEmpty();
  try {
    assert.equal(existsSync(path.join(fixture.repo, "harness")), false);
    // No explicit daemon was started: init must auto-start the resident daemon
    // (bounded autostart) and still publish only through it.
    const initialized = run(fixture.repo, fixture.userRoot, [
      "init",
      "--repo-id",
      "fresh",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
      "--add-npm-scripts",
    ]);
    assert.ok(readDaemonPid(fixture.userRoot, "default"), "init must leave an auto-started resident daemon pid");
    assert.equal(initialized.ok, true);
    assert.equal(initialized.repoId, "fresh");
    assert.equal(initialized.outcome, "applied");
    assert.match(String(initialized.commit), /^[0-9a-f]{40}$/u);
    assert.deepEqual(initialized.created, [
      "harness/harness.yaml",
      "harness/people.yaml",
      "package.json",
      "harness/context/README.md",
      "harness/context/architecture/README.md",
      "harness/context/development/README.md",
      "harness/context/integrations/README.md",
      "harness/context/research/README.md",
      "harness/governance/standards/README.md",
      "harness/governance/standards/repository-governance.md",
      "harness/governance/standards/decision-writing.md",
      "harness/milestones/README.md",
      "harness/governance/walls/walls.json",
      "harness/governance/walls/run-walls.mjs",
      "harness/.gitattributes",
      "CLAUDE.md",
      "AGENTS.md",
    ]);
    assert.deepEqual(initialized.updated, []);
    assert.deepEqual(initialized.preserved, []);
    assert.deepEqual(initialized.drifted, []);
    const plan = initialized.plan as {
      digest: string;
      baseScaffoldDigest: string;
      projectOverlayPath: string | null;
      projectOverlayDigest: string | null;
      documents: Array<{
        path: string;
        contentSha256: string;
        disposition: string;
      }>;
    };
    assert.match(plan.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(plan.baseScaffoldDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(plan.projectOverlayPath, null);
    assert.equal(plan.projectOverlayDigest, null);
    assert.deepEqual(
      plan.documents.map(({ disposition }) => disposition),
      Array(14).fill("created"),
    );
    assert.equal((initialized.publication as { ok: boolean }).ok, true);
    for (const target of initialized.created as string[])
      assert.equal(existsSync(path.join(fixture.repo, target)), true, target);
    const ledgerRoot = path.join(fixture.repo, "harness"),
      defaultConfig = readFileSync(path.join(fixture.repo, "harness/harness.yaml"), "utf8"),
      people = readFileSync(path.join(fixture.repo, "harness/people.yaml"), "utf8"),
      architecture = readFileSync(path.join(fixture.repo, "harness/context/architecture/README.md"), "utf8");
    assert.match(
      defaultConfig,
      /contextRoot: harness\/context\n  governanceRoot: harness\/governance\n  milestonesRoot: harness\/milestones/u,
    );
    assert.match(
      defaultConfig,
      /scaffolds:\n    task: governance\/task-scaffold\.json\n    repository: governance\/repository-scaffold\.json/u,
    );
    assert.doesNotMatch(defaultConfig, /^  locale:/mu);
    assert.deepEqual(JSON.parse(readFileSync(path.join(fixture.repo, ".harness/settings.local.json"), "utf8")), {
      schema: "settings-local/v1",
      locale: "en-US",
    });
    assert.match(
      architecture,
      /Opt-in Boundary[\s\S]*does not create or enable an architecture manifest, model, or generated view/iu,
    );
    assert.equal(existsSync(path.join(fixture.repo, "harness/context/architecture/manifest.json")), false);
    assert.equal(existsSync(path.join(fixture.repo, "harness/context/architecture/model")), false);
    assert.equal(existsSync(path.join(fixture.repo, "harness/adr/README.md")), false);
    assert.match(
      readFileSync(path.join(fixture.repo, "harness/milestones/README.md"), "utf8"),
      /does not create.*status/isu,
    );
    assert.match(
      readFileSync(path.join(fixture.repo, "AGENTS.md"), "utf8"),
      /harness\/governance\/standards\/repository-governance\.md/u,
    );
    assert.match(readFileSync(path.join(fixture.repo, "CLAUDE.md"), "utf8"), /harness\/context\/README\.md/u);
    assert.equal(
      readFileSync(path.join(fixture.repo, "package.json"), "utf8"),
      `${JSON.stringify({ private: true, scripts: { "harness-anything": "harness-anything", ha: "ha", "harness-anything:check": "harness-anything check" } }, null, 2)}\n`,
    );
    assert.equal(existsSync(path.join(fixture.repo, "harness/persons.yaml")), false);
    assert.equal(git(ledgerRoot, "show", `${String(initialized.commit)}:people.yaml`), people.trim());
    assert.equal(initialized.summary, "initialized harness at harness/harness.yaml");
    assert.deepEqual((initialized.configureVerify as { ok: boolean; steps: string[] }).steps, [
      "publication-readback",
      "canonical-layout",
      "daemon-l2-readiness",
      "task-bootstrap-dry-run",
    ]);
    assert.equal((initialized.configureVerify as { ok: boolean }).ok, true);
    assert.deepEqual(
      (initialized.publication as { changedPaths: string[] }).changedPaths,
      (initialized.created as string[]).filter((target) => target.startsWith("harness/")),
    );
    const stream = makeTaskEventStore({
      rootDir: fixture.repo,
      repoId: "fresh",
    }).read();
    assert.equal(
      git(ledgerRoot, "ls-tree", "-r", "--name-only", "HEAD")
        .split("\n")
        .some((target) => target.startsWith("tasks/")),
      false,
    );
    assert.equal(stream.revision, 2);
    assert.equal(stream.events[0]?.schema, "settings-event/v1");
    assert.equal(stream.events[1]?.schema, "vertical-declaration-event/v1");
    const settingsRead = run(fixture.repo, fixture.userRoot, ["settings", "read"]).settings;
    assert.equal(settingsRead.locale, "en-US");
    assert.deepEqual(
      repositorySettings(settingsRead),
      stream.events[0]?.schema === "settings-event/v1" ? stream.events[0].payload.settings : null,
    );
    const repeated = run(fixture.repo, fixture.userRoot, [
      "init",
      "--repo-id",
      "fresh",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
      "--add-npm-scripts",
    ]);
    assert.equal(repeated.outcome, "noop");
    assert.equal(repeated.commit, null);
    assert.deepEqual(repeated.created, []);
    assert.deepEqual(repeated.updated, []);
    assert.deepEqual(repeated.preserved, initialized.created);
    assert.equal(git(ledgerRoot, "rev-list", "--count", "HEAD"), "3");
    const walls = spawnSync(process.execPath, [path.join(fixture.repo, "harness/governance/walls/run-walls.mjs")], {
      cwd: fixture.repo,
      encoding: "utf8",
    });
    assert.equal(walls.status, 0, walls.stderr);
    assert.match(walls.stdout, /WALLS pass=0 red=0 expected=0 notice=0 info=0 total=0/u);
    assert.equal(existsSync(path.join(fixture.repo, "harness/governance/walls/reports")), false);
    const wallsPath = path.join(fixture.repo, "harness/governance/walls/walls.json");
    writeFileSync(
      wallsPath,
      JSON.stringify(
        {
          schema: "walls/v1",
          walls: [
            {
              id: "red",
              state: "guarding",
              cmd: 'node -e "process.exit(0)"',
              expect: "hits>=1",
            },
            {
              id: "notice",
              state: "known-issue",
              cmd: "node -e \"console.log('fixed')\"",
              expect: "hits>=1",
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    const actionableWalls = spawnSync(
      process.execPath,
      [path.join(fixture.repo, "harness/governance/walls/run-walls.mjs")],
      { cwd: fixture.repo, encoding: "utf8" },
    );
    assert.equal(actionableWalls.status, 1, actionableWalls.stderr);
    assert.match(actionableWalls.stdout, /RED\s+red/u);
    assert.match(actionableWalls.stdout, /NOTICE\s+notice/u);
    assert.match(actionableWalls.stdout, /WALLS pass=0 red=1 expected=0 notice=1 info=0 total=2/u);
    assert.match(actionableWalls.stdout, /report: .*[/\\]reports[/\\]walls-/u);
    const reportsRoot = path.join(fixture.repo, "harness/governance/walls/reports");
    assert.equal(existsSync(reportsRoot), true);
    const reports = readdirSync(reportsRoot, { withFileTypes: true });
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.isFile(), true);
    assert.equal(git(ledgerRoot, "rev-list", "--count", "HEAD"), "3");
    const textReceipt = spawnSync(
      process.execPath,
      [
        cli,
        "--root",
        fixture.repo,
        "init",
        "--repo-id",
        "fresh",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
        "--add-npm-scripts",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: path.join(fixture.repo, ".home"),
          GIT_CONFIG_GLOBAL: "/dev/null",
          HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
        },
      },
    );
    assert.equal(textReceipt.status, 0, textReceipt.stderr);
    assert.match(
      textReceipt.stdout,
      /^initialized harness at harness\/harness\.yaml\noutcome: noop\ncreated: \[\]\nupdated: \[\]\npreserved: \["harness\/harness.yaml"/u,
    );
    assert.match(
      textReceipt.stdout,
      /drifted: \[\]\ncommit: none\nnext: ha daemon repo register --repo-id fresh --root/u,
    );
    assert.match(textReceipt.stdout, /daemon status/u);
    assert.equal(
      run(fixture.repo, fixture.userRoot, ["task", "create", "--id", "task-first", "--admin", "--title", "First task"])
        .outcome,
      "applied",
    );
  } finally {
    stop(fixture.repo, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("local init isolates the ledger from later project commits and removes tracked runtime paths", (context) => {
  const fixture = setupEmpty();
  try {
    git(fixture.repo, "init", "--quiet");
    git(fixture.repo, "config", "user.name", "Project Owner");
    git(fixture.repo, "config", "user.email", "project@example.test");
    mkdirSync(path.join(fixture.repo, "harness"), { recursive: true });
    mkdirSync(path.join(fixture.repo, ".harness/cache"), { recursive: true });
    writeFileSync(path.join(fixture.repo, "harness/previous.txt"), "tracked by the project\n");
    writeFileSync(path.join(fixture.repo, ".harness/cache/previous.txt"), "tracked runtime state\n");
    git(fixture.repo, "add", ".");
    git(fixture.repo, "commit", "--quiet", "-m", "project base");
    const initialized = run(fixture.repo, fixture.userRoot, [
      "init",
      "--repo-id",
      "local",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    assert.equal(initialized.ok, true);
    const ledgerRoot = path.join(fixture.repo, "harness");
    const harnessIgnored = git(fixture.repo, "check-ignore", "harness"),
      runtimeIgnored = git(fixture.repo, "check-ignore", ".harness"),
      harnessTracked = git(fixture.repo, "ls-files", "harness/"),
      runtimeTracked = git(fixture.repo, "ls-files", ".harness/");
    assert.equal(existsSync(path.join(ledgerRoot, ".git")), true);
    assert.equal(harnessIgnored, "harness");
    assert.equal(runtimeIgnored, ".harness");
    assert.equal(harnessTracked, "");
    assert.equal(runtimeTracked, "");
    writeFileSync(path.join(fixture.repo, "project.txt"), "ordinary project change\n");
    git(fixture.repo, "add", ".");
    git(fixture.repo, "commit", "--quiet", "-m", "advance project head");
    const projectHead = git(fixture.repo, "rev-parse", "HEAD"),
      ledgerHead = git(ledgerRoot, "rev-parse", "HEAD");
    assert.notEqual(projectHead, ledgerHead);
    const written = run(fixture.repo, fixture.userRoot, [
      "task",
      "create",
      "--id",
      "task-after-project-commit",
      "--admin",
      "--title",
      "Still writable",
    ]);
    assert.equal(written.outcome, "applied", JSON.stringify(written));
    assert.match(String(written.commitSha), /^[0-9a-f]{40}$/u);
    assert.ok(written.cut);
    assert.equal(git(fixture.repo, "rev-parse", "HEAD"), projectHead);
    assert.notEqual(git(ledgerRoot, "rev-parse", "HEAD"), ledgerHead);
    stop(fixture.repo, fixture.userRoot);
    const ledgerAfter = git(ledgerRoot, "rev-parse", "HEAD");
    assert.notEqual(ledgerAfter, ledgerHead);
    assert.equal(
      spawnSync("git", ["-C", fixture.repo, "rev-parse", "--verify", "refs/ha/canonical"], { encoding: "utf8" }).status,
      128,
    );
    context.diagnostic(
      `ledger.git=true\nouter.check-ignore harness=${harnessIgnored}\nouter.check-ignore .harness=${runtimeIgnored}\nouter.ls-files harness/=${harnessTracked}\nouter.ls-files .harness/=${runtimeTracked}\nproject.head.after=${projectHead}\nledger.head.before=${ledgerHead}\nledger.head.after=${ledgerAfter}\nwrite.outcome=${String(written.outcome)}`,
    );
  } finally {
    stop(fixture.repo, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("center registration keeps an external ledger repository readable and writable", async (context) => {
  const fixture = setup();
  try {
    assert.equal(existsSync(path.join(fixture.alpha, "harness/.git")), false);
    const documentBody = readFileSync(path.join(fixture.alpha, "harness/harness.yaml"), "utf8"),
      store = makeTaskEventStore({
        rootDir: fixture.alpha,
        repoId: "center",
        activationPreflight: activateEmptyCanonicalGeneration,
      });
    store.append(
      compileSettingsChangedEvent({
        settings: readSettingsFacet(documentBody),
        baseDocumentBody: documentBody,
        candidateDocumentBody: documentBody,
        eventId: "event-center-settings",
        opId: "settings-initialize-center",
        workspaceRevision: 1,
        actor: { principal: { personId: "owner" }, executor: null },
        source: "local",
        occurredAt: "2026-08-27T00:00:00.000Z",
      }),
    );
    await store.drain();
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.alpha, fixture.userRoot, "center");
    const before = git(fixture.alpha, "rev-parse", "HEAD"),
      written = run(fixture.alpha, fixture.userRoot, [
        "task",
        "create",
        "--id",
        "task-center",
        "--admin",
        "--title",
        "Center ledger",
      ]);
    assert.equal(written.outcome, "applied", JSON.stringify(written));
    assert.match(String(written.commitSha), /^[0-9a-f]{40}$/u);
    assert.ok(written.cut);
    assert.notEqual(git(fixture.alpha, "rev-parse", "HEAD"), before);
    assert.match(
      String(run(fixture.alpha, fixture.userRoot, ["task", "show", "task-center"]).evidence),
      /Center ledger/u,
    );
    stop(fixture.alpha, fixture.userRoot);
    const after = git(fixture.alpha, "rev-parse", "HEAD");
    assert.notEqual(after, before);
    assert.equal((written.git as { commitSha: string }).commitSha, after);
    assert.equal(
      git(fixture.alpha, "ls-tree", "-r", "--name-only", "HEAD")
        .split("\n")
        .some((target) => target.startsWith("harness/events/")),
      true,
    );
    context.diagnostic(
      `ledger.git=${fixture.alpha}\nledger.head.before=${before}\nledger.head.after=${after}\nledger.sqlite.revision=${String(written.revision)}\nwrite.outcome=${String(written.outcome)}\nread.task=Center ledger`,
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("REQ-CLI-016 adds only missing npm script keys while preserving existing package bytes", () => {
  const fixture = setup(),
    packagePath = path.join(fixture.alpha, "package.json"),
    original =
      '{\n\t"name": "project-owned",\n\t"scripts": {\n\t\t"test": "node --test",\n\t\t"ha": "project-ha"\n\t},\n\t"marker": "keep exactly"\n}\n';
  try {
    writeFileSync(packagePath, original);
    git(fixture.alpha, "add", "package.json");
    git(fixture.alpha, "commit", "--quiet", "-m", "project package");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const receipt = run(fixture.alpha, fixture.userRoot, [
        "init",
        "--repo-id",
        "alpha",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
        "--add-npm-scripts",
      ]),
      expected =
        '{\n\t"name": "project-owned",\n\t"scripts": {\n\t\t"test": "node --test",\n\t\t"ha": "project-ha",\n\t\t"harness-anything": "harness-anything",\n\t\t"harness-anything:check": "harness-anything check"\n\t},\n\t"marker": "keep exactly"\n}\n';
    assert.equal(readFileSync(packagePath, "utf8"), expected);
    assert.equal((receipt.updated as string[]).includes("package.json#scripts"), true);
    assert.equal((receipt.created as string[]).includes("package.json"), false);
    const repeated = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
      "--add-npm-scripts",
    ]);
    assert.equal(repeated.outcome, "noop");
    assert.equal((repeated.preserved as string[]).includes("package.json"), true);
    assert.equal(readFileSync(packagePath, "utf8"), expected);
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("init at a configured authored root writes the machine documents where every reader resolves them", () => {
  const fixture = setupEmpty(),
    // The declaration has to sit at the fixed discovery anchor: `layout.authoredRoot` cannot be
    // read from a file whose own path depends on it. It names the authored root and nothing else.
    declarationPath = path.join(fixture.repo, "harness/harness.yaml"),
    declaration = "layout:\n  authoredRoot: ledger\n";
  try {
    mkdirSync(path.dirname(declarationPath), { recursive: true });
    writeFileSync(declarationPath, declaration);
    const initialized = run(fixture.repo, fixture.userRoot, [
        "init",
        "--repo-id",
        "configured",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ]),
      ledgerRoot = path.join(fixture.repo, "ledger");
    assert.equal(initialized.ok, true);
    assert.equal(initialized.outcome, "applied");
    assert.equal(initialized.summary, "initialized harness at ledger/harness.yaml");
    // repo-cell-settings-state, the Settings write authorization, the WIP settings and the
    // migration contract compiler all resolve the machine documents under the authored root.
    // Init publishing them at the default spelling is what left the Settings write without a base.
    assert.deepEqual((initialized.created as string[]).slice(0, 2), ["ledger/harness.yaml", "ledger/people.yaml"]);
    assert.equal(existsSync(path.join(fixture.repo, "harness/people.yaml")), false);
    assert.deepEqual(readdirSync(path.join(fixture.repo, "harness")), ["harness.yaml"]);
    // The declaration is the seed, not a second layout: the published document repeats it verbatim.
    assert.equal(readFileSync(declarationPath, "utf8"), declaration);
    assert.equal(readFileSync(path.join(ledgerRoot, "harness.yaml"), "utf8"), declaration);
    const tracked = git(ledgerRoot, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    assert.equal(tracked.includes("harness.yaml"), true);
    assert.equal(tracked.includes("people.yaml"), true);
    const verify = initialized.configureVerify as {
      ok: boolean;
      steps: readonly string[];
      roots: Record<string, string>;
      l2: Record<string, string>;
    };
    assert.equal(verify.ok, true);
    assert.deepEqual(verify.steps, [
      "publication-readback",
      "canonical-layout",
      "daemon-l2-readiness",
      "task-bootstrap-dry-run",
    ]);
    assert.equal(verify.roots.contextRoot, path.join(ledgerRoot, "context"));
    assert.equal(verify.roots.standardsRoot, path.join(ledgerRoot, "governance/standards"));
    assert.deepEqual(verify.l2, { cellState: "attached", l2State: "ready" });
    // The Settings write is the step that used to fail: its base document is read at the authored
    // root, so a settings event exists at all only because init published the document there.
    const stream = makeTaskEventReader({ rootDir: fixture.repo, repoId: "configured" }).read(),
      settingsEvent = stream.events.find((event) => event.schema === "settings-event/v1");
    assert.ok(settingsEvent, JSON.stringify(stream.events.map(({ schema }) => schema)));
    assert.equal(
      (settingsEvent.payload as { harnessDocumentClaim: { path: string } }).harnessDocumentClaim.path,
      "harness.yaml",
    );
    assert.equal(
      readSettingsFacet(readFileSync(path.join(ledgerRoot, "harness.yaml"), "utf8")).defaultVertical,
      (settingsEvent.payload as { settings: { defaultVertical: string } }).settings.defaultVertical,
    );
  } finally {
    stop(fixture.repo, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
