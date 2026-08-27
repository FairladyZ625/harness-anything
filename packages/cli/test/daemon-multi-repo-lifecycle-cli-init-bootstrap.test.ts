// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readDaemonPid } from "../../daemon/src/runtime.ts";
import { makeTaskEventStore } from "../../kernel/src/index.ts";

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
      "harness/adr/README.md",
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
      Array(15).fill("created"),
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
      /contextRoot: harness\/context\n  governanceRoot: harness\/governance\n  adrRoot: harness\/adr\n  milestonesRoot: harness\/milestones/u,
    );
    assert.match(
      defaultConfig,
      /scaffolds:\n    task: governance\/task-scaffold\.json\n    repository: governance\/repository-scaffold\.json/u,
    );
    assert.match(
      architecture,
      /Opt-in Boundary[\s\S]*does not create or enable an architecture manifest, model, or generated view/iu,
    );
    assert.equal(existsSync(path.join(fixture.repo, "harness/context/architecture/manifest.json")), false);
    assert.equal(existsSync(path.join(fixture.repo, "harness/context/architecture/model")), false);
    assert.match(readFileSync(path.join(fixture.repo, "harness/adr/README.md"), "utf8"), /decision.*projection/isu);
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
    assert.equal(
      git(ledgerRoot, "ls-tree", "-r", "--name-only", "HEAD")
        .split("\n")
        .some((target) => target.startsWith("tasks/") || target.startsWith("events/")),
      false,
    );
    assert.equal(makeTaskEventStore({ rootDir: fixture.repo, repoId: "fresh" }).read().revision, 0);
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
    assert.equal(git(ledgerRoot, "rev-list", "--count", "HEAD"), "1");
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
    assert.equal(git(ledgerRoot, "rev-list", "--count", "HEAD"), "1");
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
    assert.equal(written.commitSha, null);
    assert.ok(written.cut);
    assert.equal(git(fixture.repo, "rev-parse", "HEAD"), projectHead);
    assert.equal(git(ledgerRoot, "rev-parse", "HEAD"), ledgerHead);
    stop(fixture.repo, fixture.userRoot);
    const ledgerAfter = git(ledgerRoot, "rev-parse", "HEAD");
    assert.notEqual(ledgerAfter, ledgerHead);
    assert.equal(git(ledgerRoot, "rev-parse", "refs/ha/canonical"), ledgerAfter);
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

test("center registration keeps an external ledger repository readable and writable", (context) => {
  const fixture = setup();
  try {
    assert.equal(existsSync(path.join(fixture.alpha, "harness/.git")), false);
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
    assert.equal(written.commitSha, null);
    assert.ok(written.cut);
    assert.equal(git(fixture.alpha, "rev-parse", "HEAD"), before);
    assert.match(
      String(run(fixture.alpha, fixture.userRoot, ["task", "show", "task-center"]).evidence),
      /Center ledger/u,
    );
    stop(fixture.alpha, fixture.userRoot);
    const after = git(fixture.alpha, "rev-parse", "HEAD");
    assert.notEqual(after, before);
    assert.equal(git(fixture.alpha, "rev-parse", "refs/ha/canonical"), after);
    assert.equal(
      git(fixture.alpha, "ls-tree", "-r", "--name-only", "HEAD")
        .split("\n")
        .some((target) => target.startsWith("harness/events/")),
      true,
    );
    context.diagnostic(
      `ledger.git=${fixture.alpha}\nledger.head.before=${before}\nledger.head.after=${after}\nledger.canonical=${git(fixture.alpha, "rev-parse", "refs/ha/canonical")}\nwrite.outcome=${String(written.outcome)}\nread.task=Center ledger`,
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
