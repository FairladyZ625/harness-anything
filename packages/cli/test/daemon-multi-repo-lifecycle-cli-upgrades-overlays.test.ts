// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, hostname, loadavg, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpc } from "../../daemon/src/client/local-json-rpc-client.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../../daemon/src/repo-cell.ts";
import { readDaemonPid } from "../../daemon/src/runtime.ts";
import { makeTaskEventStore } from "../../kernel/src/index.ts";

import {
  builtCli,
  cli,
  git,
  initialize,
  makeCanary,
  median,
  register,
  run,
  runMaybe,
  runNoop,
  setup,
  setupEmpty,
  stop,
  waitForRun,
} from "./daemon-multi-repo-lifecycle-cli.fixtures.ts";
test("U-12 Configure-Verify failure keeps the canonical publication and returns an honest partial receipt", () => {
  const fixture = setup(),
    configPath = path.join(fixture.alpha, "harness/harness.yaml"),
    overlayPath = path.join(
      fixture.alpha,
      "harness/governance/task-scaffold.json",
    );
  try {
    writeFileSync(
      configPath,
      "layout:\n  authoredRoot: harness\nsettings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n  locale: en-US\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: governance/repository-scaffold.json\n",
    );
    mkdirSync(path.dirname(overlayPath), { recursive: true });
    writeFileSync(overlayPath, "{}\n");
    git(fixture.alpha, "add", "harness");
    git(fixture.alpha, "commit", "--quiet", "-m", "invalid task overlay");
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok,
      true,
    );
    const before = git(fixture.alpha, "rev-parse", "HEAD"),
      result = runMaybe(fixture.alpha, fixture.userRoot, [
        "init",
        "--repo-id",
        "alpha",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ]),
      ledgerRoot = path.join(fixture.alpha, "harness");
    assert.notEqual(result.status, 0);
    assert.equal(result.receipt.outcome, "partial");
    assert.equal(
      (result.receipt.error as { code?: string }).code,
      "configure_verify_failed",
    );
    assert.match(
      String((result.receipt.error as { hint?: string }).hint),
      /^init Configure-Verify smoke failed:/u,
    );
    assert.equal((result.receipt.publication as { ok: boolean }).ok, true);
    assert.match(String(result.receipt.commit), /^[0-9a-f]{40}$/u);
    assert.equal(git(fixture.alpha, "rev-parse", "HEAD"), before);
    assert.equal((result.receipt.created as string[]).length > 0, true);
    assert.match(String(result.receipt.next), /daemon status/u);
    assert.equal(git(ledgerRoot, "rev-parse", "HEAD"), result.receipt.commit);
    assert.equal(
      git(ledgerRoot, "ls-tree", "-r", "--name-only", "HEAD")
        .split("\n")
        .some(
          (target) =>
            target.startsWith("tasks/") || target.startsWith("events/"),
        ),
      false,
    );
    assert.equal(
      makeTaskEventStore({ rootDir: fixture.alpha, repoId: "alpha" }).read()
        .revision,
      0,
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("existing c606 pair upgrades additively and explicit name is the only config byte change", () => {
  const fixture = setup();
  try {
    const configPath = path.join(fixture.alpha, "harness/harness.yaml"),
      peoplePath = path.join(fixture.alpha, "harness/people.yaml"),
      originalConfig = readFileSync(configPath, "utf8"),
      originalPeople = readFileSync(peoplePath, "utf8");
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok,
      true,
    );
    const additive = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    assert.equal(additive.outcome, "applied");
    assert.deepEqual(additive.updated, []);
    assert.equal(
      (additive.created as string[]).includes("harness/harness.yaml"),
      false,
    );
    assert.equal(
      (additive.created as string[]).includes("harness/people.yaml"),
      false,
    );
    assert.equal(readFileSync(configPath, "utf8"), originalConfig);
    assert.equal(readFileSync(peoplePath, "utf8"), originalPeople);
    const named = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
      "--name",
      "Alpha Project",
    ]);
    assert.equal(named.outcome, "applied");
    assert.deepEqual(named.created, []);
    assert.deepEqual(named.updated, ["harness/harness.yaml#name"]);
    assert.equal(
      readFileSync(configPath, "utf8"),
      `name: "Alpha Project"\n${originalConfig}`,
    );
    assert.equal(readFileSync(peoplePath, "utf8"), originalPeople);
    const same = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
      "--name",
      "Alpha Project",
    ]);
    assert.equal(same.outcome, "noop");
    assert.deepEqual(same.created, []);
    assert.deepEqual(same.updated, []);
    assert.equal(same.commit, null);
    assert.equal(
      readFileSync(configPath, "utf8"),
      `name: "Alpha Project"\n${originalConfig}`,
    );
    const renamed = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
      "--name",
      "Renamed",
    ]);
    assert.deepEqual(renamed.updated, ["harness/harness.yaml#name"]);
    assert.equal(
      readFileSync(configPath, "utf8"),
      `name: "Renamed"\n${originalConfig}`,
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("partial bootstrap pair fails closed before any scaffold write", () => {
  const fixture = setupEmpty();
  try {
    mkdirSync(path.join(fixture.repo, "harness"));
    writeFileSync(
      path.join(fixture.repo, "harness/harness.yaml"),
      "layout:\n  authoredRoot: harness\n",
    );
    assert.equal(
      run(fixture.repo, fixture.userRoot, ["daemon", "start", "--service"]).ok,
      true,
    );
    const before = readFileSync(
        path.join(fixture.repo, "harness/harness.yaml"),
        "utf8",
      ),
      rejected = runMaybe(fixture.repo, fixture.userRoot, [
        "init",
        "--repo-id",
        "partial",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ]);
    assert.notEqual(rejected.status, 0);
    assert.equal(
      (rejected.receipt.error as { code?: string }).code,
      "bootstrap_incomplete",
    );
    assert.equal(
      readFileSync(path.join(fixture.repo, "harness/harness.yaml"), "utf8"),
      before,
    );
    assert.equal(
      existsSync(path.join(fixture.repo, "harness/people.yaml")),
      false,
    );
    assert.equal(existsSync(path.join(fixture.repo, "harness/context")), false);
    assert.equal(existsSync(path.join(fixture.repo, ".git")), false);
  } finally {
    stop(fixture.repo, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("existing architecture assets remain byte-owned and a half model is not completed", () => {
  const fixture = setup();
  try {
    const architectureRoot = path.join(
        fixture.alpha,
        "harness/context/architecture",
      ),
      readme =
        "# Project Architecture\n\nProject-owned without builtin anchors.\n",
      manifest = '{"schema":"project-architecture/v1"}\n',
      nodes = '{"nodes":["owned"]}\n';
    mkdirSync(path.join(architectureRoot, "model"), { recursive: true });
    writeFileSync(path.join(architectureRoot, "README.md"), readme);
    writeFileSync(path.join(architectureRoot, "manifest.json"), manifest);
    writeFileSync(path.join(architectureRoot, "model/nodes.json"), nodes);
    git(fixture.alpha, "add", "harness/context/architecture");
    git(fixture.alpha, "commit", "--quiet", "-m", "partial architecture");
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok,
      true,
    );
    const initialized = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    assert.equal(
      readFileSync(path.join(architectureRoot, "README.md"), "utf8"),
      readme,
    );
    assert.equal(
      readFileSync(path.join(architectureRoot, "manifest.json"), "utf8"),
      manifest,
    );
    assert.equal(
      readFileSync(path.join(architectureRoot, "model/nodes.json"), "utf8"),
      nodes,
    );
    assert.equal(
      existsSync(path.join(architectureRoot, "model/edges.json")),
      false,
    );
    assert.equal(existsSync(path.join(architectureRoot, "view")), false);
    assert.equal(
      (initialized.preserved as string[]).includes(
        "harness/context/architecture/README.md",
      ),
      true,
    );
    assert.equal(
      (initialized.drifted as string[]).includes(
        "harness/context/architecture/README.md",
      ),
      true,
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("repository overlay is additive, preserves authored prose, and rejects an invalid plan before publication", () => {
  const fixture = setup();
  try {
    const custom = "# Existing Context\n\nOwned by the project.\n",
      customAgents = "# Existing Agents\n\nProject-owned.\n",
      customClaude = "# Existing Claude\n\nProject-owned.\n",
      config =
        "layout:\n  authoredRoot: harness\nsettings:\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: governance-repository-scaffold.json\n",
      people = readFileSync(
        path.join(fixture.alpha, "harness/people.yaml"),
        "utf8",
      );
    mkdirSync(path.join(fixture.alpha, "harness/context"), { recursive: true });
    writeFileSync(
      path.join(fixture.alpha, "harness/context/README.md"),
      custom,
    );
    writeFileSync(path.join(fixture.alpha, "AGENTS.md"), customAgents);
    writeFileSync(path.join(fixture.alpha, "CLAUDE.md"), customClaude);
    writeFileSync(
      path.join(fixture.alpha, "harness/templates-architecture.md"),
      "# Architecture\n\n## Purpose\n\nCustom.\n\n## Opt-in Boundary\n\nNo model.\n",
    );
    writeFileSync(
      path.join(fixture.alpha, "harness/templates-project.md"),
      "# Project\n\n## Project Notes\n\nCustom.\n",
    );
    writeFileSync(
      path.join(fixture.alpha, "harness/governance-repository-scaffold.json"),
      `${JSON.stringify({ schema: "repository-scaffold/v1", replaceTemplate: [{ slot: "repository.context.architecture", template: "templates-architecture.md" }], addDocument: [{ slot: "repository.context.project", path: "harness/context/project.md", template: "templates-project.md", requiredAnchors: ["## Project Notes"] }] })}\n`,
    );
    writeFileSync(path.join(fixture.alpha, "harness/harness.yaml"), config);
    git(fixture.alpha, "add", "harness", "AGENTS.md", "CLAUDE.md");
    git(fixture.alpha, "commit", "--quiet", "-m", "repository overlay");
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok,
      true,
    );
    const before = git(fixture.alpha, "rev-parse", "HEAD"),
      initialized = run(fixture.alpha, fixture.userRoot, [
        "init",
        "--repo-id",
        "alpha",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ]);
    assert.equal(initialized.outcome, "applied");
    assert.equal(
      readFileSync(path.join(fixture.alpha, "harness/harness.yaml"), "utf8"),
      config,
    );
    assert.equal(
      readFileSync(path.join(fixture.alpha, "harness/people.yaml"), "utf8"),
      people,
    );
    assert.equal(
      readFileSync(
        path.join(fixture.alpha, "harness/context/README.md"),
        "utf8",
      ),
      custom,
    );
    assert.equal(
      readFileSync(path.join(fixture.alpha, "AGENTS.md"), "utf8"),
      customAgents,
    );
    assert.equal(
      readFileSync(path.join(fixture.alpha, "CLAUDE.md"), "utf8"),
      customClaude,
    );
    for (const target of [
      "harness/context/README.md",
      "AGENTS.md",
      "CLAUDE.md",
    ])
      assert.equal(
        (initialized.drifted as string[]).includes(target),
        true,
        target,
      );
    assert.equal(
      readFileSync(
        path.join(fixture.alpha, "harness/context/architecture/README.md"),
        "utf8",
      ).includes("Custom."),
      true,
    );
    assert.equal(
      readFileSync(
        path.join(fixture.alpha, "harness/context/project.md"),
        "utf8",
      ).includes("Project Notes"),
      true,
    );
    assert.match(
      String(
        (initialized.plan as { projectOverlayDigest?: string })
          .projectOverlayDigest,
      ),
      /^sha256:/u,
    );
    assert.notEqual(initialized.commit, before);
    stop(fixture.alpha, fixture.userRoot);
    const invalid = setup();
    writeFileSync(
      path.join(invalid.alpha, "harness/harness.yaml"),
      "layout:\n  authoredRoot: harness\nsettings:\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: invalid.json\n",
    );
    writeFileSync(path.join(invalid.alpha, "harness/invalid.json"), "{}\n");
    git(invalid.alpha, "add", "harness");
    git(invalid.alpha, "commit", "--quiet", "-m", "invalid overlay");
    assert.equal(
      run(invalid.alpha, invalid.userRoot, ["daemon", "start", "--service"]).ok,
      true,
    );
    const invalidHead = git(invalid.alpha, "rev-parse", "HEAD"),
      invalidStatus = git(invalid.alpha, "status", "--porcelain"),
      rejected = runMaybe(invalid.alpha, invalid.userRoot, [
        "init",
        "--repo-id",
        "alpha",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ]);
    assert.notEqual(rejected.status, 0);
    assert.equal(
      (rejected.receipt.error as { code?: string }).code,
      "invalid_repository_scaffold",
    );
    assert.equal(git(invalid.alpha, "rev-parse", "HEAD"), invalidHead);
    assert.equal(git(invalid.alpha, "status", "--porcelain"), invalidStatus);
    assert.equal(
      existsSync(path.join(invalid.alpha, "harness/context")),
      false,
    );
    stop(invalid.alpha, invalid.userRoot);
    rmSync(invalid.root, { recursive: true, force: true });
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a changed overlay path leaves the prior authored document and reports it as governance drift", () => {
  const fixture = setup();
  try {
    const config =
        "layout:\n  authoredRoot: harness\nsettings:\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: governance/repository-scaffold.json\n",
      overlayPath = path.join(
        fixture.alpha,
        "harness/governance/repository-scaffold.json",
      ),
      templatePath = path.join(fixture.alpha, "harness/project-notes.md"),
      overlay = (target: string) =>
        `${JSON.stringify({ schema: "repository-scaffold/v1", replaceTemplate: [], addDocument: [{ slot: "repository.context.project", path: target, template: "project-notes.md", requiredAnchors: ["## Project Notes"] }] })}\n`;
    mkdirSync(path.dirname(overlayPath), { recursive: true });
    writeFileSync(path.join(fixture.alpha, "harness/harness.yaml"), config);
    writeFileSync(templatePath, "# Project\n\n## Project Notes\n\nOwned.\n");
    writeFileSync(overlayPath, overlay("harness/context/old-project.md"));
    git(fixture.alpha, "add", "harness");
    git(fixture.alpha, "commit", "--quiet", "-m", "add project document");
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok,
      true,
    );
    const first = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    assert.equal(
      (first.created as string[]).includes("harness/context/old-project.md"),
      true,
    );
    const oldBody = readFileSync(
        path.join(fixture.alpha, "harness/context/old-project.md"),
        "utf8",
      ),
      ledgerRoot = path.join(fixture.alpha, "harness");
    stop(fixture.alpha, fixture.userRoot);
    writeFileSync(overlayPath, overlay("harness/context/new-project.md"));
    git(ledgerRoot, "add", "governance/repository-scaffold.json");
    git(ledgerRoot, "commit", "--quiet", "-m", "change project document path");
    git(ledgerRoot, "update-ref", "refs/ha/canonical", "HEAD");
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok,
      true,
    );
    const changed = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    assert.deepEqual(changed.created, ["harness/context/new-project.md"]);
    assert.equal(
      (changed.drifted as string[]).includes("harness/context/old-project.md"),
      true,
    );
    assert.match(String(changed.next), /governance/iu);
    assert.equal(
      readFileSync(
        path.join(fixture.alpha, "harness/context/old-project.md"),
        "utf8",
      ),
      oldBody,
    );
    assert.equal(
      readFileSync(
        path.join(fixture.alpha, "harness/context/new-project.md"),
        "utf8",
      ),
      oldBody,
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("old-only standards fail closed before repository scaffold publication", () => {
  const fixture = setup();
  try {
    mkdirSync(path.join(fixture.alpha, "harness/standards"), {
      recursive: true,
    });
    writeFileSync(
      path.join(fixture.alpha, "harness/standards/README.md"),
      "# Legacy standards\n",
    );
    git(fixture.alpha, "add", "harness/standards");
    git(fixture.alpha, "commit", "--quiet", "-m", "legacy standards");
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok,
      true,
    );
    const before = git(fixture.alpha, "rev-parse", "HEAD"),
      status = git(fixture.alpha, "status", "--porcelain"),
      rejected = runMaybe(fixture.alpha, fixture.userRoot, [
        "init",
        "--repo-id",
        "alpha",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ]);
    assert.notEqual(rejected.status, 0);
    const error = rejected.receipt.error as { code?: string; hint?: string };
    assert.equal(error.code, "standards_migration_required");
    assert.match(error.hint ?? "", /explicit governance task/u);
    assert.equal(git(fixture.alpha, "rev-parse", "HEAD"), before);
    assert.equal(git(fixture.alpha, "status", "--porcelain"), status);
    assert.equal(
      existsSync(path.join(fixture.alpha, "harness/governance")),
      false,
    );
    assert.equal(
      existsSync(path.join(fixture.alpha, "harness/context")),
      false,
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
