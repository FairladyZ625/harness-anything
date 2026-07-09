import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI doc list and map read authored docmap manifest without writing state", () => {
  withTempRoot((rootDir) => {
    writeDocmap(rootDir, {
      schema: "docmap/v1",
      documents: [
        doc("adr-0011", "context/architecture/adr/ADR-0011.md", ["m4-loadbearing"], ["kernel"]),
        doc("testing-standard", "governance/standards/testing-standard.md", [], []),
        { ...doc("old-doc", "context/old.md", ["m4-loadbearing"], []), supersededBy: "adr-0011" }
      ]
    });

    const listed = runJson(rootDir, ["doc", "list", "--module", "m4-loadbearing"]);
    assert.equal(listed.ok, true);
    assert.equal(listed.command, "doc-list");
    assert.equal(listed.rows, 2);
    assert.equal(listed.paths.primary, "harness/docmap.json");
    assert.deepEqual(listed.report.documents.map((entry: { readonly id: string }) => entry.id), ["adr-0011", "old-doc"]);

    const mapped = runJson(rootDir, ["doc", "map", "--module", "m4-loadbearing"]);
    assert.equal(mapped.ok, true);
    assert.equal(mapped.command, "doc-map");
    assert.equal(mapped.rows, 2);
    assert.deepEqual(mapped.report.readSet.mandatory.map((entry: { readonly id: string }) => entry.id), ["adr-0011"]);
    assert.deepEqual(mapped.report.readSet.recommended.map((entry: { readonly id: string }) => entry.id), ["testing-standard"]);
  });
});

test("CLI doc map treats missing manifest as an empty declaration", () => {
  withTempRoot((rootDir) => {
    const mapped = runJson(rootDir, ["doc", "map", "--module", "m4-loadbearing"]);

    assert.equal(mapped.ok, true);
    assert.equal(mapped.command, "doc-map");
    assert.equal(mapped.rows, 0);
    assert.equal(mapped.paths.primary, "harness/docmap.json");
    assert.deepEqual(mapped.report.readSet, { mandatory: [], recommended: [] });
  });
});

test("CLI doc generate derives and persists manifest from authored canonical documents", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(path.join(harnessRoot, "adr"), { recursive: true });
    mkdirSync(path.join(harnessRoot, "milestones", "foundation", "m5-circulation"), { recursive: true });
    writeFileSync(path.join(harnessRoot, "AGENTS.md"), "# Harness Agents\n");
    writeFileSync(path.join(harnessRoot, "adr", "ADR-0008-generic-entity-framework-and-substrate.md"), "# ADR 0008\n");
    writeFileSync(path.join(harnessRoot, "milestones", "foundation", "m5-circulation", "01-feature-breakdown.md"), "# M5 Circulation Features\n");
    initHarnessGit(harnessRoot);

    const generated = runJson(rootDir, ["doc", "generate", "--module", "m5-circulation", "--write"]);

    assert.equal(generated.ok, true);
    assert.equal(generated.command, "doc-generate");
    assert.equal(generated.paths.primary, "harness/docmap.json");
    assert.equal(generated.report.git.committed, true);
    assert.equal(existsSync(path.join(harnessRoot, "docmap.json")), true);
    assert.equal(gitStatus(harnessRoot), "");
    assert.equal(generated.report.documents[0].id, "milestone:foundation:m5-circulation:01-feature-breakdown");
    assert.match(generated.report.documents[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual(
      generated.report.documents.map((entry: { readonly path: string }) => entry.path),
      ["milestones/foundation/m5-circulation/01-feature-breakdown.md"]
    );

    const mapped = runJson(rootDir, ["doc", "map", "--module", "m5-circulation"]);
    assert.equal(mapped.ok, true);
    assert.equal(mapped.report.readSet.mandatory[0].path, "milestones/foundation/m5-circulation/01-feature-breakdown.md");
    assert.ok(mapped.report.readSet.recommended.some((entry: { readonly path: string }) => entry.path === "AGENTS.md"));
  });
});

test("CLI doc generate fails closed on duplicate derived docmap ids", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(path.join(harnessRoot, "adr"), { recursive: true });
    writeFileSync(path.join(harnessRoot, "adr", "ADR-0001-one.md"), [
      "---",
      "docmap.id: duplicate-doc",
      "---",
      "# ADR One",
      ""
    ].join("\n"));
    writeFileSync(path.join(harnessRoot, "adr", "ADR-0002-two.md"), [
      "---",
      "docmap.id: duplicate-doc",
      "---",
      "# ADR Two",
      ""
    ].join("\n"));

    const failure = runJson(rootDir, ["doc", "generate"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "docmap_invalid");
    assert.match(failure.error?.hint ?? "", /duplicate document ids/u);
  });
});

test("CLI doc status reports prose candidates and forbidden structured touches", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskRoot = path.join(harnessRoot, "tasks", "task_01KX3W4V1EDPHPTGWYYBQQ2J75");
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "task_plan.md"), "# Plan\n\nOriginal prose.\n");
    writeFileSync(path.join(taskRoot, "facts.md"), "# Facts\n\n- fact: original\n");
    initHarnessGit(harnessRoot);

    writeFileSync(path.join(taskRoot, "task_plan.md"), "# Plan\n\nUpdated prose.\n");
    writeFileSync(path.join(taskRoot, "facts.md"), "# Facts\n\n- fact: structured mutation\n");

    const status = runJson(rootDir, ["doc", "status"]);
    assert.equal(status.ok, true);
    assert.equal(status.command, "doc-status");
    assert.equal(status.report.candidateBlobs.length, 1);
    assert.equal(status.report.candidateBlobs[0].path, "tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/task_plan.md");
    assert.equal(status.report.forbiddenTouches.some((touch: Record<string, any>) => touch.hunks[0].registryRowId === "fact.record"), true);

    const dryRun = runJson(rootDir, ["doc", "sync", "--dry-run"]);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.command, "doc-sync-dry-run");
    assert.equal(dryRun.report.writeIntentPreview.submitImplemented, true);
    assert.equal(dryRun.report.writeIntentPreview.changes.length, 1);
  });
});

test("CLI doc status marks deletion as an explicit Phase 2 gap", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskRoot = path.join(harnessRoot, "tasks", "task_01KX3W4V1EDPHPTGWYYBQQ2J75");
    mkdirSync(taskRoot, { recursive: true });
    const planPath = path.join(taskRoot, "task_plan.md");
    writeFileSync(planPath, "# Plan\n\nOriginal prose.\n");
    initHarnessGit(harnessRoot);
    rmSync(planPath);

    const status = runJson(rootDir, ["doc", "status"]);
    assert.equal(status.report.deletionPolicy, "undefined-pending-phase-2");
    assert.equal(status.report.deletions.length, 1);
    assert.equal(status.report.readyToSubmitPreview, false);
  });
});

test("CLI new-task writes docmap read_set.md from derived declarations", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(path.join(harnessRoot, "milestones", "foundation", "m5-circulation"), { recursive: true });
    writeFileSync(path.join(harnessRoot, "AGENTS.md"), "# Harness Agents\n");
    writeFileSync(path.join(harnessRoot, "milestones", "foundation", "m5-circulation", "01-feature-breakdown.md"), "# M5 Circulation Features\n");

    const created = runJson(rootDir, [
      "new-task",
      "--title", "Docmap Task",
      "--register-module", "m5-circulation",
      "--module-title", "M5 Circulation",
      "--module-scope", "packages/**"
    ]);
    const readSetPath = path.join(rootDir, created.packagePath, "read_set.md");

    assert.equal(created.ok, true);
    assert.equal(created.generated.includes("read_set.md"), true);
    assert.equal(created.report.docmap.source, "derived");
    assert.match(readFileSync(readSetPath, "utf8"), /milestones\/foundation\/m5-circulation\/01-feature-breakdown\.md/u);
  });
});

test("CLI doc list fails closed on invalid manifest", () => {
  withTempRoot((rootDir) => {
    writeDocmap(rootDir, {
      schema: "docmap/v1",
      documents: [
        doc("bad", "../outside.md", ["m4-loadbearing"], [])
      ]
    });

    const failure = runJson(rootDir, ["doc", "list"], false);
    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "docmap_invalid");
  });
});

function doc(id: string, docPath: string, modules: string[], productLines: string[]) {
  return {
    id,
    path: docPath,
    kind: "adr",
    scope: { modules, productLines },
    updatedAt: "2026-07-07T00:00:00.000Z"
  };
}

function writeDocmap(rootDir: string, value: unknown): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(path.join(harnessRoot, "docmap.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-docmap-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function initHarnessGit(harnessRoot: string): void {
  execFileSync("git", ["-C", harnessRoot, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "add", "--", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed"], { stdio: "ignore" });
}

function gitStatus(harnessRoot: string): string {
  return execFileSync("git", ["-C", harnessRoot, "status", "--short"], { encoding: "utf8" }).trim();
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_ACTOR: "agent:docmap-cli-test", GIT_CONFIG_GLOBAL: "/dev/null" }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
